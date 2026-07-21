# California Carceral Facility Heat Tracker

Live at **[heat.marybecica.com](https://heat.marybecica.com)**.

This tool tracks how hot it currently is at California prisons, jails and other carceral
facilities, measured against that facility's own long-term historic summer temperatures. It
was built to help advocates highlight heat events in California prisons and bring attention to
this public-health and human-rights crisis, in support of the Climate Justice Coalition for
California Prisons. This project acknowledges and extends the work of
[The Toxic Prisons Mapping Project](https://www.toxicprisons.com/).

> **Status: in development — prototype phase.**

## Repository layout

- **`pipeline/`** — the data build scripts (`build_facilities.py`, `build_baselines.py`,
  `build_historic_bands.py`) and their inputs/registry (`pipeline/data/`). These read the
  facility lists from the sibling [`ca_prison_climate_justice`](https://github.com/mbecica/ca_prison_climate_justice)
  open-data repo. A live fetch job (`fetch_current.py`) will join them.
- **`static/data/`** — generated data the site serves (`facilities.json`, boundaries, and
  per-facility band/live files).
- **`content/`** — per-facility page stubs + the methods page.
- **`layouts/`** + **`static/{css,js}/`** — the standalone Hugo front-end (`cht-` CSS namespace):
  statewide temperature map + jurisdiction filter + sortable table, per-facility detail pages with
  a D3 14-day chart, and the methods page. Status / °F-over is computed in the browser from the raw
  JSON against `threshold_f` (`static/js/cht-status.js`).
- [`content/methods.md`](content/methods.md) — the public Methods & Sources page (data sources + methodology).
- [`REFRESH.md`](REFRESH.md) — how to refresh the data.
- [`DEPLOY.md`](DEPLOY.md) — Cloudflare Pages + subdomain setup.

## Data

Facility and climate data are drawn from public sources (PRISM, NOAA/NWS, EPA, FEMA/HIFLD,
CDCR). See the [methods page](https://heat.marybecica.com/methods/) for the full source list,
resolutions, and methodology, including how each facility's historic summer comparison is
built. Facility attributes originate in the open
[`ca_prison_climate_justice`](https://github.com/mbecica/ca_prison_climate_justice) repository,
which also publishes the facility-level hazard, exposure, and vulnerability dataset.
