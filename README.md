# California Carceral Facility Heat Tracker

Live at **[heat.marybecica.com](https://heat.marybecica.com)**.

This tool tracks how hot it currently is at California prisons, jails and other carceral
facilities, measured against that facility's own long-term historic summer temperatures. It
was built to help advocates highlight heat events in California prisons and bring attention to
this public-health and human-rights crisis, in support of the Climate Justice Coalition for
California Prisons. This project acknowledges and extends the work of
[The Toxic Prisons Mapping Project](https://www.toxicprisons.com/).

> **Status: in development — prototype phase.**

## Data

Facility and climate data are drawn from public sources (PRISM, NOAA/NWS, EPA, FEMA/HIFLD,
CDCR). See the [methods page](https://heat.marybecica.com/methods/) for the full source list,
resolutions, and methodology, including how each facility's historic summer comparison is
built.

The facility list comes from [ca_prison_climate_justice](https://github.com/mbecica/ca_prison_climate_justice),
CDCR prison details (cooling, demographics, health care population) from
[cdcr_facility_data](https://github.com/mbecica/cdcr_facility_data), and links to each prison's
Prison Heat Index profile from [cdcr_prison_heat_index](https://github.com/mbecica/cdcr_prison_heat_index).

## Repository layout

- **`pipeline/`**: data build scripts and their inputs (`pipeline/data/`).
  - `build_facilities.py`: facility list, detail-page stubs, boundaries, and redirects for closed facilities.
  - `build_baselines.py`: each facility's 1991–2020 summer baseline from PRISM.
  - `build_historic_bands.py`: each facility's historic temperature band from RTMA/URMA.
  - `fetch_current.py`: latest conditions, run by GitHub Actions four times a day.
- **`static/data/`**: generated data the site serves (`facilities.json`, boundaries, per-facility
  band and recent-conditions files).
- **`content/`**: per-facility page stubs and the [methods page](content/methods.md).
- **`layouts/`** and **`static/{css,js}/`**: the Hugo front end (`cht-` CSS namespace): statewide
  map, jurisdiction filter, sortable table, and per-facility pages with a 14-day chart. Status and
  degrees over the threshold are computed in the browser against `threshold_f`
  (`static/js/cht-status.js`).

## Updating the data

Latest conditions update automatically. The other builds read the upstream repositories from
sibling checkouts and use Google Earth Engine (`earthengine authenticate`, project
`ca-carceral-heat`); they need `earthengine-api`, `pandas`, and `shapely`. Run them from
`pipeline/`.

| Data | Script | When |
| :--- | :--- | :--- |
| Facility list and CDCR details | `build_facilities.py` | When the upstream facility list or CDCR data changes |
| Summer baselines | `build_baselines.py --only-missing` | For new facilities only; the 1991–2020 normal is fixed |
| Historic bands | `build_historic_bands.py` | Each winter, to move the 10-year window forward; `--only-missing` for new facilities |
| Latest conditions | `fetch_current.py` | Automatic (`.github/workflows/fetch-current.yml`) |

When facilities are added, run `build_facilities.py`, then the baseline and band scripts with
`--only-missing`, then `build_facilities.py` again so the new thresholds are included. A closed
facility's page is removed and its URL redirected; `pipeline/data/slugs.csv` is append-only, so
retired URLs are never reused. Pushing to `main` rebuilds the site on Cloudflare Pages.
