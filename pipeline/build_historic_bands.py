#!/usr/bin/env python3
"""Per-facility historic hourly temperature envelopes for the CA Carceral
Facility Heat Tracker.

For each facility, pulls 10 years (2016–2025) of hourly temperature from NOAA
**RTMA/URMA** (2.5 km observation-anchored analysis) via Google Earth Engine and
computes, for every hour of the June 1 – October 31 season, the p10 / median /
p90 across those years. The detail-page chart slices the current two-week window
out of this band ("you are here vs. the last decade"). RTMA is the same
observation-anchored family as the live feed, so the band and the current trace
agree at each facility's microclimate — see SCOPE_AND_PLAN §2.

To keep the band smooth despite only ~10 values per exact hour-slot, each slot
pools a ±SMOOTH_DAYS window of the *same hour-of-day* across all years (~70
samples), which preserves the diurnal shape while stabilizing the percentiles.

Times are handled in America/Los_Angeles on a fixed, DST-free calendar (index i =
hour i of the season = Jun 1 00:00 local + i calendar hours), matching the app's
day boundaries.

    python3 analysis/heatwave_app/build_historic_bands.py                 # all
    python3 analysis/heatwave_app/build_historic_bands.py --only-missing  # new/resume

Output: <app repo>/static/data/bands/<slug>.json
    { slug, years, season, tz, unit, n_hours, p10[], p50[], p90[] }  (whole °F)

Post-season refresh: bump YEAR_START/YEAR_END forward one year and rerun.
"""
import argparse
import csv
import json
import os
import statistics
import time
from pathlib import Path

import ee
import pandas as pd

HERE = Path(__file__).resolve().parent                   # <app repo>/pipeline/
APP = HERE.parent                                        # ca-carceral-heat-tracker/
CJ = APP.parent / "ca_prison_climate_justice"            # sibling open-data repo (inputs)
FAC_CSV = CJ / "data_sources/facilities/ca_facilities.csv"
REGISTRY_CSV = HERE / "data/slugs.csv"
BAND_DIR = APP / "static/data/bands"

RTMA = "NOAA/NWS/RTMA"
TZ = "America/Los_Angeles"
# Rolling last-10-complete-years window: computed from today so it advances on its
# own (2016–2025 in 2026, 2017–2026 in 2027, …). Override with BAND_YEAR_END.
from datetime import date as _date
YEAR_END = int(os.environ.get("BAND_YEAR_END", _date.today().year - 1))
YEAR_START = YEAR_END - 9
SEASON_MONTHS = (6, 10)                     # Jun–Oct inclusive
SMOOTH_DAYS = 3                             # ±days pooled per slot (same hour-of-day)
SEASON_DAYS = 153                           # Jun 1 .. Oct 31
N_HOURS = SEASON_DAYS * 24


def c_to_f(c):
    return c * 9 / 5 + 32


def day_of_season(month, day):
    """Calendar day index 0..152 for Jun 1 .. Oct 31 (fixed, non-leap)."""
    offset = {6: 0, 7: 30, 8: 61, 9: 92, 10: 122}   # cumulative days before each month
    return offset[month] + (day - 1)


def fetch_series(pt):
    """Return list of (day_of_season, hour, temp_f) for the season across the
    10-year window at pt. Pulled one year at a time: a single 10-year getRegion
    (~36k values) exceeds GEE's per-query memory limit, so we chunk by year
    (~3.6k each) with a retry."""
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    la = ZoneInfo(TZ)
    base = (ee.ImageCollection(RTMA).select("TMP")
            .filter(ee.Filter.calendarRange(SEASON_MONTHS[0], SEASON_MONTHS[1], "month")))
    out = []
    for yr in range(YEAR_START, YEAR_END + 1):
        col = base.filter(ee.Filter.calendarRange(yr, yr, "year"))
        for attempt in range(4):
            try:
                rows = col.getRegion(pt, 2500).getInfo()
                break
            except ee.ee_exception.EEException as e:
                if attempt == 3:
                    raise
                time.sleep(10 * (attempt + 1))
        for r in rows[1:]:
            t_ms, tmp = r[3], r[4]
            if tmp is None:
                continue
            dt = datetime.fromtimestamp(t_ms / 1000, timezone.utc).astimezone(la)
            if dt.month < SEASON_MONTHS[0] or dt.month > SEASON_MONTHS[1]:
                continue
            out.append((day_of_season(dt.month, dt.day), dt.hour, c_to_f(tmp)))
    return out


