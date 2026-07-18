# California Carceral Facility Heat Tracker

A live map and per-facility view of how hot it currently is at each active California
carceral facility, relative to that facility's own long-term summer normal — with the last
two weeks of hourly temperature for context. A companion to the
[Prison Heat Index](https://marybecica.com/prison-heat-index/).

> **Status: in development.** The data pipeline and documentation are in place; the Hugo
> front-end and the scheduled live-data job are not built yet. Not deployed.

## Repository layout

- **`pipeline/`** — the data build scripts (`build_facilities.py`, `build_baselines.py`,
  `build_historic_bands.py`) and their inputs/registry (`pipeline/data/`). These read the
  facility lists from the sibling [`ca_prison_climate_justice`](https://github.com/mbecica/ca_prison_climate_justice)
  open-data repo. A live fetch job (`fetch_current.py`) will join them.
- **`static/data/`** — generated data the site serves (`facilities.json`, boundaries, and
  per-facility band/live files).
- **`content/`** — per-facility page stubs.
- [`METHODS.md`](METHODS.md) — data sources and methodology (seeds the public methods page).
- [`REFRESH.md`](REFRESH.md) — how to refresh the data.

## Data

Facility and climate data are drawn from public sources (PRISM, NOAA/NWS, EPA, FEMA/HIFLD,
CDCR). Facility attributes originate in the open
[`ca_prison_climate_justice`](https://github.com/mbecica/ca_prison_climate_justice) repository.
