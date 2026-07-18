#!/usr/bin/env python3
"""Stage 1 of the historic band pipeline: fetch and cache the raw hourly data.

This is the **expensive, run-once** step. For each facility it pulls the last 10
complete years of hourly temperature from NOAA RTMA/URMA (2.5 km) via Google Earth
Engine and caches the raw per-year hourly series to disk. Everything the UI shows —
the min/median/max envelope, the median line, per-year "spaghetti" lines, the
threshold-crossing counts — is derived from this cache by `build_historic_bands.py`
(stage 2), which needs no Earth Engine. So **UI changes never re-hit Earth Engine**;
only rolling the 10-year window forward (post-season) does.

    python3 pipeline/fetch_historic_raw.py                 # all facilities
    python3 pipeline/fetch_historic_raw.py --only-missing  # new / resume

Output (one file per facility): pipeline/data/raw/<slug>.json
    { slug, years, tz, season, unit, n_hours,
      by_year: { "<year>": [ n_hours °F values, null for missing hours ] } }
    Index i = hour i of the season = Jun 1 00:00 local + i calendar hours
    (DST-free), so it aligns 1:1 with the band arrays in stage 2.

Runtime: ~1 min/facility (one year-chunked getRegion each), so ~5–6 h for all 357.
Interruptible — rerun with --only-missing to resume. Auth: `earthengine authenticate`
locally, or Workload Identity Federation in CI. Rolling window auto-advances; override
with BAND_YEAR_END.
"""
import argparse
import csv
import json
import os
import time
from datetime import date as _date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import ee
import pandas as pd

HERE = Path(__file__).resolve().parent                   # <app repo>/pipeline/
CJ = HERE.parent.parent / "ca_prison_climate_justice"    # sibling open-data repo (inputs)
FAC_CSV = CJ / "data_sources/facilities/ca_facilities.csv"
REGISTRY_CSV = HERE / "data/slugs.csv"
RAW_DIR = HERE / "data/raw"

RTMA = "NOAA/NWS/RTMA"
TZ = "America/Los_Angeles"
YEAR_END = int(os.environ.get("BAND_YEAR_END", _date.today().year - 1))
YEAR_START = YEAR_END - 9
SEASON_MONTHS = (6, 10)
SEASON_DAYS = 153                                        # Jun 1 .. Oct 31
N_HOURS = SEASON_DAYS * 24
_OFFSET = {6: 0, 7: 30, 8: 61, 9: 92, 10: 122}          # cumulative days before each month


def hour_of_season(month, day, hour):
    return (_OFFSET[month] + (day - 1)) * 24 + hour


def fetch_raw(pt):
    """Return {year: [N_HOURS °F, None for missing]} for the season at pt. Pulled
    one year at a time — a single 10-year getRegion exceeds GEE's per-query memory
    limit — with a retry."""
    la = ZoneInfo(TZ)
    base = (ee.ImageCollection(RTMA).select("TMP")
            .filter(ee.Filter.calendarRange(SEASON_MONTHS[0], SEASON_MONTHS[1], "month")))
    by_year = {}
    for yr in range(YEAR_START, YEAR_END + 1):
        arr = [None] * N_HOURS
        col = base.filter(ee.Filter.calendarRange(yr, yr, "year"))
        for attempt in range(4):
            try:
                rows = col.getRegion(pt, 2500).getInfo()
                break
            except ee.ee_exception.EEException:
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
            arr[hour_of_season(dt.month, dt.day, dt.hour)] = round(tmp * 9 / 5 + 32, 1)
        by_year[str(yr)] = arr
    return by_year


def main():
    ap = argparse.ArgumentParser(description="Cache raw 10-yr hourly RTMA per facility")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip facilities whose raw cache already exists (= resume)")
    ap.add_argument("--project", default=os.environ.get("EE_PROJECT", "ca-carceral-heat"))
    ap.add_argument("--limit", type=int, help="only fetch the first N (for testing)")
    args = ap.parse_args()

    ee.Initialize(project=args.project)
    print(f"Earth Engine initialized (project={args.project}); window {YEAR_START}-{YEAR_END}", flush=True)

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
        out = RAW_DIR / f"{r['slug']}.json"
        if args.only_missing and out.exists():
            continue
        todo.append((r["slug"], float(fac.loc[fid, "latitude"]), float(fac.loc[fid, "longitude"]), out))
    if args.limit:
        todo = todo[:args.limit]

    print(f"{len(todo)} facilities to fetch", flush=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for i, (slug, lat, lon, out) in enumerate(todo, 1):
        t0 = time.time()
        by_year = fetch_raw(ee.Geometry.Point(lon, lat))
        n = sum(1 for a in by_year.values() for v in a if v is not None)
        raw = {"slug": slug, "years": f"{YEAR_START}-{YEAR_END}", "tz": TZ,
               "season": "06-01..10-31", "unit": "°F", "n_hours": N_HOURS, "by_year": by_year}
        out.write_text(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
        print(f"  [{i}/{len(todo)}] {slug}: {n} obs, {time.time()-t0:.1f}s", flush=True)
    print("Done ->", RAW_DIR, flush=True)


if __name__ == "__main__":
    main()
