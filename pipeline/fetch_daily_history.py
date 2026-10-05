#!/usr/bin/env python3
"""Daily-high history for every facility, 1991 → yesterday, from PRISM daily tmax.

Feeds the facility page's "days at or above a threshold" history section. One
source end to end (PRISM AN91d via Earth Engine `OREGONSTATE/PRISM/ANd`, 4 km) so
year-to-year counts never cross a source seam — the 2026-10 spike found RTMA vs
PRISM per-facility-year counts differ by ±6–12 days, about the size of a real
year-to-year change. The threshold is NOT applied here; the browser applies it
(facilities.json `threshold_f` or a fixed °F), like every other count on the site.

Dates are PRISM's own day labels (`system:index`, e.g. "20240715" = the file
prism_tmax_..._20240715): each image's time_start is 12:00 UTC the PREVIOUS day, so
filtering by timestamp would shift every date by one. Never use filterDate here.

PRISM revises each day for ~6 months (release 1 → 8; 8 = final). So the output is
split to keep git churn small:

  static/data/history/<slug>.json          FROZEN — 1991-01-01 .. end of the last
                                           year whose days are all final. Rewritten
                                           ~once a year, when a year finalizes.
  static/data/history/current/<slug>.json  CURRENT — Jan 1 of the year holding the
                                           oldest provisional day .. latest day.
                                           Rewritten each run (~1–2 KB gzipped).

Both: { slug, source, unit, start, end, tmax:[°F, 1 decimal, one per day] }
(current also carries `provisional_from`; no run timestamp, so a run with no new
PRISM data rewrites identical bytes and the workflow commits nothing). Days are contiguous
from `start`; the index is the day offset.

    python3 pipeline/fetch_daily_history.py            # update (backfills if needed)
    python3 pipeline/fetch_daily_history.py --rebuild  # re-fetch the frozen files too

Runs in the fetch-current workflow (~6 s on a normal run). A new facility has no
frozen file, which triggers a full 1991→ backfill on the next run (2–8 min,
depending on Earth Engine load); a year finalizing triggers a one-year extension.

**Fails loudly, writes nothing** if any facility-day is missing — a silent gap
would undercount days, and gaps are never estimated.

Cost: one Earth Engine request per calendar year for all facilities at once
(~2 s each). A normal run is 1–2 requests; a full backfill is ~36.
"""
import argparse
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import ee

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MASTER = REPO / "static/data/facilities.json"
OUT_DIR = REPO / "static/data/history"
CUR_DIR = OUT_DIR / "current"

PRISM = "OREGONSTATE/PRISM/ANd"
SOURCE = "PRISM AN91d daily tmax (OREGONSTATE/PRISM/ANd), 4 km, via Google Earth Engine"
START = date(1991, 1, 1)           # start of the 1991–2020 baseline period
FINAL_RELEASE = 8                  # PRISM daily release number once a day is final
EE_SCOPES = ["https://www.googleapis.com/auth/earthengine",
             "https://www.googleapis.com/auth/cloud-platform"]


def init_ee(project):
    """Federated ADC in CI (GOOGLE_APPLICATION_CREDENTIALS), interactive creds locally."""
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        import google.auth
        creds, _ = google.auth.default(scopes=EE_SCOPES)
        ee.Initialize(creds, project=project)
    else:
        ee.Initialize(project=project)


def _retry(fn):
    for attempt in range(4):
        try:
            return fn()
        except ee.ee_exception.EEException:
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def provisional_from(col):
    """Oldest day in the last ~18 months whose tmax is not yet final (or None)."""
    since = (date.today() - timedelta(days=550)).strftime("%Y%m%d")
    fc = col.filter(ee.Filter.gte("system:index", since)).map(lambda i: ee.Feature(None, {
        "d": i.get("system:index"),
        "r": ee.Number.parse(ee.String(ee.List(i.get("PRISM_DATASET_RELEASE_NUMBER")).get(3))),
    })).filter(ee.Filter.lt("r", FINAL_RELEASE))
    first = _retry(lambda: ee.Algorithms.If(fc.size(), fc.sort("d").first().get("d"), None)
                   .getInfo())
    return _ymd(first) if first else None


def _ymd(s):
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def fetch_year(col, pts, proj, year):
    """{slug: {date: °F}} for every facility, one request for the whole year."""
    img = (col.filter(ee.Filter.stringStartsWith("system:index", str(year)))
           .select("tmax").toBands())
    fc = img.reduceRegions(pts, ee.Reducer.first(), crs=proj["crs"],
                           crsTransform=proj["transform"])
    rows = _retry(lambda: fc.getInfo())["features"]
    out = {}
    for r in rows:
        p = r["properties"]
        out[p["slug"]] = {_ymd(k):
                          (None if v is None else round(v * 9 / 5 + 32, 1))
                          for k, v in p.items() if k.endswith("_tmax")}
    return out


