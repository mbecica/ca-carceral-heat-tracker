# CA Carceral Facility Heatwave Tracker — Product Scope & Development Plan

v0.3 — July 17, 2026. Companion app to the [Prison Heat Index](https://marybecica.com/prison-heat-index/); shows which California carceral facilities are **currently** in a heatwave, with historic context. **v0.3 change:** heat data source switched off ERA5/Open-Meteo to an observation-anchored PRISM + NWS NDFD + RTMA/URMA stack (§2 decision log); the ERA5 baselines and partial bands from the first Phase 1 pass are superseded.

Decisions made July 16, 2026: threshold = relative +10°F (option A) · AQI = AirNow · chart history = envelope band · delivery = 3-hour cron + rebuild, with an R2 checkpoint at launch · app gets its own repo (`ca-carceral-heat-tracker`) and Cloudflare Pages project, suggested URL `heat.marybecica.com` · **UI language: phases 1–3 never use the word "heatwave"** — the threshold is described literally ("10°F above the 1991–2020 summer average high"); naming/definition framing deferred while Mary collects colleague feedback for a future phase.

## At a glance

| Item | Scope |
|---|---|
| Core question answered | Which CA carceral facilities are in a heatwave right now, how severe, and for how long? |
| Coverage | All **active** CA carceral facilities (~354): 188 county, ~84 state, 54 local, 28 federal (incl. ICE), 3 multi-jurisdiction; juvenile included |
| Pages | Statewide map + table (search + **jurisdiction filter**) · ~354 facility detail pages with unique URLs · Methods & data sources page (footer-linked) |
| Live data | Current temperature + current AQI per facility; last 14 days of hourly temps |
| Historic context | Per-facility heatwave threshold from a 1991–2020 baseline; 10-year historic band for the same 2-week calendar window |
| Threshold status | Over/under + consecutive-days counter; link out to NWS point forecast (no in-app forecast) |
| UI language (phases 1–3) | No use of the word "heatwave" anywhere user-facing; the threshold is stated literally. Site working title avoids it too (e.g., "California Carceral Facility Heat Tracker") |
| CDCR extras | Housing-unit cooling pie chart + population vulnerability stats (reused from Prison Heat Index) |
| New infrastructure | Scheduled fetch job (GitHub Actions cron) writing JSON; Cloudflare Pages rebuild |
| Repositories | App + live pipeline **and static data builds** all in this `ca-carceral-heat-tracker` repo (`pipeline/`); it reads the facility CSVs from the sibling `ca_prison_climate_justice` as inputs; personal website repo untouched |
| Maintenance | Base-data refresh 2–3×/year via runbook (§7): CDCR population/vulnerability re-scrapes, HiFLD facility list, envelope +1 yr post-season |
| Tech reuse | PHI standalone shell, CSS tokens, Leaflet maps, footer/methods pattern, per-facility Hugo stubs; D3 v7 (already vendored) for the hourly chart |

**Non-goals:** weather forecasts (link out instead), historic AQI, recomputing the heat risk index, vulnerability/cooling data for non-CDCR facilities (does not exist in any current source), closed facilities.

---

## 1. Heatwave definition — decided: relative +10°F (option A)

The threshold drives the whole UX (map colors, status badge, streak counter). Candidates considered:

| Option | Definition | Pros | Cons |
|---|---|---|---|
| **A. Relative (+10°F)** (recommended) | Daily tmax ≥ facility's 1991–2020 Jun–Aug mean tmax + 10°F | Mortality-calibrated for prisons (Skarha et al. 2023); locally meaningful everywhere, so a Crescent City heatwave and a Blythe heatwave both register | Needs a per-facility baseline; requires a sentence of explanation |
| B. Flat 90°F | Daily tmax ≥ 90°F | Matches CDCR Stage I heat-activation trigger; zero explanation needed | Meaningless in the deserts (always on all summer) and on the coast (never on); says nothing about *unusual* heat |
| C. NWS active alerts | Facility inside an active Heat Advisory / Extreme Heat Warning polygon | The official public definition; zero methodology burden; free API (api.weather.gov) | Binary, criteria vary by forecast office and aren't transparent; adds a live dependency; alert ≠ observation |
| D. CalHeatScore | OEHHA's 0–4 heat-health score by ZIP | State-official, health-based | No documented public API; ZIP granularity; forecast-based rather than observed |

**Decided (Jul 16, 2026): A is the primary definition**, with B shown as a secondary stat on detail pages ("N days ≥ 90°F this summer" has operational meaning since it's the CDCR activation trigger), and optionally a small NWS alert badge (C) on detail pages as corroboration. One primary definition keeps the map legend honest.

**UI language rule (decided Jul 16, 2026):** through phases 1–3, the user-facing app never uses the word "heatwave" or claims any definition of one. The threshold is presented as exactly what it is — "10°F above this facility's 1991–2020 summer average high" — with statuses like "over threshold" and "N days over." Which public framing to adopt ("heatwave," NWS alert language, CalHeatScore, or none) is deferred to a future phase, informed by colleague feedback Mary is collecting. This document keeps "heatwave" internally as shorthand for the concept; none of it ships as copy. The optional NWS alert badge is unaffected — "Heat Advisory" is NWS's own label for their product, not our definition.

Mechanics under option A:

- "In heatwave" = today's (or the most recent complete day's) max temp over the facility threshold, using America/Los_Angeles day boundaries.
- Streak = consecutive days at/over threshold, counted from the 14-day window (capped display: "14+ days").
- Severity display = °F over threshold and streak length; map color ramp can encode either (recommend streak).

## 2. Data sources — **revised Jul 17, 2026** (all-NWS/PRISM observation-anchored stack)

The original plan used Open-Meteo (ERA5 baseline + forecast live). Investigation on Jul 17
found that ERA5/Open-Meteo reads coastal and marine-valley facilities **~5–10°F too warm**
because it doesn't resolve the marine layer at any resolution (it's a reanalysis *model*,
not station-anchored). At Soledad (CTF/SVSP) ERA5-Land read 86.8°F where both gridMET (4 km,
station-anchored) and the NWS forecast read ~77°F. Going finer *within* ERA5 (31 km → 9 km)
made it worse, confirming this is a model-type difference, not a grid-size one. See the
decision log at the end of §2.

