#!/usr/bin/env python3
"""Phase 2 live pipeline: current conditions for every facility, every 3 hours.

Reads the facility master (`static/data/facilities.json`) and, per facility:
  - the CURRENT temperature AND the recent ~36h hourly tail from NOAA RTMA 2.5km
    analyses on keyless AWS Open Data (`noaa-rtma-pds`, ~1h fresh) — one ranged GRIB
    download per hour, each sampled at every facility cell (see load_rtma_recent);
  - RTMA/URMA hourly temperature for the last 14 days via Google Earth Engine
    (headless in CI via Workload Identity Federation — see validate_ee_headless.py),
    reduced to a per-PT-day tmax series — this is the settled HISTORY; GEE's own
    ~24-30h re-ingestion lag is why the current reading + recent tail come from AWS,
    merged on top of the GEE series (AWS wins on overlapping hours);
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

# --- AWS RTMA (near-real-time current temp + recent hourly tail) ------------
# The GEE RTMA collection re-ingests ~a day late (observed ~24-30h), so BOTH the
# "current" reading AND the tail of the 14-day chart/daily-maxima it gives are
# stale — today is missing entirely. NOAA publishes the same RTMA 2.5km analysis
# to keyless AWS Open Data within ~1h, so we pull the last ~36 hourly cycles from
# there to (a) supply the current temp (newest hour) and (b) fill the chart's gap
# up to now; GEE still owns the settled older history. Anonymous plain HTTPS — no
# AWS SDK/creds. Object key per hourly analysis cycle:
#   rtma2p5.YYYYMMDD/rtma2p5.tHHz.2dvaranl_ndfd.grb2_wexp   (+ .idx sidecar)
RTMA_S3 = "https://noaa-rtma-pds.s3.amazonaws.com"
RTMA_RECENT_H = 36           # hourly cycles to pull; MUST exceed the GEE ingest lag (~24-30h obs.)
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


def _fetch_cycle_grib(cyc, np, cfgrib):
    """Download + read ONE RTMA 2dvaranl cycle's 2 m temperature. Returns
    (lat, lon, t_f) full-grid arrays (°F; lon wrapped to -180..180), or None if
    that exact hour isn't published yet or carries no TMP record. Ranged GET pulls
    only the ~6 MB TMP message out of the ~84 MB file."""
    key = f"rtma2p5.{cyc:%Y%m%d}/rtma2p5.t{cyc:%H}z.2dvaranl_ndfd.grb2_wexp"
    url = f"{RTMA_S3}/{key}"
    try:
        idx = _http_get(url + ".idx", timeout=30).decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError):
        return None                          # cycle not published yet
    rng = _rtma_tmp_byte_range(idx)
    if not rng:
        return None
    try:
        grib = _http_get(url, byte_range=rng, timeout=90)
    except (urllib.error.URLError, TimeoutError):
        return None
    with tempfile.NamedTemporaryFile(suffix=".grb2", delete=False) as tf:
        tf.write(grib)
        path = tf.name
    try:
        # indexpath="" disables cfgrib's on-disk .idx cache (avoids leftover files /
        # read-only-dir errors); we open one message and read it once.
        ds = cfgrib.open_dataset(path, backend_kwargs={"indexpath": ""})
        lat = ds["latitude"].values
        lon = np.where(ds["longitude"].values > 180,
                       ds["longitude"].values - 360, ds["longitude"].values)
        t_f = ds["t2m"].values * 9 / 5 - 459.67           # K → °F
    finally:
        os.unlink(path)
    return lat, lon, t_f


class RtmaRecent:
    """The last N hourly RTMA 2.5km analyses sampled at every facility cell. Serves
    BOTH the near-real-time current temp (newest hour) and the recent hourly tail
    that fills GEE's ~24-30h ingest gap on the chart + daily maxima. Built by
    load_rtma_recent(): one ranged GRIB download per hour, shared across all
    facilities via a nearest-cell index computed once."""

    def __init__(self, newest, cycles, tails):
        self.newest = newest    # UTC datetime of the freshest cycle (== current-temp hour)
        self.cycles = cycles    # count of hours actually fetched (for logging/meta)
        self.tails = tails      # slug -> sorted [(utc_dt, °F)]

    @property
    def as_of(self):
        return self.newest.strftime("%Y-%m-%dT%H:00Z") if self.newest else None


def load_rtma_recent(facs, hours=RTMA_RECENT_H):
    """Pull the last `hours` RTMA 2.5km 2dvaranl cycles from keyless AWS and sample
    each at every facility, returning an RtmaRecent (or None if GRIB deps are missing
    or no cycle is reachable — caller then falls back to GEE-only, i.e. the pre-AWS
    behavior). Missing/unpublished individual hours are skipped, not fatal."""
    try:
        import cfgrib
        import numpy as np
    except ImportError as e:
        print(f"! RTMA deps missing ({e.name}); current temp + recent tail fall back to GEE",
              flush=True)
        return None

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    tails = {f["slug"]: [] for f in facs}
    fac_idx = None      # slug -> (iy, ix) into the CA subset; (None, None) = off-grid
    sub = None          # (y0, y1, x0, x1) subset bounds (grid is identical across hours)
    newest, got = None, 0
    for h in range(hours):                   # newest → oldest
        grid = _fetch_cycle_grib(now - timedelta(hours=h), np, cfgrib)
        if grid is None:
            continue                         # this hour missing → neighbors still cover the gap
        cyc = now - timedelta(hours=h)
        lat, lon, t_f = grid
        if fac_idx is None:                  # first hit defines the shared grid geometry
            lat0, lat1, lon0, lon1 = CA_BBOX
            m = (lat >= lat0) & (lat <= lat1) & (lon >= lon0) & (lon <= lon1)
            ys, xs = np.where(m)
            y0, y1, x0, x1 = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
            sub = (y0, y1, x0, x1)
            slat, slon = lat[y0:y1 + 1, x0:x1 + 1], lon[y0:y1 + 1, x0:x1 + 1]
            fac_idx = {}
            for f in facs:
                d2 = ((slat - f["lat"]) ** 2
                      + ((slon - f["lon"]) * np.cos(np.radians(f["lat"]))) ** 2)
                iy, ix = np.unravel_index(int(np.argmin(d2)), d2.shape)
                fac_idx[f["slug"]] = ((iy, ix) if float(d2[iy, ix]) ** 0.5 <= 0.1
                                      else (None, None))   # >~11 km ⇒ off-grid
        y0, y1, x0, x1 = sub
        st = t_f[y0:y1 + 1, x0:x1 + 1]
        for f in facs:
            iy, ix = fac_idx[f["slug"]]
            if iy is None:
                continue
            v = float(st[iy, ix])
            if v == v:                       # not NaN (masked/ocean)
                tails[f["slug"]].append((cyc, round(v, 1)))
        newest = newest or cyc
        got += 1
    if got == 0:
        print(f"! No RTMA 2dvaranl cycle found in the last {hours}h; "
              "current temp + recent tail fall back to GEE", flush=True)
        return None
    for s in tails:
        tails[s].sort(key=lambda x: x[0])
    return RtmaRecent(newest, got, tails)


def _merge_hourly(gee, aws):
    """Merge GEE settled history with the fresher AWS recent tail into one sorted
    [(utc_dt, °F)] series, keyed by hour; AWS wins on overlapping hours."""
    by_hour = {}
    for dt, f in gee:
        by_hour[dt.replace(minute=0, second=0, microsecond=0)] = f
    for dt, f in aws:
        by_hour[dt.replace(minute=0, second=0, microsecond=0)] = f
    return sorted(by_hour.items())


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


def _airnow_time(o):
    """AirNow observation local time as a short display string, e.g. 'Jul 21, 2 PM PDT'.
    AirNow reports local DateObserved + HourObserved + a tz abbreviation (no offset),
    so we pre-format for display rather than emit an ambiguous machine timestamp."""
    d = (o.get("DateObserved") or "").strip()
    h = o.get("HourObserved")
    tz = (o.get("LocalTimeZone") or "").strip()
    if not d or h is None:
        return None
    try:
        dt = datetime.strptime(d, "%Y-%m-%d")
    except ValueError:
        return None
    h = int(h)
    s = dt.strftime("%b ") + str(dt.day) + f", {(h % 12) or 12} {'AM' if h < 12 else 'PM'}"
    return s + (" " + tz if tz else "")


def airnow_aqi(lat, lon, cache):
    """Current AQI + category + observation time at the point via AirNow, deduped through
    `cache` keyed by a ~0.2° lat/lon cell (a cheap proxy for AirNow's reporting areas).
    Returns (aqi:int|None, category:str|None, observed:str|None). No key → all None."""
    if not AIRNOW_KEY:
        return None, None, None
    key = (round(lat * 5) / 5, round(lon * 5) / 5)
    if key in cache:
        return cache[key]
    url = ("https://www.airnowapi.org/aq/observation/latLong/current/"
           f"?format=application/json&latitude={lat:.4f}&longitude={lon:.4f}"
           f"&distance=50&API_KEY={AIRNOW_KEY}")
    result = (None, None, None)
    try:
        obs = _get_json(url)
        best = None
        for o in obs:  # prefer the highest AQI across reported parameters (PM2.5/O3/…)
            aqi = o.get("AQI")
            if aqi is not None and (best is None or aqi > best[0]):
                best = (int(aqi), o.get("Category", {}).get("Name"), _airnow_time(o))
        if best:
            result = best
    except (urllib.error.URLError, ValueError):
        pass
    cache[key] = result
    return result


# --- per-facility assembly --------------------------------------------------

def build_facility(fac, aqi_cache, recent):
    """Fetch all sources for one facility and return (statewide_row, recent_doc, cur_src).
    Raises on GEE-history failure so the caller can keep last-good data. `cur_src` is
    "aws" or "gee" — which source supplied current_temp_f (for run-level logging).

    Output is RAW observations only — no threshold logic. status / °F-over / streak /
    counts are computed client-side from these values against the thresholds in
    facilities.json, so the threshold can change (or be multiple, or user-selected)
    without re-running this fetch. daily_max carries no `over` flag for the same reason."""
    lat, lon = fac["lat"], fac["lon"]
    gee_hourly = rtma_hourly(lat, lon)                  # GEE settled history; raises on empty
    # The AWS recent tail (~last 36h) fills GEE's ~24-30h ingest gap so the chart and the
    # per-day maxima (and thus today's over-average status) reach up to ~now, not yesterday.
    tail = recent.tails.get(fac["slug"], []) if recent else []
    hourly = _merge_hourly(gee_hourly, tail)            # AWS wins on overlap
    daily = daily_max_series(hourly)                    # [{date, max_f}], now including today
    # Trailing-24h peak ending at the latest observation — the client uses THIS (not the
    # latest daily bucket, which is partial and under-reports) to decide over-average
    # status, so the map rings / alert / heat filter are time-of-day independent. Also
    # stamp WHEN the peak occurred, for the tooltips/detail "24 Hour Max" timestamp.
    win_start = hourly[-1][0] - timedelta(hours=24)
    win = [(t, f) for t, f in hourly if t >= win_start]
    if win:
        peak_t, last24h_max_f = max(win, key=lambda tf: tf[1])
        last24h_max_at = peak_t.strftime("%Y-%m-%dT%H:00Z")
    else:
        last24h_max_f, last24h_max_at = None, None
    # Current temp: the newest AWS hour (~1h old); fall back to GEE's last hour (~24-30h)
    # only if AWS is down or this cell is masked, so the headline is never blank. The
    # detail page's live NWS top-up (§5) can still refine it client-side.
    if tail:
        current_temp_f = tail[-1][1]
        current_temp_as_of = tail[-1][0].strftime("%Y-%m-%dT%H:00Z")
        cur_src = "aws"
    else:
        current_temp_f = hourly[-1][1]
        current_temp_as_of = hourly[-1][0].strftime("%Y-%m-%dT%H:00Z")
        cur_src = "gee"
    today_forecast_high_f = ndfd_high_today(lat, lon)   # NDFD; may be None
    aqi, aqi_cat, aqi_as_of = airnow_aqi(lat, lon, aqi_cache)

    row = {
        "slug": fac["slug"], "name": fac["name"], "county": fac["county"],
        "jurisdiction": fac["jurisdiction"], "lat": lat, "lon": lon,
        "today_forecast_high_f": today_forecast_high_f,
        "current_temp_f": current_temp_f, "current_temp_as_of": current_temp_as_of,
        "recent_daily_max_f": daily,   # raw series so the map/table can derive status+streak
        "last24h_max_f": last24h_max_f,  # raw trailing-24h peak; client compares to threshold
        "last24h_max_at": last24h_max_at,  # when that peak occurred (tooltip/detail timestamp)
        "aqi": aqi, "aqi_category": aqi_cat, "aqi_as_of": aqi_as_of, "stale": False,
    }
    recent = {
        "slug": fac["slug"], "name": fac["name"], "tz": "America/Los_Angeles",
        "unit": "°F", "generated_at": _now_iso(),
        "current_temp_f": current_temp_f, "current_temp_as_of": current_temp_as_of,
        "today_forecast_high_f": today_forecast_high_f,
        "last24h_max_f": last24h_max_f, "last24h_max_at": last24h_max_at,
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

    # Near-real-time AWS RTMA: last ~36 hourly cycles sampled at every facility, shared
    # across the loop below — supplies the current temp AND fills GEE's ingest gap on the
    # chart/daily maxima. None → each facility falls back to GEE-only (pre-AWS behavior).
    recent = load_rtma_recent(facs)
    if recent is not None:
        age_h = (datetime.now(timezone.utc) - recent.newest).total_seconds() / 3600
        print(f"✓ RTMA via AWS: {recent.cycles} hourly cycles, newest valid "
              f"{recent.as_of} (~{age_h:.1f}h old)", flush=True)

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
            row, recent_doc, cur_src = build_facility(fac, aqi_cache, recent)
            (RECENT_DIR / f"{fac['slug']}.json").write_text(
                json.dumps(recent_doc, ensure_ascii=False, separators=(",", ":")))
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
                             "last24h_max_f": None, "last24h_max_at": None,
                             "aqi": None, "aqi_category": None, "aqi_as_of": None, "stale": True})
            stale += 1
            print(f"  [{i}/{len(facs)}] {fac['slug']}: STALE ({type(e).__name__}: {e})", flush=True)

    out = {
        "meta": {
            "generated_at": _now_iso(),
            "recent_days": RECENT_DAYS,
            "sources": {
                "current_temp": ("NOAA RTMA 2.5km 2dvaranl via AWS (noaa-rtma-pds)"
                                 if recent is not None else "NOAA RTMA/URMA via GEE (AWS unavailable)"),
                "recent_history": (f"NOAA RTMA/URMA via GEE + recent ~{RTMA_RECENT_H}h tail "
                                   "via AWS 2dvaranl" if recent is not None
                                   else "NOAA RTMA/URMA via GEE"),
                "forecast_high": "NWS NDFD",
                "aqi": "AirNow" if AIRNOW_KEY else None,
            },
            "current_temp_valid": recent.as_of if recent is not None else None,
            "recent_tail_cycles": recent.cycles if recent is not None else 0,
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
