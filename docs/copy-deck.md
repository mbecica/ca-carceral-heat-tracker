# Copy deck — CA Carceral Facility Heat Tracker

Briefing doc for revising the site's user-facing prose. Paste this (or the parts
you're working on) into cowork.

**Two homes for copy — edit these files, the site picks them up on rebuild:**

- **Tooltips** → `data/copy.yaml` (keys match the ids below). Two placeholders get
  filled in at render time — leave them in the text: `{avg}` (a CDCR average count,
  e.g. "3,116") and `{pct}` (a CDCR average percentage, e.g. "75%").
- **Sources & Methods page** → `content/methods.md` (a standalone Markdown essay).

**Voice.** Fork a "website" profile from the "essays" profile: plain, precise,
humane, willing to name uncertainty and limits, never hype and never "heatwave"
framing. Tooltips are tighter than essay prose — lead with the fact, one citation
where a claim needs one, no throat-clearing openers.

---

## Tooltips

Each shows the id (its key in `data/copy.yaml`), where it appears, the data point
it explains, the current text, and the source(s) behind any claim.

### `chart` — hourly chart, ⓘ next to "Hourly temperatures"
- **Explains:** the shaded historic band + the dashed "10°F above average" line.
- **Current:** "The shaded band shows the minimum and maximum temperatures recorded
  in this same two-week window across 2016–2025, and the median is the dashed line.
  At 10°F above the average summer maximum, the risk of death rises about 5%
  (Skarha et al. 2023)."
- **Source:** Skarha et al. 2023 — the ~5% mortality rise per 10°F above a prison's
  own mean summer temperature. Confirm the exact figure and wording against the paper.

### `cooling` — CDCR cooling section, ⓘ next to "Cooling Infrastructure in Housing Units"
- **Explains:** the source/vintage of the housing-unit cooling mix.
- **Current:** "Reported by CDCR as of January 2026."
- **Note:** the committed data stamps this vintage as `2025-12`. Reconcile the date —
  update either this copy or the data's `cooling_as_of` so they agree.

### `vulnerabilities_intro` — "Heat Vulnerabilities" section, ⓘ next to the heading
- **Explains:** what the underlined percentages in the paragraph are.
- **Current:** "These are the shares of people held here who face elevated heat-health
  risk; hover each for the statewide CDCR average and why it matters."

### The vulnerability "madlib" numbers
Each underlined number in the Heat Vulnerabilities paragraph has its own tooltip. The
number shown is *this facility's* value; the tooltip gives the *statewide CDCR average*
(`{pct}` / `{avg}`) plus why it matters for heat.

- **`population`** — "Across CDCR prisons, an average of {avg} people are held per facility."
- **`people_of_color`** — "CDCR prisons house an average of {pct} people of color. People of
  color face higher thermal inequity and more often arrive already carrying heat-vulnerable
  illnesses (Hamstead 2023; PPIC 2024)."
- **`age_over_50`** — "Across CDCR prisons, an average of {pct} are 50 or older. Older age
  weakens the body's ability to regulate heat and raises cardiovascular strain (Singh et al. 2024)."
- **`mental_health`** — "An average of {pct} across CDCR prisons receive enhanced outpatient
  mental-health care. The psychotropic medications this care often involves impair the body's
  ability to cool itself (Singh et al. 2024; Brunn et al. 2025)."
- **`disability`** — "An average of {pct} across CDCR prisons are in the disability placement
  program. Disabilities can limit a person's ability to sense, avoid, or escape dangerous heat
  (Singh et al. 2024)."
- **`medical_risk`** — "An average of {pct} across CDCR prisons fall in a medium or higher
  medical-risk category. Chronic illness impairs thermoregulation and raises the risk of heat
  death (CCHCS 2025; Singh et al. 2024)."
- **`womens_facility`** — "This is a women's facility." (shown only when a facility is >50% women)

---

## Sources & Methods page (`content/methods.md`)

A short essay. It should cover:

1. **What the tracker shows** — current temperature at each active CA carceral facility,
   relative to that facility's own 1991–2020 summer normal, with two weeks of hourly context.
2. **The comparison line** — 10°F above the facility's 1991–2020 June–August average daily high.
   Why relative-to-each-place, and why +10°F (Skarha et al. 2023: ~5% higher mortality per 10°F
   above a prison's own mean summer temperature; daily maximum temperature, not heat index).
3. **Reading the map** — dot color = absolute current temperature; ring = 10°F+ above the
   facility's average summer maximum.
4. **Data sources** — PRISM 30-year normals (baseline), NWS NDFD (current-day high),
   NOAA RTMA/URMA via Google Earth Engine (recent hourly + historic band), nearest NWS station
   (live temperature top-up), EPA AirNow (AQI), FEMA/HIFLD (facilities + boundaries), CDCR/CCHCS
   (population, cooling, vulnerability).
5. **Limitations** — PRISM-vs-RTMA product offset (~1–2°F), ~2.5 km grid resolution,
   July 2025 HIFLD facility-list vintage, sparse non-CDCR population, AirNow monitor-coverage gaps.

Never brand the threshold a "heatwave." Present it as exactly what it is.

---

## Master source list

Short cites as they appear on the site; confirm full references before launch.

- **Skarha et al. 2023** — heat-related mortality in U.S. state/private prisons (case-crossover,
  2001–2019); the ~5% mortality rise per 10°F above a prison's own mean summer temperature.
- **Hamstead 2023** — thermal inequity by neighborhood / race.
- **PPIC 2024** — CA demographic / heat-vulnerability context.
- **Singh et al. 2024** — age, disability, and medication effects on thermoregulation.
- **Brunn et al. 2025** — psychotropic medications and heat tolerance.
- **CCHCS 2025** — CDCR medical-risk tiers.
- **CDCR (cooling report, Jan 2026 per current copy / 2025-12 per data)** — housing-unit cooling mix.
- Data products: **PRISM Climate Group** (OSU), **NWS NDFD**, **NOAA RTMA/URMA**, **EPA AirNow**,
  **FEMA/HIFLD** Prison Boundaries (July 2025).