def build_band(series):
    """series: list of (day_of_season, hour, temp_f). Returns p10/p50/p90 arrays
    of length N_HOURS, each slot pooling ±SMOOTH_DAYS of the same hour."""
    # bucket[hour][day] -> list of temps
    by_hour = {h: {} for h in range(24)}
    for d, h, t in series:
        by_hour[h].setdefault(d, []).append(t)
    p10, p50, p90 = [], [], []
    for d in range(SEASON_DAYS):
        for h in range(24):
            pool = []
            for dd in range(d - SMOOTH_DAYS, d + SMOOTH_DAYS + 1):
                if 0 <= dd < SEASON_DAYS:
                    pool.extend(by_hour[h].get(dd, []))
            if len(pool) >= 3:
                qs = statistics.quantiles(pool, n=10, method="inclusive")
                p10.append(round(qs[0])); p50.append(round(statistics.median(pool))); p90.append(round(qs[8]))
            else:
                p10.append(None); p50.append(None); p90.append(None)
    return p10, p50, p90


def main():
    ap = argparse.ArgumentParser(description="Build 10-yr RTMA hourly envelope bands")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip facilities whose band JSON already exists (= resume)")
    ap.add_argument("--project", default=os.environ.get("EE_PROJECT", "ca-carceral-heat"))
    ap.add_argument("--limit", type=int, help="only build the first N (for testing)")
    args = ap.parse_args()

    ee.Initialize(project=args.project)
    print(f"Earth Engine initialized (project={args.project})", flush=True)

    fac = pd.read_csv(FAC_CSV)
    fac = fac[fac["status"] == "OPEN"].set_index("facilityid")
    if not REGISTRY_CSV.exists():
        raise SystemExit("slugs.csv not found — run build_facilities.py first")
    with open(REGISTRY_CSV) as f:
        registry = [r for r in csv.DictReader(f) if not r["retired"]]

    todo = []
    for r in registry:
        fid = int(r["facilityid"])
        if fid not in fac.index:
            continue
        out = BAND_DIR / f"{r['slug']}.json"
        if args.only_missing and out.exists():
            continue
        todo.append((r["slug"], float(fac.loc[fid, "latitude"]), float(fac.loc[fid, "longitude"]), out))
    if args.limit:
        todo = todo[:args.limit]

    print(f"{len(todo)} bands to build ({YEAR_START}–{YEAR_END}, Jun–Oct, ±{SMOOTH_DAYS}d smoothing)", flush=True)
    BAND_DIR.mkdir(parents=True, exist_ok=True)
    for i, (slug, lat, lon, out) in enumerate(todo, 1):
        t0 = time.time()
        series = fetch_series(ee.Geometry.Point(lon, lat))
        p10, p50, p90 = build_band(series)
        n_null = sum(1 for v in p50 if v is None)
        band = {"slug": slug, "years": f"{YEAR_START}-{YEAR_END}", "season": "06-01..10-31",
                "tz": TZ, "unit": "°F", "n_hours": N_HOURS, "p10": p10, "p50": p50, "p90": p90}
        out.write_text(json.dumps(band, ensure_ascii=False, separators=(",", ":")))
        print(f"  [{i}/{len(todo)}] {slug}: {len(series)} obs, {time.time()-t0:.1f}s"
              + (f", {n_null} empty slots" if n_null else ""), flush=True)
    print("Done ->", BAND_DIR, flush=True)


if __name__ == "__main__":
    main()
