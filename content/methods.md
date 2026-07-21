---
title: "Methods & Sources"
type: methods
url: "/methods/"
summary: "How the California Carceral Facility Heat Tracker measures heat and air quality, where its data comes from, and the limits of a version 0.1 tool built on public data."
---

## About this tracker

This tool tracks how hot it currently is at California prisons, jails and other carceral facilities, measured against that facility's own long-term historic summer temperatures. It was built to help advocates highlight heat events in California prisons and bring attention to this public-health and human-rights crisis, in support of the Climate Justice Coalition for California Prisons. This project acknowledges and extends the work of [The Toxic Prisons Mapping Project](https://www.toxicprisons.com/).

**This is version 0.1.** The California Carceral Facility Heat Tracker has not yet been tested or validated by incarcerated or formerly incarcerated people, and the tool relies entirely on publicly available datasets, which come with their own limitations. Until engagement, feedback, and further iteration have occurred, this tool should not be treated as an authoritative source. If you see an issue or want to provide feedback, please let us know by emailing Mary or filing a Github Issue. Your input is greatly appreciated. If your organization would like to support launching this prototype into a public tool, please email Mary.

## How heat and air quality are measured

Temperature Thresholds:

- Each facility's historic annual average summer maximum temperature is calculated from its 1991–2020 June–August average daily maximum (PRISM Climate Group). A heatwave is typically considered 2+ consecutive days where temperatures exceed this historic average (source). 
- 10°F above a facility's historic summer average is highlighted to align with Skarha et al. (2023)'s finding: across U.S. state and private prisons, every 10°F above a prison's own summer average was associated with a 5.2% rise in all-cause mortality that day.

Air quality:

- The tracker shows the current AirNow Air Quality Index (AQI) for the nearest EPA monitor, reflecting ground-level ozone and fine particulate pollution.
- Heat and air pollution compound each other. Hotter days worsen ground-level ozone and trap particulates, and combined exposure raises mortality and worsens respiratory and cardiovascular conditions (Rahman et al., 2022; Schwarz et al., 2021; Li et al., 2025).

## Where the data comes from

All temperature data comes from station-based products based on observed temperatures. This matters in California, where reanalysis models like ERA5 miss the marine layer that cools the coast and can read some facilities 5–10°F too warm. The two gridded climate products, PRISM and RTMA/URMA, are read through Google Earth Engine; the current-conditions readings come from the National Weather Service and EPA.

| What | Source | Resolution | Role |
|---|---|---|---|
| Baseline: 1991–2020 Jun–Aug mean daily high, per facility | PRISM Climate Group 30-year Normals (`tmax`), Oregon State University, via Google Earth Engine | 800 m | Sets each facility's comparison line (historic average + 10°F) |
| Current-day high | NWS National Digital Forecast Database (`api.weather.gov`) | ~2.5 km | Same-day reading |
| Last 14 days, hourly, and the 2016–2025 historic band | NOAA Real-Time / Un-Restricted Mesoscale Analysis (RTMA/URMA), via Google Earth Engine | 2.5 km hourly | Detail-page chart |
| Temperature now | Nearest NWS observation station, fetched live | station | Current-conditions reading |
| Current air quality | AirNow (EPA, monitor-based NowCast AQI) | monitor network | AQI |
| Facilities: locations, jurisdiction, boundaries | FEMA / HIFLD Prison Boundaries (July 2025), with CDCR additions | — | Which facilities, where |
| CDCR population, cooling infrastructure, vulnerability indicators | CDCR and CCHCS public data | — | CDCR state prison panels |

*Data credits: PRISM data courtesy of the PRISM Climate Group, Oregon State University. NWS, RTMA, and URMA are public-domain products of NOAA / the National Weather Service. Air quality data from the U.S. EPA AirNow program, which does not endorse derived products. Facility locations from FEMA / HIFLD.*

## Additional data for CDCR state prisons

CDCR state prisons show additional data on their populations, cooling infrastructure, and heat-vulnerability indicators. Comparable data may exist for state fire camps, county jails or other systems, but were not in scope for this version of the tool.

