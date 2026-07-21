#!/usr/bin/env python3
"""Phase 2 live pipeline: current conditions for every facility, every 3 hours.

Reads the facility master (`static/data/facilities.json`) and, per facility:
  - the CURRENT temperature from the latest NOAA RTMA 2.5km analysis on keyless AWS
    Open Data (`noaa-rtma-pds`, ~1h fresh) — one ranged GRIB download per run, sampled
    at every facility cell (see load_rtma_current / RTMASampler);
  - RTMA/URMA hourly temperature for the last 14 days via Google Earth Engine
    (headless in CI via Workload Identity Federation — see validate_ee_headless.py),
    reduced to a per-PT-day tmax series — this is the settled HISTORY; GEE's own
    ~24h re-ingestion lag is why the current reading comes from AWS instead;
  - today's forecast high from NWS NDFD (keyless api.weather.gov);
  - AQI from AirNow (deduped by a coarse lat/lon cell to stay well under rate limits;
    degrades to null when AIRNOW_API_KEY is absent, e.g. local runs);
  - status / °F-over / streak against the facility's `threshold_f` — read as a plain
    field, no rule logic here (the threshold is defined upstream in build_baselines and
    may change; this script just consumes whatever value the master carries).

Writes `static/data/statewide.json` (one row per facility) and
`static/data/recent/{slug}.json` (14-day hourly trace + daily maxima). On a per-facility
failure it keeps that facility's last-good files and stamps `stale: true`, so one bad
source or point query never blanks the map.

    python3 pipeline/fetch_current.py                 # all facilities
    python3 pipeline/fetch_current.py --limit 5       # first 5 (local smoke test)
    python3 pipeline/fetch_current.py --slugs a,b,c   # specific facilities

Auth: interactive `earthengine authenticate` creds locally; federated ADC in CI.
"""
import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import ee

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MASTER = REPO / "static/data/facilities.json"
STATEWIDE = REPO / "static/data/statewide.json"
RECENT_DIR = REPO / "static/data/recent"

RTMA = "NOAA/NWS/RTMA"
TZ = ZoneInfo("America/Los_Angeles")
RECENT_DAYS = 14
UA = "ca-carceral-heat-tracker (m.becica@gmail.com)"
EE_SCOPES = ["https://www.googleapis.com/auth/earthengine",
             "https://www.googleapis.com/auth/cloud-platform"]
AIRNOW_KEY = os.environ.get("AIRNOW_API_KEY")

# --- AWS RTMA (near-real-time current temperature) --------------------------
# The GEE RTMA collection re-ingests ~a day late, so the "current" reading it
# gives is ~24h stale. NOAA publishes the same RTMA 2.5km analysis to keyless
# AWS Open Data within ~1h, so we source the CURRENT temp straight from there
# and keep GEE only for the settled 14-day history. Anonymous plain HTTPS —
# no AWS SDK/creds needed. Object key per hourly analysis cycle:
#   rtma2p5.YYYYMMDD/rtma2p5.tHHz.2dvaranl_ndfd.grb2_wexp   (+ .idx sidecar)
RTMA_S3 = "https://noaa-rtma-pds.s3.amazonaws.com"
RTMA_LOOKBACK_H = 6          # walk back this many hourly cycles on a missing/unpublished one
CA_BBOX = (32.0, 42.2, -124.6, -114.0)   # lat_min, lat_max, lon_min, lon_max — grid subset


# --- auth -------------------------------------------------------------------

def init_ee():
    """Initialize Earth Engine, federated (CI) or interactive (local). Mirrors the
    pattern proven by validate_ee_headless.py; see that file for the WIF rationale."""
    project = os.environ.get("EE_PROJECT", "ca-carceral-heat")
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        import google.auth
        creds, _ = google.auth.default(scopes=EE_SCOPES)
        ee.Initialize(creds, project=project)
        print(f"✓ EE via federated ADC (project={project})", flush=True)
    else:
        ee.Initialize(project=project)
        print(f"✓ EE via interactive creds (project={project})", flush=True)


