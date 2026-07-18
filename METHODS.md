# Methods & Data Sources

*California Carceral Facility Heat Tracker — seed for the public Methods & Sources page. Draft, July 17, 2026.*

This tracker shows how hot it currently is at each active California carceral facility,
relative to that facility's own long-term summer normal, with the last two weeks of hourly
temperature for context. It is a companion to the [Prison Heat Index](https://marybecica.com/prison-heat-index/).

## The temperature threshold

Each facility is compared against **its own** local climate, not a statewide number. The
threshold is:

> **facility's 1991–2020 June–August average daily high, plus 10°F.**

A day at or above that line is counted as "over threshold," and the tracker shows how many
consecutive days each facility has been over.

**Why +10°F, and why relative to each place.** This follows Skarha et al. (2023), a
case-crossover study of heat-related mortality in U.S. state and private prisons (2001–2019).
They found that for every 10°F a day rose above a prison's own mean summer temperature, the
risk of death rose about 5%. Anchoring to each facility's own normal is what makes the metric
meaningful everywhere: a 95°F day is unremarkable in Blythe but a genuine health emergency in
Crescent City, and only a relative threshold captures that.

**Why daily maximum temperature and not heat index.** Skarha et al. used daily maximum
temperature, and tested heat index and wet-bulb globe temperature as alternatives, finding
they did not better capture the relationship between heat and mortality. We keep daily maximum
temperature as the threshold metric for fidelity to that calibration. (Apparent temperature /
"feels like" may appear later as secondary context, not as the threshold.)

## Data sources

All temperature data is **observation-anchored** — drawn from station-based products, read
directly, rather than from a global reanalysis model. This matters in California: reanalysis
models (such as ERA5) do not resolve the marine layer that cools the coast and the Salinas
Valley, and read some facilities 5–10°F too warm. The products below capture those
microclimates.

| What | Source | Resolution | Role |
|---|---|---|---|
| **Baseline** — 1991–2020 Jun–Aug mean daily high, per facility | [PRISM Climate Group 30-year Normals](https://prism.oregonstate.edu/normals/) (`tmax`), Oregon State University | 800 m | Sets each facility's threshold (baseline + 10°F) |
| **Current-day high** — today's expected high, drives status & streak | [NWS National Digital Forecast Database](https://weather-gov.github.io/api/gridpoints) via `api.weather.gov` | ~2.5 km | Same-day reading |
| **Last 14 days, hourly** and the **10-year historic band** (2016–2025) | NOAA [Real-Time / Un-Restricted Mesoscale Analysis (RTMA/URMA)](https://www.nco.ncep.noaa.gov/pmb/products/rtma/) | 2.5 km hourly | Detail-page chart |
| **Current air quality** | [AirNow](https://docs.airnowapi.org/) (EPA, monitor-based NowCast AQI) | monitor network | AQI tile |
| **Facilities** — locations, jurisdiction, boundaries | FEMA / HIFLD "Prison Boundaries" (July 2025), with CDCR additions | — | Which facilities, where |
| **CDCR population, cooling, vulnerability** | CDCR & CCHCS public data (see the [ca_prison_climate_justice](https://github.com/mbecica/ca_prison_climate_justice) repo) | — | CDCR-only detail panels |

## Limitations

- **Product consistency.** The baseline (PRISM) and the displayed temperatures (RTMA/URMA) are
  different observation-anchored products, so a small (roughly 1–2°F) systematic offset between
  the threshold line and the plotted temperatures is possible. This is measured at sample
  facilities before launch and disclosed here. (It is far smaller than the ~9°F error a
  reanalysis model would introduce at coastal sites.)
- **Grid resolution.** RTMA/URMA is ~2.5 km and PRISM is 800 m — fine for most facilities, but
  any gridded product can still miss very local effects (a narrow canyon, a specific building).
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

*Sources and exact field definitions will be finalized as the pipeline is built; this document
is the working reference.*
