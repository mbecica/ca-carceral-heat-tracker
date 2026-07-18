#!/usr/bin/env python3
"""Phase 2 live pipeline: current conditions for every facility, every 3 hours.

Reads the facility master (`static/data/facilities.json`) and, per facility:
  - RTMA/URMA hourly temperature for the last 14 days via Google Earth Engine
    (headless in CI via Workload Identity Federation — see validate_ee_headless.py),
    reduced to a per-PT-day tmax series;
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
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
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

def build_facility(fac, aqi_cache):
    """Fetch all sources for one facility and return (statewide_row, recent_doc).
    Raises on RTMA failure so the caller can keep last-good data.

    Output is RAW observations only — no threshold logic. status / °F-over / streak /
    counts are computed client-side from these values against the thresholds in
    facilities.json, so the threshold can change (or be multiple, or user-selected)
    without re-running this fetch. daily_max carries no `over` flag for the same reason."""
    lat, lon = fac["lat"], fac["lon"]
    hourly = rtma_hourly(lat, lon)                      # raises on empty
    daily = daily_max_series(hourly)                    # [{date, max_f}], oldest→newest
    current_temp_f = hourly[-1][1]
    # RTMA on GEE lags real time (often ~12-24h), so stamp when this reading is from;
    # the detail page's live NWS top-up (§5) supersedes it client-side.
    current_temp_as_of = hourly[-1][0].strftime("%Y-%m-%dT%H:00Z")
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
    return row, recent


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

    # Last-good carry-forward: index the previous statewide rows by slug.
    prev = {}
    if STATEWIDE.exists():
        prev = {r["slug"]: r for r in json.loads(STATEWIDE.read_text()).get("facilities", [])}

    RECENT_DIR.mkdir(parents=True, exist_ok=True)
    aqi_cache, rows, ok, stale, over_log = {}, [], 0, 0, 0
    for i, fac in enumerate(facs, 1):
        t0 = time.time()
        try:
            row, recent = build_facility(fac, aqi_cache)
            (RECENT_DIR / f"{fac['slug']}.json").write_text(
                json.dumps(recent, ensure_ascii=False, separators=(",", ":")))
            rows.append(row)
            ok += 1
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
            "sources": {"temp": "NOAA RTMA/URMA via GEE", "forecast_high": "NWS NDFD",
                        "aqi": "AirNow" if AIRNOW_KEY else None},
            "n_ok": ok, "n_stale": stale, "n": len(rows),
            "note": ("Raw observations/forecasts only. status, °F-over, streaks and counts "
                     "are computed client-side against thresholds in facilities.json, so "
                     "thresholds can change without re-fetching."),
        },
        "facilities": rows,
    }
    STATEWIDE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"\nWrote {STATEWIDE.relative_to(REPO)} — {ok} ok / {stale} stale; "
          f"{over_log} over default threshold (log only)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