# --- data sources -----------------------------------------------------------

def rtma_hourly(lat, lon):
    """Return the last RECENT_DAYS of hourly RTMA 2 m temperature at the point as a
    sorted list of (utc_datetime, °F). One getRegion; empties raise so the caller can
    keep last-good data."""
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    start_ms = now_ms - RECENT_DAYS * 86400 * 1000
    col = (ee.ImageCollection(RTMA).select("TMP")
           .filterDate(ee.Date(start_ms), ee.Date(now_ms + 3600 * 1000)))
    if col.size().getInfo() == 0:
        raise RuntimeError("RTMA collection empty over recent window")
    rows = col.getRegion(ee.Geometry.Point(lon, lat), 2500).getInfo()
    out = []
    for r in rows[1:]:
        t_ms, tmp_c = r[3], r[4]
        if tmp_c is None:
            continue
        out.append((datetime.fromtimestamp(t_ms / 1000, timezone.utc), round(tmp_c * 9 / 5 + 32, 1)))
    out.sort(key=lambda x: x[0])
    if not out:
        raise RuntimeError("RTMA returned no non-null temperatures")
    return out


def daily_max_series(hourly):
    """Collapse [(utc_dt, °F)] into per-PT-calendar-day maxima, oldest→newest:
    [{"date": "YYYY-MM-DD", "max_f": float}]."""
    by_day = {}
    for dt_utc, f in hourly:
        d = dt_utc.astimezone(TZ).date().isoformat()
        if d not in by_day or f > by_day[d]:
            by_day[d] = f
    return [{"date": d, "max_f": by_day[d]} for d in sorted(by_day)]


def _http_get(url, byte_range=None, timeout=60):
    headers = {"User-Agent": UA}
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _rtma_tmp_byte_range(idx_text):
    """From an RTMA `.idx` sidecar, return (start, end) byte offsets of the
    'TMP:2 m above ground' record (end = next record's start - 1, so a ranged
    GET pulls that one ~6 MB message out of the ~84 MB file). None if absent."""
    lines = [ln for ln in idx_text.splitlines() if ln.strip()]
    for i, ln in enumerate(lines):
        p = ln.split(":")   # num:startbyte:date:var:level:...
        if len(p) >= 5 and p[3] == "TMP" and p[4] == "2 m above ground":
            start = int(p[1])
            end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else ""
            return start, end
    return None


class RTMASampler:
    """Latest RTMA 2.5km analysis 2 m temperature, sampled at arbitrary CA points.
    One ranged GRIB download per run (the TMP record only), read via cfgrib, with a
    CA-bbox nearest-cell index reused for every facility. Built by load_rtma_current()."""

    def __init__(self, valid_time, cycle_key, slat, slon, st_f):
        self.valid_time = valid_time   # UTC datetime of the analysis (== cycle hour)
        self.cycle_key = cycle_key     # S3 key used, for provenance/logging
        self._slat = slat              # CA-subset 2D latitude
        self._slon = slon              # CA-subset 2D longitude (-180..180)
        self._st_f = st_f              # CA-subset temps, °F (NaN where masked/ocean)

    @property
    def as_of(self):
        return self.valid_time.strftime("%Y-%m-%dT%H:00Z")

    def sample(self, lat, lon):
        """Nearest-cell °F at (lat, lon); None if that cell is masked or the point is
        off-grid (nearest cell implausibly far). Equirectangular argmin — the grid is
        Lambert-conformal but at CA scale nearest-neighbor on lat/lon is exact to cell."""
        import numpy as np
        d2 = (self._slat - lat) ** 2 + ((self._slon - lon) * np.cos(np.radians(lat))) ** 2
        iy, ix = np.unravel_index(int(np.argmin(d2)), d2.shape)
        if float(d2[iy, ix]) ** 0.5 > 0.1:     # ~11 km — well past one 2.5 km cell → off-grid
            return None
        f = float(self._st_f[iy, ix])
        return None if f != f else round(f, 1)  # f != f catches NaN


