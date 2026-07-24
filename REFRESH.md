# REFRESH.md — Heat Tracker data refresh runbook

How to refresh this app's data. The build scripts live in `pipeline/`; the open-data
*inputs* they read (the facility lists) live in the sibling
[`ca_prison_climate_justice`](https://github.com/mbecica/ca_prison_climate_justice) repo
and are refreshed on *that* repo's own schedule (see its `REFRESH.md`). This runbook is
only about turning those inputs + the climate APIs into the app's served data.

## Prerequisites

- **Both repos checked out side-by-side** — the static builds read
  `../ca_prison_climate_justice/data_sources/facilities/ca_facilities.csv` and
  `.../data/cdcr/cdcr_facilities.csv` as sibling files. They read that checkout's
  **working tree**, not a pinned commit, so make sure it is committed and on the intended
  revision before building — uncommitted mid-edit state lands in `facilities.json` silently.
- **Google Earth Engine auth** — baselines (PRISM) and bands (RTMA/URMA) come through GEE.
  Locally: `earthengine authenticate` once. The scheduled job uses Workload Identity
  Federation (no key). Project: `ca-carceral-heat` (or set `EE_PROJECT`).
- Python deps: `earthengine-api`, `pandas`, `shapely`.

## The data, and when each refreshes

| Data | Script | Source | Refresh trigger |
|---|---|---|---|
| **Facility master** (`static/data/facilities.json`, stubs, boundaries, `_redirects`, `pipeline/data/slugs.csv`) | `pipeline/build_facilities.py` | climate-justice CSVs + `pipeline/data/baselines.csv` + PHI cross-links | Whenever the facility list or CDCR extras change (pre-season) |
| **Baseline / threshold** (`pipeline/data/baselines.csv` → `threshold_f` in facilities.json) | `pipeline/build_baselines.py` | PRISM 1991–2020 `tmax` normals (GEE) | **Never re-windowed** — 1991–2020 is the fixed WMO normal. Only `--only-missing` for *new* facilities |
| **Historic band** (`static/data/bands/<slug>.json`) | `pipeline/build_historic_bands.py` | RTMA/URMA last-10-complete-years hourly (GEE) | Post-season, to roll the 10-year window forward (auto-computed); `--only-missing` for new facilities mid-cycle |
| **Live conditions** (`static/data/statewide.json`, `recent/<slug>.json`) | `pipeline/fetch_current.py` *(Phase 2)* | NWS NDFD + RTMA/URMA + AirNow | **Automatic** — GitHub Actions cron; no manual refresh. **Temporary** (2026-07-21 → ~2026-08-21) every 6 h at 05/11/17/23 UTC (≈4am/10am/4pm/10pm PT) for a morning + afternoon-high reading; reverts to daily `0 17 * * *` after the trial. Cadence is capped by the shared 500-build/mo Cloudflare quota; Phase 4 (R2) decouples delivery from builds and lifts that cap |

The rolling band window is computed from today (last 10 *complete* calendar years), so it
advances on its own each year; override with `BAND_YEAR_END`.

## Procedures

**Pre-season (Apr–May) — the facility refresh.** After climate-justice rebuilds its facility
CSVs (its REFRESH), here:

```
cd pipeline
python3 build_facilities.py                          # new slugs/stubs, thresholds, redirects
python3 build_baselines.py --only-missing            # PRISM baseline for any NEW facilities only
python3 build_historic_bands.py --only-missing        # RTMA band for any NEW facilities only
python3 build_facilities.py                          # rerun so new thresholds land in facilities.json
```

Then review the git diff — it shows exactly which facilities' numbers changed. A closure
shows as: stub deleted, `_redirects` line added, slug marked `retired` in `slugs.csv`.

**Check the CDCR block for silent nulls.** `build_facilities.py` reads the CDCR extras
(cooling mix, demographics, medical) with `f.get("column")`, so a column that climate-justice
renames or drops does *not* raise — it writes `null`, and the affected section quietly
disappears from all 31 CDCR prison detail pages while the run still reports success. This
happened in July 2026, when the cooling columns were renamed twice in one evening. So don't
trust the exit status: after a refresh where the upstream CSVs changed, confirm the built
JSON against the source, e.g.

```python
import json, pandas as pd
d = json.load(open("static/data/facilities.json"))
c = pd.read_csv("../ca_prison_climate_justice/data/cdcr/cdcr_facilities.csv").set_index("cdcr_code")
built = sum(1 for f in d["facilities"] if f.get("cdcr") and f["cdcr"]["cooling"]["n_housing_units"])
src = int(c["n_housing_units"].notna().sum())          # prisons the CDCR report covers
print(built, "of", src, "prisons have a cooling mix")  # must match; 31 as of July 2026
```

An all-null CDCR block and a good build produce identical console output — the count is the
only thing that tells them apart.

**Post-season (Nov–Dec) — roll the band forward.** Rebuild every band so the 10-year window
picks up the season just finished (the window auto-advances once the new year is complete):

```
cd pipeline && python3 build_historic_bands.py       # all facilities, new 10-yr window
```

**New facilities mid-cycle.** `build_facilities.py`, then `build_baselines.py --only-missing`
and `build_historic_bands.py --only-missing`, then `build_facilities.py` again.

**Commit.** Commit the app repo; the commit triggers the Cloudflare Pages rebuild. The live
`fetch_current.py` job needs no changes — it reads `facilities.json` and picks up added or
removed facilities on its next run.

## Notes

- `slugs.csv` is **append-only** — never edit slugs by hand; retired slugs are never reused
  (URL stability contract).
- Baselines use PRISM 800 m normals; bands and live use NWS/RTMA at 2.5 km — a small
  (~1–2°F) PRISM-vs-RTMA offset is expected and spot-checked at sample facilities before launch.
- The static builds are the only thing that needs the climate-justice checkout; the live
  cron job does not.