These indicators are only as good as the public data CDCR releases, which has many limitations. In particular, CDCR has not published facility-level counts of who it designates heat-vulnerable under its heat plan. In place of those counts, the tracker uses demographic shares as proxies: the share of people who are 50 or older, in the Disability Placement Program, receiving enhanced outpatient mental-health care, in a medium-or-higher medical-risk category, or people of color. Each is drawn from 2025 CDCR and CCHCS public data. The hover text on each indicator explains why that group faces elevated heat risk.

## Data availability

The facility-level hazard, exposure, and vulnerability data behind this tool is published as an open dataset for researchers, advocates, and policymakers: [github.com/mbecica/ca_prison_climate_justice](https://github.com/mbecica/ca_prison_climate_justice).

## References

Brunn, K., Toledo, O., Tran, C. C., Vasudevan, A., & Venkat, B. J. (2025). Carceral heat exposure as harmful design: An integrative model for understanding the health impacts of heat on incarcerated people in the United States. *Social Science & Medicine, 367*, 117679. https://doi.org/10.1016/j.socscimed.2025.117679

California Correctional Health Care Services. (2025). *CCHCS health care services dashboard.* https://cchcs.ca.gov/dashboard/

Hamstead, Z. (2023). Thermal insecurity: Violence of heat and cold in the urban climate refuge. *Urban Studies, 61.* https://doi.org/10.1177/00420980231184466

Jackson, P., Larkin, D., Kinnie, K. R., & Aroke, E. N. (2022). Heat islands and chronic disease: Could African Americans be more vulnerable to heat-related health impacts? *Journal of the National Black Nurses Association, 33*(1), 33–39.

Kerrison, E. M. T. (2026). Thermal abandonment: Best practices to end correctional heat death for menopausal Black women in prison. *Journal of Correctional Health Care.*

Leach, O. K., Cottle, R. M., Fisher, K. G., Wolf, S. T., & Kenney, W. L. (2024). Sex differences in heat stress vulnerability among middle-aged and older adults (PSU HEAT Project). *American Journal of Physiology-Regulatory, Integrative and Comparative Physiology, 327*(3), R320–R330. https://doi.org/10.1152/ajpregu.00114.2024

Li, M., et al. (2025). Urban meteorology–chemistry coupling in compound heat–ozone extremes. *Nature Cities.* https://doi.org/10.1038/s44284-025-00302-1

Novisky, M. A., Prost, S. G., Fleury-Steiner, B., & Testa, A. (2025). Linkages between incarceration and health for older adults. *Health & Justice, 13*, 23. https://doi.org/10.1186/s40352-025-00331-x

Rahman, M. M., McConnell, R., Schlaerth, H., Ko, J., Silva, S., Lurmann, F. W., Palinkas, L., Johnston, J., Hurlburt, M., Yin, H., Ban-Weiss, G., & Garcia, E. (2022). The effects of coexposure to extremes of heat and particulate air pollution on mortality in California: Implications for climate change. *American Journal of Respiratory and Critical Care Medicine, 206*(9), 1117–1127.

Schwarz, L., Hansen, K., Alari, A., Ilango, S. D., Bernal, N., Basu, R., Gershunov, A., & Benmarhnia, T. (2021). Spatial variation in the joint effect of extreme heat events and ozone on respiratory hospitalizations in California. *Proceedings of the National Academy of Sciences.*

Singh, N., Areal, A. T., Breitner, S., Zhang, S., Agewall, S., Schikowski, T., & Schneider, A. (2024). Heat and cardiovascular mortality: An epidemiological perspective. *Circulation Research, 134*(8), 1098–1112. https://doi.org/10.1161/CIRCRESAHA.123.323615

Skarha, J., Spangler, K., Dosa, D., Rich, J. D., Savitz, D. A., & Zanobetti, A. (2023). Heat-related mortality in U.S. state and private prisons: A case-crossover analysis. *PLOS ONE, 18*(3), e0281389. https://doi.org/10.1371/journal.pone.0281389