def load_rtma_current(lookback_h=RTMA_LOOKBACK_H):
    """Download the latest published RTMA 2.5km 2dvaranl TMP record from keyless AWS
    (walking back hourly on a not-yet-published cycle) and return an RTMASampler, or
    None if unavailable / GRIB deps missing — the caller then falls back to GEE's last
    hour so a bad AWS run never blanks the current temp, only makes it staler."""
    try:
        import cfgrib
        import numpy as np
    except ImportError as e:
        print(f"! RTMA deps missing ({e.name}); current temp falls back to GEE", flush=True)
        return None

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for h in range(lookback_h + 1):
        cyc = now - timedelta(hours=h)
        key = f"rtma2p5.{cyc:%Y%m%d}/rtma2p5.t{cyc:%H}z.2dvaranl_ndfd.grb2_wexp"
        url = f"{RTMA_S3}/{key}"
        try:
            idx = _http_get(url + ".idx", timeout=30).decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError):
            continue                         # cycle not published yet → try the prior hour
        rng = _rtma_tmp_byte_range(idx)
        if not rng:
            continue
        try:
            grib = _http_get(url, byte_range=rng, timeout=90)
        except (urllib.error.URLError, TimeoutError):
            continue
        with tempfile.NamedTemporaryFile(suffix=".grb2", delete=False) as tf:
            tf.write(grib)
            path = tf.name
        try:
            # indexpath="" disables cfgrib's on-disk .idx cache (avoids leftover files /
            # read-only-dir errors); we open one message and read it once.
            ds = cfgrib.open_dataset(path, backend_kwargs={"indexpath": ""})
            lat = ds["latitude"].values
            lon = ds["longitude"].values
            lon = np.where(lon > 180, lon - 360, lon)     # 0..360 → -180..180
            t_f = ds["t2m"].values * 9 / 5 - 459.67       # K → °F
        finally:
            os.unlink(path)
        lat0, lat1, lon0, lon1 = CA_BBOX
        m = (lat >= lat0) & (lat <= lat1) & (lon >= lon0) & (lon <= lon1)
        ys, xs = np.where(m)
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        return RTMASampler(cyc, key,
                           lat[y0:y1 + 1, x0:x1 + 1],
                           lon[y0:y1 + 1, x0:x1 + 1],
                           t_f[y0:y1 + 1, x0:x1 + 1])
    print(f"! No RTMA 2dvaranl cycle found in the last {lookback_h}h; "
          "current temp falls back to GEE", flush=True)
    return None


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def ndfd_high_today(lat, lon):
    """Today's NDFD daytime forecast high (°F) via keyless api.weather.gov, or None.
    Two calls (points → forecast); NWS serves °F directly."""
    for attempt in range(3):
        try:
            pts = _get_json(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
            fc = _get_json(pts["properties"]["forecast"])
            for p in fc["properties"]["periods"]:
                if p.get("isDaytime"):
                    return float(p["temperature"])
            return None
        except (urllib.error.URLError, KeyError, ValueError):
            if attempt == 2:
                return None
            time.sleep(2 * (attempt + 1))


def airnow_aqi(lat, lon, cache):
    """Current AQI + category at the point via AirNow, deduped through `cache` keyed
    by a ~0.2° lat/lon cell (a cheap proxy for AirNow's reporting areas). Returns
    (aqi:int|None, category:str|None). No key (local) → (None, None), no error."""
    if not AIRNOW_KEY:
        return None, None
    key = (round(lat * 5) / 5, round(lon * 5) / 5)
    if key in cache:
        return cache[key]
    url = ("https://www.airnowapi.org/aq/observation/latLong/current/"
           f"?format=application/json&latitude={lat:.4f}&longitude={lon:.4f}"
           f"&distance=50&API_KEY={AIRNOW_KEY}")
    result = (None, None)
    try:
        obs = _get_json(url)
        best = None
        for o in obs:  # prefer the highest AQI across reported parameters (PM2.5/O3/…)
            aqi = o.get("AQI")
            if aqi is not None and (best is None or aqi > best[0]):
                best = (int(aqi), o.get("Category", {}).get("Name"))
        if best:
            result = best
    except (urllib.error.URLError, ValueError):
        pass
    cache[key] = result
    return result


# --- per-facility assembly --------------------------------------------------

def build_facility(fac, aqi_cache, rtma):
    """Fetch all sources for one facility and return (statewide_row, recent_doc, cur_src).
    Raises on GEE-history failure so the caller can keep last-good data. `cur_src` is
    "aws" or "gee" — which source supplied current_temp_f (for run-level logging).

    Output is RAW observations only — no threshold logic. status / °F-over / streak /
    counts are computed client-side from these values against the thresholds in
    facilities.json, so the threshold can change (or be multiple, or user-selected)
    without re-running this fetch. daily_max carries no `over` flag for the same reason."""
    lat, lon = fac["lat"], fac["lon"]
    hourly = rtma_hourly(lat, lon)                      # GEE 14-day history; raises on empty
    daily = daily_max_series(hourly)                    # [{date, max_f}], oldest→newest
    # Current temp: prefer the near-real-time AWS RTMA analysis (~1h old); fall back to
    # GEE's last hour (~24h old) only if AWS is down or the cell is masked, so the
    # headline is never blank. The detail page's live NWS top-up (§5) can still refine it.
    current_temp_f, cur_src = (rtma.sample(lat, lon) if rtma else None), "aws"
    if current_temp_f is not None:
        current_temp_as_of = rtma.as_of
    else:
        current_temp_f = hourly[-1][1]
        current_temp_as_of = hourly[-1][0].strftime("%Y-%m-%dT%H:00Z")
        cur_src = "gee"
    today_forecast_high_f = ndfd_high_today(lat, lon)   # NDFD; may be None
    aqi, aqi_cat = airnow_aqi(lat, lon, aqi_cache)

    row = {
        "slug": fac["slug"], "name": fac["name"], "county": fac["county"],
        "jurisdiction": fac["jurisdiction"], "lat": lat, "lon": lon,
        "today_forecast_high_f": today_forecast_high_f,
        "current_temp_f": current_temp_f, "current_temp_as_of": current_temp_as_of,
        "recent_daily_max_f": daily,   # raw series so the map/table can derive status+streak
        "aqi": aqi, "aqi_category": aqi_cat, "stale": False,
    }
    recent = {
        "slug": fac["slug"], "name": fac["name"], "tz": "America/Los_Angeles",
        "unit": "°F", "generated_at": _now_iso(),
        "current_temp_f": current_temp_f, "current_temp_as_of": current_temp_as_of,
        "today_forecast_high_f": today_forecast_high_f,
        "hourly": [{"t": dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00Z"), "f": f}
                   for dt, f in hourly],
        "daily_max": daily,
    }
    return row, recent, cur_src


# --- orchestration ----------------------------------------------------------

def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_facilities(limit, slugs):
    master = json.loads(MASTER.read_text())
    facs = master["facilities"]
    if slugs:
        want = set(slugs.split(","))
        facs = [f for f in facs if f["slug"] in want]
    if limit:
        facs = facs[:limit]
    return facs


def main():
    ap = argparse.ArgumentParser(description="Fetch current conditions per facility")
    ap.add_argument("--limit", type=int, help="only the first N facilities (local test)")
    ap.add_argument("--slugs", help="comma-separated slugs to fetch (local test)")
    args = ap.parse_args()

    init_ee()
    facs = load_facilities(args.limit, args.slugs)
    print(f"{len(facs)} facilities; AirNow {'ON' if AIRNOW_KEY else 'OFF (no key)'}", flush=True)

    # Near-real-time current temp source (one ranged GRIB download, shared by all
    # facilities); None → each facility falls back to GEE's last hour for current temp.
    rtma = load_rtma_current()
    if rtma is not None:
        age_h = (datetime.now(timezone.utc) - rtma.valid_time).total_seconds() / 3600
        print(f"✓ RTMA current via AWS: {rtma.cycle_key} "
              f"(valid {rtma.as_of}, ~{age_h:.1f}h old)", flush=True)

    # Last-good carry-forward: index the previous statewide rows by slug.
    prev = {}
    if STATEWIDE.exists():
        prev = {r["slug"]: r for r in json.loads(STATEWIDE.read_text()).get("facilities", [])}

    RECENT_DIR.mkdir(parents=True, exist_ok=True)
    aqi_cache, rows, ok, stale, over_log = {}, [], 0, 0, 0
    cur_aws, cur_gee = 0, 0
    for i, fac in enumerate(facs, 1):
        t0 = time.time()
        try:
            row, recent, cur_src = build_facility(fac, aqi_cache, rtma)
            (RECENT_DIR / f"{fac['slug']}.json").write_text(
                json.dumps(recent, ensure_ascii=False, separators=(",", ":")))
            rows.append(row)
            ok += 1
            cur_aws += cur_src == "aws"
            cur_gee += cur_src == "gee"
            # Log-only over-check against the master's default threshold — for monitoring;
            # NOT written to the JSON (threshold interpretation is client-side).
            hi = row["today_forecast_high_f"]
            over = hi is not None and hi >= fac["threshold_f"]
            over_log += over
            print(f"  [{i}/{len(facs)}] {fac['slug']}: high={hi} "
                  f"(thr {fac['threshold_f']}, {'OVER' if over else 'under'}) "
                  f"aqi={row['aqi']} {time.time()-t0:.1f}s", flush=True)
        except Exception as e:
            old = prev.get(fac["slug"])
            if old:
                rows.append({**old, "stale": True})
            else:
                rows.append({"slug": fac["slug"], "name": fac["name"], "county": fac["county"],
                             "jurisdiction": fac["jurisdiction"], "lat": fac["lat"], "lon": fac["lon"],
                             "today_forecast_high_f": None, "current_temp_f": None,
                             "current_temp_as_of": None, "recent_daily_max_f": [],
                             "aqi": None, "aqi_category": None, "stale": True})
            stale += 1
            print(f"  [{i}/{len(facs)}] {fac['slug']}: STALE ({type(e).__name__}: {e})", flush=True)

    out = {
        "meta": {
            "generated_at": _now_iso(),
            "recent_days": RECENT_DAYS,
            "sources": {
                "current_temp": ("NOAA RTMA 2.5km 2dvaranl via AWS (noaa-rtma-pds)"
                                 if rtma is not None else "NOAA RTMA/URMA via GEE (AWS unavailable)"),
                "recent_history": "NOAA RTMA/URMA via GEE",
                "forecast_high": "NWS NDFD",
                "aqi": "AirNow" if AIRNOW_KEY else None,
            },
            "current_temp_valid": rtma.as_of if rtma is not None else None,
            "current_temp_aws": cur_aws, "current_temp_gee_fallback": cur_gee,
            "n_ok": ok, "n_stale": stale, "n": len(rows),
            "note": ("Raw observations/forecasts only. status, °F-over, streaks and counts "
                     "are computed client-side against thresholds in facilities.json, so "
                     "thresholds can change without re-fetching."),
        },
        "facilities": rows,
    }
    STATEWIDE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"\nWrote {STATEWIDE.relative_to(REPO)} — {ok} ok / {stale} stale; "
          f"current temp {cur_aws} AWS / {cur_gee} GEE-fallback; "
          f"{over_log} over default threshold (log only)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
