---
title: "Methods & Sources"
type: methods
url: "/methods/"
summary: "How the California Carceral Facility Heat Tracker measures heat and air quality, where its data comes from, and the limits of a version 0.1 tool built on public data."
---

## About this tracker

This tool tracks how hot it currently is outdoors at California prisons, jails and other carceral facilities, measured against that facility's own long-term historic summer temperatures. It was built to help advocates highlight heat events in California prisons and bring attention to this public-health and human-rights crisis, in support of the Climate Justice Coalition for California Prisons. This project acknowledges and extends the work of [The Toxic Prisons Mapping Project](https://www.toxicprisons.com/).

**This is version 0.1.** The California Carceral Facility Heat Tracker has not yet been tested or validated by incarcerated or formerly incarcerated people, and the tool relies entirely on publicly available datasets, which come with their own limitations. Until engagement, feedback, and further iteration have occurred, this tool should not be treated as an authoritative source. If you see an issue or want to provide feedback, please let us know by [emailing Mary](mailto:mary_becica@berkeley.edu?subject=CA%20Carceral%20Heat%20Tracker%20feedback) or [filing a Github Issue](https://github.com/mbecica/ca-carceral-heat-tracker/issues/new). Your input is greatly appreciated. If your organization would like to support launching this prototype into a public tool, please [email Mary](mailto:mary_becica@berkeley.edu?subject=Supporting%20the%20CA%20Carceral%20Heat%20Tracker).

## How heat and air quality are measured

Every temperature in this tool is an outdoor air temperature, both because that is the data available and to align with published research on the effects of heat (such as [violence](https://doi.org/10.3386/w28987), [illness](https://ellabakercenter.org/reports/hiddenhazards/), and [death](https://doi.org/10.1371/journal.pone.0281389)) in carceral environments. From the [limited data available on indoor temperatures](https://marybecica.com/essays/prison-heat-data/) at CDCR state prisons, we can confirm that [their buildings trap and amplify heat well beyond outdoor conditions](https://marybecica.com/essays/prison-heat-indoor-outdoor/). For other facility types, such as federal [ICE detention centers](https://bakersfieldnow.com/news/local/health-hazards-at-mcfarland-ice-facility-amid-summer-heatwave), [county jails](https://www.prisonlegalnews.org/news/2025/nov/1/californias-attorney-general-is-suing-los-angeles-county-jails-over-inhumane-conditions/) holding people [pretrial for long periods](https://calmatters.org/justice/2021/03/waiting-for-justice/), and fire camps, structured indoor temperature data is nearly nonexistent.

Temperature thresholds in v0.1:

- Each facility's historic annual average summer maximum temperature is calculated from its 1991–2020 June–August average daily maximum (PRISM Climate Group). 
- 10°F above a facility's historic summer average is highlighted to align with Skarha et al. (2023)'s finding: across U.S. state and private prisons, every 10°F above a prison's own summer average was associated with a 5.2% rise in all-cause mortality that day.

In practice, this threshold is more sensitive than how California defines heat events in communities: [Cal-Adapt](https://cal-adapt.org/) and [OEHHA](https://oehha.ca.gov/sites/default/files/media/epic/downloads/cc_ehe2018.pdf) count an "extreme heat day" as above the 98th percentile of a place's historic temperatures, a higher bar than the tracker's 10°F over the average at most facilities. As a result, the tracker flags more days than a percentile method would, especially at cooler coastal facilities.

Air quality:

- The tracker shows the current AirNow Air Quality Index (AQI) for the nearest EPA monitor, reflecting ground-level ozone and fine particulate pollution.
- Heat and air pollution compound each other. Hotter days worsen ground-level ozone and trap particulates, and combined exposure raises mortality and worsens respiratory and cardiovascular conditions (Rahman et al., 2022; Schwarz et al., 2021; Li et al., 2025).

## Where the data comes from

All temperature data comes from station-based products based on observed outdoor temperatures. The two gridded climate products, PRISM and RTMA/URMA, are read through Google Earth Engine. The latest outdoor temperature you see anywhere on the site comes from RTMA/URMA, as does the historic chart. The forecast high and the secondary nearest-station reading come from the National Weather Service, and air quality from EPA.

| What | Source | Resolution | Role |
|---|---|---|---|
| Baseline: 1991–2020 Jun–Aug mean daily high, per facility | PRISM Climate Group 30-year Normals (`tmax`), Oregon State University, via Google Earth Engine | 800 m | Sets each facility's comparison line (historic average + 10°F) |
| Latest outdoor temperature, last 14 days (hourly), and the 2016–2025 historic band | NOAA Real-Time / Un-Restricted Mesoscale Analysis (RTMA/URMA), via Google Earth Engine | 2.5 km hourly | Current outdoor temperature everywhere on the site, and the detail-page chart and historic band |
| Current-day forecast high | NWS National Digital Forecast Database (`api.weather.gov`) | ~2.5 km | Same-day forecast high |
| Nearest-station reading (secondary) | Nearest NWS observation station, fetched live | station | A fresher spot cross-check, shown as a note beside the latest outdoor temperature on detail pages |
| Current air quality | AirNow (EPA, monitor-based NowCast AQI) | monitor network | AQI |
| Facilities: locations, jurisdiction, boundaries | FEMA / HIFLD Prison Boundaries (July 2025), with CDCR additions | — | Which facilities, where |
| CDCR population, cooling infrastructure, vulnerability indicators | CDCR and CCHCS public data | — | CDCR state prison panels |

Reanalysis models like ERA5 were tested and set aside: at coastal facilities they miss the marine layer that cools the coast and read 5–10°F too warm.

**How often the data refreshes:**

| Data | Refresh |
|---|---|
| Current temperature, forecast high, air quality, and 14-day history | Every 6 hours |
| Nearest-station reading (detail pages) | Live, on each page load |
| 10-year historic band | Yearly, shifting the window forward once each year completes |
| Baseline and threshold (1991–2020 normal) | Fixed |
| Facility list and CDCR data | Before each summer season |

*Data credits: PRISM data courtesy of the PRISM Climate Group, Oregon State University. NWS, RTMA, and URMA are public-domain products of NOAA / the National Weather Service. Air quality data from the U.S. EPA AirNow program, which does not endorse derived products. Facility locations from FEMA / HIFLD.*

## Additional data for CDCR state prisons

CDCR state prisons show additional data on their populations, cooling infrastructure, and heat-vulnerability indicators. Comparable data may exist for state fire camps, county jails or other systems, but were not in scope for this version of the tool.

These indicators are only as good as the public data CDCR releases, which has many limitations. In particular, CDCR has not published facility-level counts of who it designates heat-vulnerable under its heat plan. In place of those counts, the tracker uses demographic shares as proxies: the share of people who are 50 or older, in the Disability Placement Program, receiving enhanced outpatient mental-health care, in a medium-or-higher medical-risk category, or people of color. Each is drawn from 2025 CDCR and CCHCS public data. The hover text on each indicator explains why that group faces elevated heat risk.

## Data availability

The tracker's source code is released under the MIT License, and its data under the Creative Commons Attribution 4.0 International License (CC BY 4.0), © 2026 Mary Becica. The code for this tool is available at [github.com/mbecica/ca-carceral-heat-tracker](https://github.com/mbecica/ca-carceral-heat-tracker).

The facility-level hazard, exposure, and vulnerability data behind this tool is published as an open dataset for researchers, advocates, and policymakers: [github.com/mbecica/ca_prison_climate_justice](https://github.com/mbecica/ca_prison_climate_justice).

## References

Abdala, A., Bhola, A., Gutierrez, G., Henderson, E., & O'Neill, M. (2023). *Hidden hazards: The impacts of climate change on incarcerated people in California state prisons.* Ella Baker Center for Human Rights. https://ellabakercenter.org/reports/hiddenhazards/

Brunn, K., Toledo, O., Tran, C. C., Vasudevan, A., & Venkat, B. J. (2025). Carceral heat exposure as harmful design: An integrative model for understanding the health impacts of heat on incarcerated people in the United States. *Social Science & Medicine, 367*, 117679. https://doi.org/10.1016/j.socscimed.2025.117679

Cal-Adapt. (n.d.). *Extreme heat days & warm nights* [Data tool]. Geospatial Innovation Facility, University of California, Berkeley. https://cal-adapt.org/

California Correctional Health Care Services. (2025). *CCHCS health care services dashboard.* https://cchcs.ca.gov/dashboard/

California Office of Environmental Health Hazard Assessment (OEHHA). (2018). *Extreme heat events.* In Indicators of climate change in California. https://oehha.ca.gov/sites/default/files/media/epic/downloads/cc_ehe2018.pdf

Hamstead, Z. (2023). Thermal insecurity: Violence of heat and cold in the urban climate refuge. *Urban Studies, 61.* https://doi.org/10.1177/00420980231184466

Jackson, P., Larkin, D., Kinnie, K. R., & Aroke, E. N. (2022). Heat islands and chronic disease: Could African Americans be more vulnerable to heat-related health impacts? *Journal of the National Black Nurses Association, 33*(1), 33–39.

Kerrison, E. M. T. (2026). Thermal abandonment: Best practices to end correctional heat death for menopausal Black women in prison. *Journal of Correctional Health Care.*

Leach, O. K., Cottle, R. M., Fisher, K. G., Wolf, S. T., & Kenney, W. L. (2024). Sex differences in heat stress vulnerability among middle-aged and older adults (PSU HEAT Project). *American Journal of Physiology-Regulatory, Integrative and Comparative Physiology, 327*(3), R320–R330. https://doi.org/10.1152/ajpregu.00114.2024

Li, M., et al. (2025). Urban meteorology–chemistry coupling in compound heat–ozone extremes. *Nature Cities.* https://doi.org/10.1038/s44284-025-00302-1

Mukherjee, A., & Sanders, N. J. (2021). *The causal effect of heat on violence: Social implications of unmitigated heat among the incarcerated* (Working Paper No. 28987). National Bureau of Economic Research. https://doi.org/10.3386/w28987

Novisky, M. A., Prost, S. G., Fleury-Steiner, B., & Testa, A. (2025). Linkages between incarceration and health for older adults. *Health & Justice, 13*, 23. https://doi.org/10.1186/s40352-025-00331-x

Rahman, M. M., McConnell, R., Schlaerth, H., Ko, J., Silva, S., Lurmann, F. W., Palinkas, L., Johnston, J., Hurlburt, M., Yin, H., Ban-Weiss, G., & Garcia, E. (2022). The effects of coexposure to extremes of heat and particulate air pollution on mortality in California: Implications for climate change. *American Journal of Respiratory and Critical Care Medicine, 206*(9), 1117–1127. https://doi.org/10.1164/rccm.202204-0657OC

Schwarz, L., Hansen, K., Alari, A., Ilango, S. D., Bernal, N., Basu, R., Gershunov, A., & Benmarhnia, T. (2021). Spatial variation in the joint effect of extreme heat events and ozone on respiratory hospitalizations in California. *Proceedings of the National Academy of Sciences, 118*(22), e2023078118. https://doi.org/10.1073/pnas.2023078118

Singh, N., Areal, A. T., Breitner, S., Zhang, S., Agewall, S., Schikowski, T., & Schneider, A. (2024). Heat and cardiovascular mortality: An epidemiological perspective. *Circulation Research, 134*(8), 1098–1112. https://doi.org/10.1161/CIRCRESAHA.123.323615

Skarha, J., Spangler, K., Dosa, D., Rich, J. D., Savitz, D. A., & Zanobetti, A. (2023). Heat-related mortality in U.S. state and private prisons: A case-crossover analysis. *PLOS ONE, 18*(3), e0281389. https://doi.org/10.1371/journal.pone.0281389