def to_array(by_date, start, end, slug):
    """Contiguous daily list start..end; raises on any missing day."""
    arr, d, missing = [], start, []
    while d <= end:
        v = by_date.get(d)
        if v is None:
            missing.append(d.isoformat())
        arr.append(v)
        d += timedelta(days=1)
    if missing:
        raise ValueError(f"{slug}: {len(missing)} missing day(s), e.g. {missing[:5]}")
    return arr


def write(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser(description="PRISM daily-high history per facility")
    ap.add_argument("--rebuild", action="store_true", help="re-fetch the frozen files too")
    ap.add_argument("--project", default=os.environ.get("EE_PROJECT", "ca-carceral-heat"))
    args = ap.parse_args()
    t_start = time.time()

    init_ee(args.project)
    facs = json.loads(MASTER.read_text())["facilities"]
    slugs = [f["slug"] for f in facs]
    pts = ee.FeatureCollection([ee.Feature(ee.Geometry.Point([f["lon"], f["lat"]]),
                                           {"slug": f["slug"]}) for f in facs])
    col = ee.ImageCollection(PRISM)
    proj = _retry(lambda: col.first().select("tmax").projection().getInfo())

    latest = _ymd(_retry(lambda: col.limit(1, "system:time_start", False).first()
                               .get("system:index").getInfo()))
    prov = provisional_from(col)
    cur_start = date((prov or latest).year, 1, 1)
    frozen_end = cur_start - timedelta(days=1)
    print(f"PRISM latest {latest}; provisional from {prov}; "
          f"frozen {START}..{frozen_end}; current {cur_start}..{latest}", flush=True)

    # Which frozen years need fetching: all of them on --rebuild or for any facility
    # whose frozen file is missing; otherwise only years past the stored end (the
    # once-a-year roll when a year finalizes).
    need_from = frozen_end + timedelta(days=1)
    for s in slugs:
        p = OUT_DIR / f"{s}.json"
        if args.rebuild or not p.exists():
            need_from = START
            break
        stored_end = date.fromisoformat(json.loads(p.read_text())["end"])
        need_from = min(need_from, stored_end + timedelta(days=1))
    frozen_years = list(range(need_from.year, frozen_end.year + 1)) if need_from <= frozen_end else []

    data = {s: {} for s in slugs}
    for y in frozen_years + list(range(cur_start.year, latest.year + 1)):
        t0 = time.time()
        for s, by_date in fetch_year(col, pts, proj, y).items():
            data[s].update(by_date)
        print(f"  fetched {y} ({time.time() - t0:.1f}s)", flush=True)

    # Validate everything before writing anything.
    frozen, current = {}, {}
    for s in slugs:
        if frozen_years:
            old = {}
            if need_from > START:      # extend an existing frozen file
                prev = json.loads((OUT_DIR / f"{s}.json").read_text())
                d0 = date.fromisoformat(prev["start"])
                old = {d0 + timedelta(days=i): v for i, v in enumerate(prev["tmax"])}
            frozen[s] = to_array({**old, **data[s]}, START, frozen_end, s)
        current[s] = to_array(data[s], cur_start, latest, s)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CUR_DIR.mkdir(parents=True, exist_ok=True)
    for s in slugs:
        if s in frozen:
            write(OUT_DIR / f"{s}.json", {"slug": s, "source": SOURCE, "unit": "°F",
                                          "start": START.isoformat(), "end": frozen_end.isoformat(),
                                          "tmax": frozen[s]})
        write(CUR_DIR / f"{s}.json", {"slug": s, "source": SOURCE, "unit": "°F",
                                      "start": cur_start.isoformat(), "end": latest.isoformat(),
                                      "provisional_from": prov.isoformat() if prov else None,
                                      "tmax": current[s]})
    # Closed facilities drop out of the master; drop their history files too.
    keep = set(slugs)
    for d in (OUT_DIR, CUR_DIR):
        for p in d.glob("*.json"):
            if p.stem not in keep:
                p.unlink()
                print(f"  removed {p.relative_to(REPO)} (not in facilities.json)", flush=True)
    print(f"Wrote {len(frozen)} frozen + {len(current)} current files "
          f"in {time.time() - t_start:.0f}s", flush=True)


if __name__ == "__main__":
    try:
        main()
    except ValueError as e:            # missing data: fail loudly, nothing written
        sys.exit(f"ERROR: {e}")
