#!/usr/bin/env python3
"""Per-facility temperature baselines for the CA Carceral Facility Heat Tracker.

For every OPEN facility, reads the **PRISM 1991–2020 30-year normals** (`tmax`,
800 m, station-anchored) from Google Earth Engine and computes the day-weighted
June–August mean daily-max temperature (°F). The app's display threshold is this
baseline + 10°F (Skarha et al. 2023 mortality metric).

Why PRISM (see METHODS.md): it is observation-anchored, so it
resolves California's coastal/marine-valley microclimates that a reanalysis model
(ERA5) reads 5–10°F too warm. PRISM is *published directly* as a normal — we read
the point value, we do not compute a 30-year climatology ourselves. The
1991–2020 window is the current WMO/NOAA standard normal; it is fixed by
definition and never "refreshes".

Access uses the same Earth Engine project as build_historic_bands.py. Authenticate
once with `earthengine authenticate`; the scheduled pipeline uses Workload Identity
Federation (no key). Set EE_PROJECT or pass --project.

    python3 pipeline/build_baselines.py
    python3 pipeline/build_baselines.py --only-missing   # new facilities only

Output: pipeline/data/baselines.csv
    facilityid, name, latitude, longitude, baseline_summer_avg_tmax_f,
    threshold_f, source, prism_scale_m, retrieved
"""
import argparse
import csv
import os
from datetime import date
from pathlib import Path

import ee
import pandas as pd

HERE = Path(__file__).resolve().parent                   # <app repo>/pipeline/
APP = HERE.parent                                        # ca-carceral-heat-tracker/
CJ = APP.parent / "ca_prison_climate_justice"            # sibling open-data repo (inputs)
FAC_CSV = CJ / "data_sources/facilities/ca_facilities.csv"
OUT_CSV = HERE / "data/baselines.csv"

PRISM = "OREGONSTATE/PRISM/Norm91m"          # 1991–2020 monthly normals, 800 m
THRESHOLD_DELTA_F = 10.0
BASELINE_PERIOD = "1991-2020"
# Jun/Jul/Aug day counts for the day-weighted seasonal mean.
SUMMER = {6: 30, 7: 31, 8: 31}
CHUNK = 100                                  # points per reduceRegions call
SOURCE = "PRISM Norm91m tmax (1991-2020 JJA mean daily-max), via Google Earth Engine"


def c_to_f(c):
    return None if c is None else round(c * 9 / 5 + 32, 1)


def summer_baseline_image():
    """Day-weighted June–August mean of the PRISM monthly tmax normals (°C)."""
    col = ee.ImageCollection(PRISM)
    total_days = sum(SUMMER.values())
    acc = None
    for m, days in SUMMER.items():
        img = ee.Image(col.filter(ee.Filter.eq("system:index", f"{m:02d}")).first()).select("tmax")
        term = img.multiply(days)
        acc = term if acc is None else acc.add(term)
    return acc.divide(total_days).rename("tmax_jja")


def fetch_points(baseline_img, rows):
    """rows: list of (facilityid, name, lat, lon). Returns {facilityid: mean_c}."""
    feats = [ee.Feature(ee.Geometry.Point(lon, lat), {"fid": fid})
             for fid, _, lat, lon in rows]
    fc = ee.FeatureCollection(feats)
    # PRISM native scale ~928 m; sample at ~800 m.
    res = baseline_img.reduceRegions(fc, ee.Reducer.first(), 800).getInfo()
    return {int(f["properties"]["fid"]): f["properties"].get("first")
            for f in res["features"]}


def main():
    ap = argparse.ArgumentParser(description="Build 1991-2020 PRISM summer baselines")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip facilities already in baselines.csv")
    ap.add_argument("--project", default=os.environ.get("EE_PROJECT", "ca-carceral-heat"),
                    help="Earth Engine Cloud project id")
    args = ap.parse_args()

    ee.Initialize(project=args.project)
    print(f"Earth Engine initialized (project={args.project})")

    fac = pd.read_csv(FAC_CSV)
    fac = fac[fac["status"] == "OPEN"]
    rows = [(int(f.facilityid), f.name, float(f.latitude), float(f.longitude))
            for f in fac.itertuples()]

    existing = []
    if OUT_CSV.exists():
        with open(OUT_CSV) as f:
            existing = list(csv.DictReader(f))
    if args.only_missing:
        done = {int(r["facilityid"]) for r in existing}
        rows = [r for r in rows if r[0] not in done]
        print(f"--only-missing: {len(done)} already built, {len(rows)} to fetch")
    else:
        existing = []

    if not rows:
        print("Nothing to fetch.")
        return

    baseline_img = summer_baseline_image()
    today = date.today().isoformat()
    out_rows = existing
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        print(f"  chunk {i // CHUNK + 1}/{-(-len(rows) // CHUNK)} ({len(chunk)} points)", flush=True)
        vals = fetch_points(baseline_img, chunk)
        for fid, name, lat, lon in chunk:
            base_f = c_to_f(vals.get(fid))
            out_rows.append({
                "facilityid": fid, "name": name, "latitude": lat, "longitude": lon,
                "baseline_summer_avg_tmax_f": base_f,
                "threshold_f": None if base_f is None else round(base_f + THRESHOLD_DELTA_F, 1),
                "source": SOURCE, "prism_scale_m": 800, "retrieved": today,
            })
        OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
        with open(OUT_CSV, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
            w.writeheader()
            w.writerows(out_rows)

    n_null = sum(1 for r in out_rows if not r["baseline_summer_avg_tmax_f"])
    print(f"Wrote {len(out_rows)} baselines -> {OUT_CSV.relative_to(APP)}"
          + (f" ({n_null} null — check coords)" if n_null else ""))


if __name__ == "__main__":
    main()