Requirements that drove the switch: temperatures shown must be **observation-anchored**
(accurate at each point's microclimate), read **directly from a source** (no bias-correction
or derived display values), **same-day** for the current reading, and **full-coverage** for
all 357 CA points. The resulting stack — all one observation-anchored NWS/PRISM family, so
baseline, live, and history agree instead of showing a seam:

| Data | Source | Notes |
|---|---|---|
| **Baseline** (1991–2020 Jun–Aug mean daily-max, per facility) | **[PRISM 30-yr Normals](https://prism.oregonstate.edu/normals/)** (`tmax`, 800 m, station-anchored) — read the Jun/Jul/Aug mean-max normals directly, average the three | One-time. Finest available; published *directly* as a normal (no 30-yr computation on our side) |
| **Current-day reading** (today's expected high, status/streak) | **[NWS NDFD](https://weather-gov.github.io/api/gridpoints)** (`api.weather.gov` gridpoint, ~2.5 km) — daytime high read directly | Same-day, keyless, full coverage. Reads microclimates correctly (76–78°F at Soledad). Forecaster-adjusted product, not raw model |
| **Recent 14-day hourly + 10-yr historic band** | **[RTMA/URMA](https://www.nco.ncep.noaa.gov/pmb/products/rtma/)** (2.5 km hourly analysis; URMA = QC'd version for past days) via **[Google Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/NOAA_NWS_RTMA)** point query | ⚠ **must test GEE access before committing** (§8 gate). GEE returns the value at a lat/lon directly; free non-commercial, needs an account + auth in the job. Band uses 2016–2025 (RTMA era) |
| Current AQI | **[AirNow API](https://docs.airnowapi.org/webservices)** (EPA monitor NowCast; free key; 500 calls/hr; server-side) — unchanged | key added as `AIRNOW_API_KEY` Actions secret |
| NWS forecast link | Plain URL — `forecast.weather.gov/MapClick.php?lat={lat}&lon={lon}` | Free, no API |
| Facilities | `ca_facilities.csv` (FEMA/HiFLD, 357 rows, `status = OPEN`); CDCR extras from `cdcr_facilities.csv` | In `ca_prison_climate_justice` |

**Consistency caveat for the methods page.** PRISM (baseline) and RTMA/URMA (display) are
different observation-anchored products, so a small (~1–2°F) systematic offset between the
threshold line and the plotted traces is possible — nowhere near the ~9°F ERA5 gap, since
both are station-anchored. Spot-check at ~5 facilities across climate zones before launch
and disclose any residual offset. NDFD (current-day) is heavily anchored to RTMA, so those
two agree by construction.

**AQI caveat (unchanged):** AirNow is real monitor data but needs a secret key (server-side
only; staleness follows the 3-hour job). Decided for credibility; "current AQI" tolerates a
few hours' staleness better than "current temperature" does.

### Decision log — heat data source (Jul 17, 2026)

- **Rejected: ERA5 / Open-Meteo** (original plan). Reanalysis model; reads coastal/marine-valley
  sites ~5–10°F too warm; finer ERA5 didn't help. Fails the observation-anchored requirement.
- **Baseline resolution finding:** Skarha et al. 2023 calibrated the +10°F metric on ~12 km
  NLDAS-2 daily *max* temperature and found heat index / WBGT did **not** improve mortality
  prediction — so we keep **daily max temperature** (not heat index) as the threshold metric.
  Heat index (`apparent_temperature`) may appear later as a secondary "feels like" display only.
- **Empirical check (3 facilities):** at Soledad, NWS forecast 76–78 and gridMET 77 agreed;
  ERA5-Land 86.8 and Open-Meteo ~85 were ~9°F high. At a flat control (Wasco) all agreed.
- **gridMET** (4 km) was the accurate fallback baseline but lags 1–3 days (fails same-day) and
  is a different product from PRISM; **PRISM normals** chosen for the baseline (finest, published
  directly). RTMA/URMA chosen for same-day observed hourly (only accurate full-coverage option;
  station obs has coverage gaps — Soledad returned no nearby station).

## 3. Architecture

**Repositories (decided Jul 16, 2026).** The app gets its own repo, `ca-carceral-heat-tracker`, with its own Cloudflare Pages project on a short subdomain (suggested: `heat.marybecica.com`; repo name and URL are independent, and the domain can change anytime). Rationale: unlike the Prison Heat Index (31 static pages, ~annual data refresh, fine as a prototype inside the personal site), this app carries live infrastructure — a 3-hour cron, ~2,900 machine commits/year, an API secret, ~354 generated pages — that shouldn't churn the personal website's git history or trigger its rebuilds. The PHI code was written with portability seams for exactly this. **Update (Jul 17, 2026):** the tracker's static data builds live in *this* repo (`pipeline/`), not in `ca_prison_climate_justice` — that repo is purely an open-data *input* the builds read as a sibling checkout (its `ca_facilities.csv` / `cdcr_facilities.csv`). The app repo owns its whole pipeline (static builds + live fetch + deployed data + slug registry); the open-data repo stays untouched by app tooling. The personal website is untouched apart from optional cross-links. Cloudflare's 500 builds/month quota is account-wide, so the tracker's ~240/month still leaves ample headroom for the personal site.

The app is static Hugo on Cloudflare Pages, so "current" means a scheduled pipeline, client-side fetches, or both. Constraint: the **500 builds/month** account quota means hourly rebuilds (720/mo) don't fit.

Recommended hybrid:

1. A scheduled job (GitHub Actions cron, every 3 hours ≈ 240 builds/mo): a standalone Python script in the app repo reads the current-day high from NWS NDFD and the recent 14-day hourly from RTMA/URMA (via Google Earth Engine) for all facilities, computes daily tmax / status / streaks against the PRISM threshold, fetches AQI (AirNow, deduped by reporting area to stay under 500 calls/hr), and commits `static/data/statewide.json` + per-facility `static/data/recent/{slug}.json`. The commit triggers the Cloudflare Pages rebuild. On API failure the job keeps the last good files and stamps staleness.
2. A client-side top-up on detail pages only: one keyless NWS call on page load refreshes the "current temperature" tile so it's live rather than up to 3 hours old. Status is a daily quantity that doesn't change hour to hour, so the 3-hour cadence only affects the current-temp number, and this closes that gap.
3. Static data, built once in `ca_prison_climate_justice` and copied into the app repo app_export-style: facility master file with slugs and thresholds, plus per-facility historic band files.

**R2 delivery — committed (Jul 17, 2026), scheduled for Phase 4.** Pushing the JSON to
Cloudflare R2 and fetching it client-side decouples data freshness from site builds entirely
(true hourly updates, no build-quota draw on the shared 500/month account pool, cleaner git
history). Costs: new credentials, CORS setup, a card on the Cloudflare account (R2 free tier
requires one), and losing the server-rendered statewide table + the git provenance log of
snapshots. Decided: **start on cron + rebuild for MVP, then migrate delivery to R2 at Phase 4**
(not just "revisit"). The JSON contracts are identical either way, so the swap is cheap and
non-blocking; building on commits first keeps the MVP simple and gives a git snapshot history
during validation.

**Data volumes** (rough): statewide.json ≈ 354 rows × ~10 fields ≈ 100 KB; per-facility recent.json ≈ 336 hourly points ≈ 10–15 KB; per-facility historic band ≈ 5–10 KB. All comfortable for static hosting.

## 4. Historic context on the chart — decided: envelope band

"Same 2-week window across the last 10 years" is 10 traces × 336 hourly points — spaghetti. Options:

- **Envelope band (recommended):** precompute per-facility hourly percentiles (p10/median/p90) from RTMA/URMA across 2016–2025 (the RTMA era) for each hour of the Jun–Oct season; the chart slices the current 2-week window and draws current trace + shaded historic band + threshold line. Same observed source as the recent trace, so they align. Small files, legible, and "you are here vs. the last decade" reads instantly.
- Spaghetti: all 10 years as faint lines. Honest but noisy; heavier files.
- Defer: MVP ships current trace + threshold line only; band added in a later phase.

## 5. Page specifications

### Statewide page (`/` on the app subdomain)

- Headline stat: "**N** facilities are 10°F or more above their historic summer highs today" + as-of timestamp (per the §1 UI language rule — no "heatwave").
- Leaflet map (reuse PHI's theme-aware CARTO setup): ~354 small fixed-size dots (population is too sparse outside CDCR to size by it), colored by status: over threshold (ramped by streak), under, or no data. Boundary polygons at high zoom, as in PHI.
- Table (server-rendered, client-sorted like PHI): name, county, jurisdiction, today's max, threshold, °F over, streak days. Cross-highlighting with the map, click → detail page.
- Controls: existing PHI search box **plus a new jurisdiction filter** (County / State / Federal / Local — chips or a select, filtering both table and map). Only active facilities are in the data at all (filtered at build).

### Detail page (`/{slug}/`)

Per-facility Hugo stubs generated by the export script (PHI pattern, scaled from 31 to ~354). Slugs = kebab-case name + county where needed to dedupe (county jails repeat names like "Main Jail").

- **Overview grid** (PHI `phi-meta__grid` pattern): jurisdiction, facility type, security level, address (Google Maps link), population + capacity where available (sparse outside CDCR; omit the row when null and note the data vintage), year opened (CDCR only).
- **Status hero**: over/under threshold badge, threshold value with plain-language explainer, streak counter ("over threshold 4 days so far"), today's max.
- **Current conditions tiles**: temperature now (client-side top-up), AQI now (EPA color scale).
- **Hourly chart (D3)**: last 14 days hourly line, historic band per §4, horizontal threshold line, day gridlines. The one genuinely new frontend component.
- **Forecast link-out**: "7-day forecast for this location → NWS" (MapClick URL).
- **CDCR facilities only**: housing-unit cooling pie (PHI's conic-gradient component + `profile.cooling` fields) and the vulnerability madlib sentences with `phi-stat` tooltips — both lift directly from PHI. Cross-link to the facility's Prison Heat Index profile.
- Footer with Methods & sources link (PHI footer partial pattern).

### Methods & data sources page

PHI `methodology.html` pattern. Contents: the threshold stated factually with its research rationale (cite Skarha et al. 2023 — describing what the threshold is and why, without branding it a "heatwave" definition, per §1), the source table from §2, update cadence and staleness behavior, and limitations (the PRISM-vs-RTMA/URMA product offset, RTMA's ~2.5 km resolution, the AQI monitor-vs-model choice, the July 2025 vintage of the HiFLD facility list, and sparse undated population data outside CDCR). The methods/sources documentation is seeded in `METHODS.md`.

## 6. Pipeline specification

**Static builds (`ca_prison_climate_justice/analysis/heatwave_app/`), run at launch and rerun at each base-data refresh (§7):**

1. `build_facilities.py` — filter `ca_facilities.csv` to OPEN, generate deduped slugs, join CDCR extras (code, year opened, population, cooling, vulnerability), emit facility master JSON + per-facility Hugo content stubs into the app repo (mirrors `build_app_data.py`). ✅ built (source-agnostic; unaffected by the source switch).
2. `build_baselines.py` — 1991–2020 Jun–Aug mean daily-max per facility from **PRISM 30-yr `tmax` normals** (average the Jun/Jul/Aug mean-max normals); emit per-facility threshold into the master JSON. ⚠ **to rewrite** — the current version pulls ERA5 (superseded); the ERA5 `baselines.csv` it produced is now throwaway.
3. `build_historic_bands.py` — hourly percentile band per facility per hour-of-season from **RTMA/URMA 2016–2025** (via Google Earth Engine); one small JSON per facility. ⚠ **to rewrite** — current version pulls ERA5 (superseded); the 22 ERA5 band files already generated are throwaway.

**Scheduled job (app repo, GitHub Actions cron every 3 h):**

4. `fetch_current.py` — NWS NDFD current-day high + RTMA/URMA recent 14-day hourly (via GEE) per facility, daily tmax + status + streak against the PRISM threshold, AirNow AQI deduped by reporting area; writes `statewide.json` + `recent/{slug}.json`; keeps last good data on failure; commits, which triggers the Cloudflare Pages build.

All scripts, not notebooks, so cron can run them; PT day boundaries throughout. **The source switch (Jul 17, 2026) supersedes the ERA5/Open-Meteo baselines and bands already generated — see §2 decision log; scripts 2–3 get rewritten once the GEE-access gate (§8) passes.**

## 7. Base-data refreshes (2–3× per year)

`ca_prison_climate_justice` gets re-scraped occasionally and those updates flow through to the app — population is the most visible field, but vulnerability stats, capacity, and the facility list itself all drift. The refresh is a manual, runbook-driven process (the scrapers are interactive Playwright/PDF jobs that can't run unattended).

The runbook is a **repo-level `REFRESH.md` at the root of `ca_prison_climate_justice`** (a Phase 1 deliverable), not a heat-app-specific document. It covers every data family in that repo — organized as scraper(s) → rebuild notebook/script → `data/` output → downstream consumers — so refreshing, say, CDCR population tells you everything to rebuild afterward: the heatwave tracker's static builds, the Prison Heat Index `app_export` (which currently has no documented refresh procedure), and any capstone analyses. The heat app's steps below are one short section of that document rather than a separate file, so the two can't drift apart.

**Versioning.** Each output in REFRESH.md is classified as one of two kinds, and a refresh must never blur the line:

- **Living datasets** (facility list, current population, CCHCS tiers) are refreshed in place; their currency is tracked with as-of stamps.
- **Vintaged analyses** (the 2025 heat risk index that PHI consumes, `days_indoor_above_78f_2025`, `air_cooling_*_dec2025.csv`, and similar) are frozen. A refresh produces a *new* vintage alongside the old one rather than overwriting it, and downstream consumers keep reading their pinned vintage until deliberately re-exported. The repo already leans this way informally — vintages embedded in filenames and column names — and REFRESH.md formalizes it as the convention. Each refresh also gets a git tag (e.g., `refresh-2027-04`) as a whole-repo fallback for anything not vintage-named.

The classification of every existing output (frozen vs. living) is a judgment call about how each analysis is used, so the REFRESH.md draft goes to Mary for review before it's adopted — that review is part of the Phase 1 deliverable, not an afterthought.

### Cadence

- **Pre-season (April–May), the main refresh:** re-scrape CDCR population (`extract_tpop1.py`) and CCHCS vulnerability dashboards (`fetch_cchcs_*.js`), re-download the HiFLD facility list to catch openings/closures, rebuild `cdcr_facilities.csv`, rerun the static builds. The site enters heat season with current numbers.
- **Post-season (November–December):** population touch-up, plus the annual climate refresh folded in — `build_historic_bands.py` rolls the 10-year envelope window forward by the season just ended. (Baselines don't refresh: the 1991–2020 window is fixed by definition.)
- **Optional mid-season (July–August):** only if something notable happens — a closure, a large population move, or new cooling data from CDCR.

### What flows through

| Data group | Source / scraper | Refresh behavior |
|---|---|---|
| CDCR population + capacity | TPOP-1 reports via `extract_tpop1.py` | Every refresh |
| CDCR vulnerability (CCHCS tiers, EOP, DPP, age) | `fetch_cchcs_*.js` Playwright scrapers | Pre-season at minimum |
| CDCR cooling types | CDCR reports / FOIA — irregular releases | Manual, when new data appears |
| Facility list (all CA) | HiFLD re-download + `create_facilities` rebuild | Pre-season |
| Historic envelope | `build_historic_bands.py`, rolling 10-yr window | Post-season only |
| Thresholds / baselines | Fixed 1991–2020 window | Never (definitional) |

### Process (the heat-app section of the root REFRESH.md)

1. Run the relevant scrapers in `ca_prison_climate_justice` per the generic per-family instructions (the slow, human-in-the-loop part).
2. Rebuild `data/cdcr/cdcr_facilities.csv` and (pre-season) `ca_facilities.csv`.
3. Rerun `build_facilities.py`, and scripts 2–3 in `--only-missing` mode if the facility list changed.
4. Review the git diff in the app repo — it shows exactly which facilities' numbers changed, which is the sanity check.
5. Commit both repos; the app commit triggers the Cloudflare Pages rebuild and the refresh is live.

Estimated effort once the runbook exists: about half a session, dominated by scraper runtime.

### Engineering requirements this puts on the Phase 1 scripts

- **Stable slugs.** A persistent `facilityid → slug` registry (`slugs.csv`, committed) so detail-page URLs never change across refreshes, even if HiFLD renames a facility.
- **Declarative stub management.** `build_facilities.py` owns the app repo's content directory: it adds stubs for new facilities, deletes orphans for closed ones, and appends a Cloudflare `_redirects` line from each removed facility's URL to the home page so old links don't 404.
- **Incremental climate builds.** `build_baselines.py` and `build_historic_bands.py` take `--only-missing`, so two new facilities don't force re-pulling ERA5 for all ~354.
- **Vintage stamping.** The facility master JSON carries as-of dates per field group (`population_as_of`, `cooling_as_of`, `facility_list_as_of`); the overview grid and methods page render vintages from the data, so refreshes update the displayed dates without touching templates.
- **Decoupled live pipeline.** `fetch_current.py` just reads the master file — new or removed facilities are picked up on the next 3-hour run with no changes to the workflow.

## 8. Development phases

| Phase | Work | Depends on | Rough size |
|---|---|---|---|
| **0. Decisions** | Threshold definition, AQI source, refresh architecture, band rendering, repo + URL | — | done Jul 16, 2026 |
| **0b. Heat-source re-decision** | Switched off ERA5/Open-Meteo → PRISM baseline + NWS NDFD current + RTMA/URMA (GEE) hourly (§2 decision log) | — | done Jul 17, 2026 |
| **1. Data foundation** | `build_facilities.py` ✅ + slug registry + REFRESH.md ✅ (reviewed/adopted). **Gate: test RTMA/URMA point access via Google Earth Engine** (auth in job, value returned at a lat/lon, agrees with NDFD) before committing the pipeline. Then rewrite `build_baselines.py` (PRISM) + `build_historic_bands.py` (RTMA/URMA); one-time PRISM-vs-RTMA offset spot-check at ~5 facilities | 0, 0b | 2–4 sessions |
| **2. Live pipeline** | Script 4 (NDFD + RTMA/URMA + AirNow) + GitHub Actions workflow + secrets (GEE service-account key, `AIRNOW_API_KEY` ✅); failure/staleness handling; first data landing in the app repo | 1 | 2–3 sessions |
| **3. Frontend** | Scaffold app repo as a minimal Hugo site + Cloudflare Pages project + subdomain; port PHI shell (new CSS namespace); statewide map + table + jurisdiction filter; detail page; D3 hourly chart; methods page | 1 (can start on static data before 2) | 3–5 sessions |
| **4. Validate & launch** | Spot-check thresholds vs. NWS alerts during a hot spell; dataset-offset check (§2); mobile + accessibility pass; methods prose; delivery checkpoint (stay on commits vs. switch to R2); launch | 2, 3 | 1–2 sessions |

**Suggested MVP cut line** (end of a lean Phase 3): statewide map/table with statuses + detail pages with current temp, 14-day chart, and threshold line. The historic band, AQI tile, NWS badge, and CDCR extras layer on afterward without rework — each is an isolated component reading its own JSON.

## 9. Risks & accepted limitations

- The facility list is a July 2025 HiFLD snapshot; some facilities may have opened or closed since. Acceptable for launch, with the vintage noted on the methods page.
- Non-CDCR attributes are sparse: population is known for only ~68 non-CDCR facilities, and year opened, cooling, and vulnerability data don't exist for them. The UI omits empty rows rather than showing gaps.
- RTMA/URMA is ~2.5 km — good for California's coastal/valley microclimates, and far better than the ERA5 ~9–31 km it replaced (which read Soledad ~9°F too warm; see §2). PRISM (baseline) is 800 m. Residual PRISM-vs-RTMA product offset is spot-checked and disclosed.
- Google Earth Engine (RTMA/URMA access) is free for non-commercial/research use but requires an account + a service-account key in the Actions job; the GEE-access gate (§8) de-risks this before build.
- PRISM and NWS data are public-domain US-government/university products; attribute on the methods page.
- The 3-hour cadence stays within Cloudflare's 500 builds/month with headroom for content pushes. R2 is the documented escape hatch if the cadence needs to tighten.
