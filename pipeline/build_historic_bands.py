#!/usr/bin/env python3
"""Stage 2 of the historic band pipeline: derive the UI band from the raw cache.

Reads the cached raw hourly series (`pipeline/data/raw/<slug>.json`, produced by
`fetch_historic_raw.py`) and computes what the detail-page chart shows:

  - **min / median / max** hourly envelope across the 10 years (the shaded band),
    each slot pooling a ±SMOOTH_DAYS window of the same hour-of-day so a single
    freak hour doesn't spike the envelope;
  - **daily_max_by_year** — each year's daily-max per season-day, so the app can
    count, for any window, how many years crossed the facility's threshold
    (threshold is per-facility and applied at display time, not baked in here).

**No Earth Engine.** This is fast and local, so re-run it freely whenever the UI
changes (different band representation, smoothing, percentiles, spaghetti lines, …)
— the expensive data pull in stage 1 is never repeated for a UI change.

    python3 pipeline/build_historic_bands.py                 # all cached facilities
    python3 pipeline/build_historic_bands.py --only-missing  # skip already-built bands

Output: <app repo>/static/data/bands/<slug>.json
    { slug, years, season, tz, unit, n_hours, season_days,
      min[], median[], max[], daily_max_by_year: {year:[...]} }   (whole °F)

The raw cache already contains the per-year hourly arrays, so a future "spaghetti"
UI (individual year lines) needs only a change here, not a re-fetch.
"""
import argparse
import json
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent                   # <app repo>/pipeline/
APP = HERE.parent                                        # ca-carceral-heat-tracker/
RAW_DIR = HERE / "data/raw"
BAND_DIR = APP / "static/data/bands"

SMOOTH_DAYS = 2                                          # ±days pooled per hourly slot
SEASON_DAYS = 153


def build_band(by_year, n_hours):
    """by_year: {year: [n_hours °F or None]}. Returns (min[], median[], max[],
    daily_max_by_year) — envelope smoothed ±SMOOTH_DAYS within the same hour-of-day."""
    years = sorted(by_year)
    # by_hour[hour][day] -> temps across years; daily[year][day] -> that day's max
    by_hour = {h: {} for h in range(24)}
    daily = {y: {} for y in years}
    for y in years:
        arr = by_year[y]
        for i, v in enumerate(arr):
            if v is None:
                continue
            d, h = divmod(i, 24)
            by_hour[h].setdefault(d, []).append(v)
            dm = daily[y]
            dm[d] = v if d not in dm else max(dm[d], v)

    mn, md, mx = [], [], []
    for d in range(SEASON_DAYS):
        for h in range(24):
            pool = []
            for dd in range(d - SMOOTH_DAYS, d + SMOOTH_DAYS + 1):
                if 0 <= dd < SEASON_DAYS:
                    pool.extend(by_hour[h].get(dd, []))
            if len(pool) >= 3:
                mn.append(round(min(pool))); md.append(round(statistics.median(pool))); mx.append(round(max(pool)))
            else:
                mn.append(None); md.append(None); mx.append(None)

    daily_max_by_year = {
        y: [round(daily[y][d]) if d in daily[y] else None for d in range(SEASON_DAYS)]
        for y in years
    }
    return mn, md, mx, daily_max_by_year


def main():
    ap = argparse.ArgumentParser(description="Derive UI bands from the raw cache (no Earth Engine)")
    ap.add_argument("--only-missing", action="store_true", help="skip already-built band JSONs")
    args = ap.parse_args()

    raws = sorted(RAW_DIR.glob("*.json"))
    if not raws:
        raise SystemExit(f"No raw cache in {RAW_DIR} — run fetch_historic_raw.py first")
    BAND_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{len(raws)} cached facilities", flush=True)

    built = 0
    for p in raws:
        out = BAND_DIR / p.name
        if args.only_missing and out.exists():
            continue
        raw = json.loads(p.read_text())
        mn, md, mx, dmy = build_band(raw["by_year"], raw["n_hours"])
        band = {"slug": raw["slug"], "years": raw["years"], "season": raw["season"],
                "tz": raw["tz"], "unit": "°F", "n_hours": raw["n_hours"], "season_days": SEASON_DAYS,
                "min": mn, "median": md, "max": mx, "daily_max_by_year": dmy}
        out.write_text(json.dumps(band, ensure_ascii=False, separators=(",", ":")))
        built += 1
    print(f"Built {built} bands -> {BAND_DIR}", flush=True)


if __name__ == "__main__":
    main()
