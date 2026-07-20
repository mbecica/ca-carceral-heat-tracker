---
title: "Methods & Data Sources"
type: methods
url: "/methods/"
summary: "How the California Carceral Facility Heat Tracker measures heat: the per-facility comparison line, the observation-anchored data sources, and the limitations."
---

This tracker shows how hot it currently is at each active California carceral facility,
relative to that facility's own long-term summer normal, with the last two weeks of hourly
temperature for context.

## How each facility is measured

Each facility is compared against **its own** local climate, not a statewide number. The
comparison line is:

> **the facility's 1991–2020 June–August average daily high, plus 10°F.**

A day whose high reaches that line — 10°F or more above the local summer normal — is what the
tracker flags. It is a single-day signal about one place on one day; it is not a "heatwave,"
which means two or more consecutive days of above-average heat.

**Why +10°F, and why relative to each place.** This follows [Skarha et al.
(2023)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0281389), a
case-crossover study of heat-related mortality in U.S. state and private prisons (2001–2019).
For every 10°F a day's high rose above a prison's own average summer high, the risk of death
rose about 5% (5.2%; 95% CI 1.5–9.0%). Anchoring to each facility's own normal is what makes
the metric meaningful everywhere: a 95°F day is unremarkable in Blythe but a genuine health
emergency in Crescent City, and only a relative comparison captures that.

**Why daily maximum temperature and not heat index.** Skarha et al. used daily maximum
temperature, and tested heat index and wet-bulb globe temperature as alternatives, finding
they did not better capture the relationship between heat and mortality. We keep daily maximum
temperature as the comparison metric for fidelity to that calibration. (Apparent temperature /
"feels like" may appear later as secondary context.)

## Reading the map

On the statewide map, each facility is a dot **colored by its most recent temperature reading**
on a standard weather-map scale — cool blues and greens through hot oranges and reds. A dot is
**ringed** when that facility's latest daily high reaches the comparison line — 10°F or more above
its summer normal. The dot color is absolute temperature; the ring is the relative,
health-calibrated signal.

## Data sources

All temperature data is **observation-anchored** — drawn from station-based products, read
directly, rather than from a global reanalysis model. This matters in California: reanalysis
models (such as ERA5) do not resolve the marine layer that cools the coast and the Salinas
Valley, and read some facilities 5–10°F too warm. The products below capture those
microclimates. The two gridded climate products — PRISM and RTMA/URMA — are read through
[Google Earth Engine](https://earthengine.google.com/); the current-conditions readings come
straight from the National Weather Service and EPA.

| What | Source | Resolution | Role |
|---|---|---|---|
| **Baseline** — 1991–2020 Jun–Aug mean daily high, per facility | [PRISM Climate Group 30-year Normals](https://prism.oregonstate.edu/normals/) (`tmax`), Oregon State University, via Google Earth Engine | 800 m | Sets each facility's comparison line (baseline + 10°F) |
| **Current-day high** — today's expected high | [NWS National Digital Forecast Database](https://weather-gov.github.io/api/gridpoints) via `api.weather.gov` | ~2.5 km | Same-day reading |
| **Last 14 days, hourly** and the **10-year historic band** (2016–2025) | NOAA [Real-Time / Un-Restricted Mesoscale Analysis (RTMA/URMA)](https://www.nco.ncep.noaa.gov/pmb/products/rtma/), via Google Earth Engine | 2.5 km hourly | Detail-page chart |
| **Temperature now** (detail page) | Nearest [NWS](https://www.weather.gov/documentation/services-web-api) observation station, fetched live in your browser | station | Current-conditions tile |
| **Current air quality** | [AirNow](https://docs.airnowapi.org/) (EPA, monitor-based NowCast AQI) | monitor network | AQI tile |
| **Facilities** — locations, jurisdiction, boundaries | FEMA / HIFLD "Prison Boundaries" (July 2025), with CDCR additions | — | Which facilities, where |
| **CDCR population, cooling, vulnerability** | CDCR & CCHCS public data (see the [ca_prison_climate_justice](https://github.com/mbecica/ca_prison_climate_justice) repo) | — | CDCR-only detail panels |

The committed data files hold **raw observations only** — today's high, the recent hourly
series, air quality, the historic band. Whether a facility has reached the comparison line, and by
how many degrees, is computed in your browser by comparing those observations against it. That
keeps the comparison a display-time choice: it can change without re-collecting a single reading.

## Limitations

- **Product consistency.** The baseline (PRISM) and the displayed temperatures (RTMA/URMA) are
  different observation-anchored products, so a small (roughly 1–2°F) systematic offset between
  the comparison line and the plotted temperatures is possible. It is far smaller than the ~9°F
  error a reanalysis model would introduce at coastal sites.
- **Grid resolution.** RTMA/URMA is ~2.5 km and PRISM is 800 m — fine for most facilities, but
  any gridded product can still miss very local effects (a narrow canyon, a specific building).
- **Update cadence.** The recent-conditions data is refreshed on a schedule, so the pipeline's
  "temperature now" can lag by several hours; each detail page tops it up with a live reading
  from the nearest NWS station on load, and stamps the time each value was observed.
- **Facility list vintage.** The facility list is a July 2025 HIFLD snapshot; a facility that
  opened or closed since may be missing or stale.
- **Non-CDCR data gaps.** Population, cooling, and vulnerability details exist only for CDCR
  state prisons; county, federal, and local facilities show location and current conditions only.
- **AQI staleness.** Air quality follows the update job's cadence (a few hours), and reflects the
  nearest EPA monitor, which may be some distance from a rural facility.

## Attribution

PRISM data courtesy of the PRISM Climate Group, Oregon State University. NWS NDFD, RTMA, and
URMA are public-domain products of NOAA / the National Weather Service. Air quality data from
the U.S. EPA AirNow program. Facility locations from FEMA / HIFLD.
