/* ============================================================================
   Detail-page orchestrator. Reads the facility's threshold + coords from data
   attributes (server-rendered from facilities.json), fetches the raw live data,
   and fills the status hero, current-conditions tiles, and D3 chart — applying
   the threshold in the browser (cht-status.js), never baked into the data.

   Also does the §3/§5 keyless NWS top-up: the pipeline's current_temp_f lags
   ~12–24h, so on load we refresh the "temperature now" tile from the nearest NWS
   observation station. Tooltip portaling is ported from PHI phi-profile.js.
   ============================================================================ */
(function () {
  "use strict";

  function ready(fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  function $(id) { return document.getElementById(id); }
  function fmt(n, dp) { return n == null || isNaN(n) ? "—" : (dp ? (+n).toFixed(dp) : Math.round(n)); }
  function fmtStamp(s) { try { return new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return s; } }

  // EPA AQI category color.
  function aqiColor(aqi) {
    if (aqi == null) return "var(--cht-null)";
    if (aqi <= 50) return "#00e400";
    if (aqi <= 100) return "#ffd000";
    if (aqi <= 150) return "#ff7e00";
    if (aqi <= 200) return "#ff0000";
    if (aqi <= 300) return "#8f3f97";
    return "#7e0023";
  }

  // sourceHtml may contain a link to the data source.
  function fillTempTile(tempF, asOf, sourceHtml) {
    var val = $("cht-temp-now"), sub = $("cht-temp-sub");
    if (val) val.innerHTML = tempF != null ? fmt(tempF) + "<span class='cht-tile__unit'>°F</span>" : "—";
    if (sub) sub.innerHTML = sourceHtml + (asOf ? " · " + fmtStamp(asOf) : "");
  }

  // Trailing-24h peak tile — the same value that drives the over-average status/ring
  // elsewhere, so the profile and the map agree. Same RTMA source as the Latest tile.
  function fill24hMax(maxF, at, sourceHtml) {
    var val = $("cht-24hmax-val"), sub = $("cht-24hmax-sub");
    if (val) val.innerHTML = maxF != null ? fmt(maxF) + "<span class='cht-tile__unit'>°F</span>" : "—";
    if (sub) sub.innerHTML = maxF != null ? sourceHtml + (at ? " · " + fmtStamp(at) : "") : "unavailable";
  }

  // Secondary "nearest NWS station" reading, shown under the primary (RTMA) tile.
  // The primary value is the NOAA RTMA value so it matches the map/table tooltips
  // everywhere; this is a fresher-but-spot side note, hidden when no station reports.
  function fillStationNote(tempF, asOf, linkHtml) {
    var note = $("cht-temp-station");
    if (!note) return;
    if (tempF == null) { note.hidden = true; note.innerHTML = ""; return; }
    note.hidden = false;
    note.innerHTML = "Nearest station " + linkHtml + ": <strong>" + fmt(tempF) +
      "°F</strong>" + (asOf ? " · " + fmtStamp(asOf) : "");
  }

  // Always render the AQI tile; when no nearby monitor reports, say so rather than vanish.
  function fillAqiTile(aqi, category, asOf, lat, lon) {
    var tile = $("cht-aqi-tile"), dot = $("cht-aqi-dot"), val = $("cht-aqi-val"), sub = $("cht-aqi-sub");
    if (tile) tile.hidden = false;
    if (aqi == null) {
      if (dot) dot.style.background = "var(--cht-null)";
      if (val) val.textContent = "—";
      if (sub) sub.textContent = "No nearby monitor";
      return;
    }
    if (dot) dot.style.background = aqiColor(aqi);
    if (val) val.textContent = aqi;
    var link = '<a class="cht-src" href="https://www.airnow.gov/?latitude=' + lat + '&longitude=' + lon + '" target="_blank" rel="noopener">AirNow</a>';
    if (sub) sub.innerHTML = (category ? category + " · " : "") + (asOf ? asOf + " · " : "") + link;
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // Detail CSVs (from the header menu). Like the statewide CSV, none of them depend
  // on what the reader has selected on the page.
  //   details — one row: the facility record + current conditions, plus CDCR
  //             columns ONLY for CDCR prisons (other facilities don't get blank ones);
  //   recent  — one row per day: recent daily high and low (RTMA);
  //   annual  — hot days per year, built by cht-history.js.
  var META_COLS = ["slug", "name", "county", "city", "address", "jurisdiction", "security",
    "latitude", "longitude", "population", "population_as_of", "design_capacity", "pct_of_capacity",
    "avg_summer_max_f", "threshold_f", "website"];
  // Map a facilities.json record onto the flat CSV meta columns.
  function metaFrom(fac) {
    var cap = fac.capacity;
    if (cap == null && fac.population != null && fac.capacity_pct) cap = Math.round(fac.population / fac.capacity_pct);
    return {
      slug: fac.slug, name: fac.name, county: fac.county, city: fac.city, address: fac.address,
      jurisdiction: fac.jurisdiction, security: fac.security, latitude: fac.lat, longitude: fac.lon,
      population: fac.population, population_as_of: fac.population_as_of, design_capacity: cap,
      pct_of_capacity: fac.capacity_pct == null ? null : (fac.capacity_pct * 100).toFixed(0),
      avg_summer_max_f: fac.baseline_summer_avg_high_f, threshold_f: fac.threshold_f, website: fac.website
    };
  }
  // CDCR prison columns. Cooling shares are percent of housing units (left blank when
  // the prison isn't in CDCR's Air Cooling report); demographics/medical are percent of people.
  function cdcrFrom(c) {
    var cool = c.cooling || {}, cond = cool.condition_2026 || {}, dem = c.demographics || {}, med = c.medical || {};
    var inReport = !!cool.n_housing_units;
    function pct(v) { return inReport && v != null ? +(v * 100).toFixed(1) : null; }
    function yn(v) { return v ? "yes" : "no"; }
    return [
      ["cdcr_code", c.code], ["year_opened", c.year_opened], ["planned_closure", c.planned_closure],
      ["california_model", yn(c.california_model)], ["air_cooling_pilot", yn(c.air_cooling_pilot)],
      ["targeted_for_capital_projects_2026", yn(c.infrastructure_priority_2026)],
      ["housing_units", inReport ? cool.n_housing_units : null],
      ["housing_units_mechanical_ac_pct", pct(cool.mechanical_pct)],
      ["housing_units_evaporative_pct", pct(cool.evaporative_pct)],
      ["housing_units_no_cooling_pct", pct(cool.air_handlers_pct)],
      ["cooling_in_non_housing_buildings_only", (cool.outside_housing || []).join("; ")],
      ["condition_mechanical_ac_2026", cond.mechanical], ["condition_evaporative_2026", cond.evaporative],
      ["people_of_color_pct", dem.poc_pct], ["age_50_plus_pct", dem.age_over_50_pct], ["women_pct", dem.female_pct],
      ["mental_health_eop_pct", med.mental_health_eop_pct], ["disability_placement_pct", med.dpp_pct],
      ["medium_medical_risk_pct", med.medium_risk_pct], ["high_medical_risk_p1_pct", med.high_risk_p1_pct],
      ["high_medical_risk_p2_pct", med.high_risk_p2_pct]
    ];
  }
  function detailsCsv(fac, recent, aqi, aqiCat) {
    var m = metaFrom(fac);
    var head = META_COLS.concat(["current_temp_f", "current_temp_as_of", "forecast_high_f",
      "last24h_max_f", "last24h_max_at", "aqi", "aqi_category"]);
    var row = META_COLS.map(function (c) { return m[c]; }).concat([recent.current_temp_f, recent.current_temp_as_of,
      recent.today_forecast_high_f, recent.last24h_max_f, recent.last24h_max_at, aqi, aqiCat]);
    if (fac.cdcr) cdcrFrom(fac.cdcr).forEach(function (kv) { head.push(kv[0]); row.push(kv[1]); });
    return head.map(csvCell).join(",") + "\n" + row.map(csvCell).join(",");
  }
  // Daily high and low per Pacific-time day, both from the same hourly series the
  // pipeline's daily_max comes from. hours_of_data flags partial days (the oldest
  // day and today are usually partial), so a reader can see which days are complete.
  var PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  function recentCsv(slug, name, recent) {
    var lo = {}, n = {};
    (recent.hourly || []).forEach(function (h) {
      if (h.f == null) return;
      var d = PT_DAY.format(new Date(h.t));
      n[d] = (n[d] || 0) + 1;
      if (lo[d] == null || h.f < lo[d]) lo[d] = h.f;
    });
    var rows = ["slug,name,date,daily_max_f,daily_min_f,hours_of_data,source"];
    (recent.daily_max || []).forEach(function (d) {
      rows.push([slug, name, d.date, d.max_f, lo[d.date], n[d.date] || 0, "NOAA RTMA/URMA"].map(csvCell).join(","));
    });
    return rows.join("\n");
  }

  // Portaled tooltips (ported from phi-profile.js): escape the scrolling panel.
  function wireTips() {
    var tip = null;
    function hide() { if (tip) { tip.remove(); tip = null; } }
    function show(el) {
      var text = el.getAttribute("data-tip"); if (!text) return;
      hide();
      tip = document.createElement("div"); tip.className = "cht-tip"; tip.textContent = text;
      document.body.appendChild(tip);
      var r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
      var left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
      var top = r.top - t.height - 8; if (top < 8) top = r.bottom + 8;
      tip.style.left = left + "px"; tip.style.top = top + "px"; tip.classList.add("cht-tip--in");
    }
    document.querySelectorAll("[data-tip]").forEach(function (el) {
      el.removeAttribute("title");
      el.addEventListener("mouseenter", function () { show(el); });
      el.addEventListener("mouseleave", hide);
      el.addEventListener("focus", function () { show(el); });
      el.addEventListener("blur", hide);
    });
    window.addEventListener("scroll", hide, true);
  }

  // Keyless NWS current-obs lookup: points -> observationStations -> latest obs.
  // Fills the SECONDARY station note only; the primary tile stays on the RTMA
  // value so it matches the tooltips on every page.
  function nwsTopUp(lat, lon) {
    if (lat == null || lon == null) return;
    var pt = "https://api.weather.gov/points/" + (+lat).toFixed(4) + "," + (+lon).toFixed(4);
    var stationId = null;
    fetch(pt, { headers: { Accept: "application/geo+json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) { return fetch(j.properties.observationStations, { headers: { Accept: "application/geo+json" } }); })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) {
        var st = j.features && j.features[0]; if (!st) return Promise.reject();
        stationId = st.properties && st.properties.stationIdentifier;
        return fetch(st.id + "/observations/latest", { headers: { Accept: "application/geo+json" } });
      })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (j) {
        var t = j.properties && j.properties.temperature;
        if (!t || t.value == null) return;
        var f = t.unitCode && t.unitCode.indexOf("degC") >= 0 ? t.value * 9 / 5 + 32 : t.value;
        // Link to the human-readable NWS point page for this location (shows the
        // nearest station's current conditions) rather than the raw obs table.
        var href = "https://forecast.weather.gov/MapClick.php?lat=" + lat + "&lon=" + lon;
        var linkHtml = '<a class="cht-src" href="' + href + '" target="_blank" rel="noopener">' +
          (stationId || "NWS observation") + '</a>';
        fillStationNote(f, j.properties.timestamp, linkHtml);
      })
      .catch(function () { /* no nearby station reporting; note stays hidden */ });
  }

  ready(function () {
    var root = document.querySelector(".cht-app[data-slug]");
    if (!root) return;
    var slug = root.getAttribute("data-slug");
    var lat = root.getAttribute("data-lat"), lon = root.getAttribute("data-lon");
    var threshold = root.getAttribute("data-threshold");
    threshold = threshold === "" || threshold == null ? null : +threshold;
    var baseline = root.getAttribute("data-baseline");
    baseline = baseline === "" || baseline == null ? null : +baseline;

    wireTips();

    // Mobile: the sticky facility title carries a back arrow, shown only once the
    // page header (with "Back to statewide view") has scrolled out of view — so the
    // two back links never sit on screen together. Desktop keeps the arrow hidden
    // via CSS (the header is always visible there), so this class is a no-op there.
    (function wireScrollBack() {
      var dash = document.querySelector(".cht-dash--detail");
      var header = dash && dash.querySelector(".cht-dash__bar");
      if (!dash || !header || !("IntersectionObserver" in window)) return;
      new IntersectionObserver(function (entries) {
        dash.classList.toggle("cht-scrolled", !entries[0].isIntersecting);
      }, { threshold: 0 }).observe(header);
    })();

    var recentData = null, bandData = null, rangeDays = 7, aqiVal = null, aqiCatVal = null;   // default: last week

    // Draw the chart for the last `rangeDays` days (band aligns per-point, so
    // filtering the hourly series also limits the historic band shown).
    function drawChart() {
      if (!recentData) return;
      var hourly = recentData.hourly || [];
      if (hourly.length) {
        var last = new Date(hourly[hourly.length - 1].t).getTime();
        var cutoff = last - rangeDays * 86400000;
        hourly = hourly.filter(function (h) { return new Date(h.t).getTime() >= cutoff; });
      }
      window.CHTChart.draw($("cht-chart"), {
        hourly: hourly, band: bandData, threshold: threshold, average: baseline,
        tz: recentData.tz, legendEl: $("cht-chart-legend")
      });
    }

    // Time-range toggle (Last week / Last 14 days).
    document.querySelectorAll(".cht-range__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        rangeDays = +btn.getAttribute("data-range");
        document.querySelectorAll(".cht-range__btn").forEach(function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
        drawChart();
      });
    });

    // CSV menu: open/close like the statewide filter dropdowns; each item downloads
    // one fixed file. The facility record comes from facilities.json, fetched on demand.
    var dl = $("cht-download"), menu = $("cht-csv-menu");
    function setMenu(open) { if (!menu) return; menu.hidden = !open; dl.setAttribute("aria-expanded", open ? "true" : "false"); }
    if (dl && menu) {
      dl.addEventListener("click", function (e) { e.stopPropagation(); setMenu(menu.hidden); });
      document.addEventListener("click", function (e) { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { setMenu(false); dl.focus(); } });
      menu.addEventListener("click", function (e) {
        var opt = e.target.closest("[data-csv]");
        if (!opt) return;
        var kind = opt.getAttribute("data-csv");
        opt.disabled = true;
        var job;
        if (kind === "annual") {
          job = window.CHTHistory ? window.CHTHistory.annualCsv().then(function (csv) {
            download(slug + "-hot-days-per-year.csv", csv);
          }) : Promise.reject();
        } else {
          job = fetch("/data/facilities.json").then(function (r) { return r.json(); }).then(function (all) {
            var fac = all.facilities.filter(function (x) { return x.slug === slug; })[0] || { slug: slug };
            if (kind === "details") download(slug + "-details.csv", detailsCsv(fac, recentData || {}, aqiVal, aqiCatVal));
            else download(slug + "-recent-daily-temps.csv", recentCsv(slug, fac.name, recentData || {}));
          });
        }
        job.catch(function () { /* nothing downloads; the reader can pick it again */ })
          .then(function () { opt.disabled = false; setMenu(false); });
      });
    }

    // Recent live data -> temp tile + chart.
    fetch("/data/recent/" + slug + ".json").then(function (r) { return r.json(); }).then(function (recent) {
      recentData = recent;
      // Link to the actual RTMA dataset we sample (via Earth Engine). RTMA is a
      // gridded model with no per-point weather page, so this points at the source
      // itself; the human-readable NWS page lives on the station note below.
      var rtmaSrc = '<a class="cht-src" href="https://developers.google.com/earth-engine/datasets/catalog/NOAA_NWS_RTMA" target="_blank" rel="noopener">NOAA RTMA</a>';
      fillTempTile(recent.current_temp_f, recent.current_temp_as_of, rtmaSrc);
      fill24hMax(recent.last24h_max_f, recent.last24h_max_at, rtmaSrc);
      var foot = document.querySelector("[data-cht-asof]");
      if (foot) foot.textContent = recent.generated_at ? "Data as of " + fmtStamp(recent.generated_at) : "";

      // Historic band (isolated; chart still renders without it).
      fetch("/data/bands/" + slug + ".json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        .then(function (band) { bandData = band; drawChart(); });

      drawChart();          // draw immediately; the band redraws when it arrives
      nwsTopUp(lat, lon);   // fills the secondary station note; primary stays RTMA
    }).catch(function (e) {
      if (window.console) console.error("heat tracker: detail load failed", e);
      fillTempTile(null, null, "unavailable");
    });

    // AQI tile from statewide.json (cached from the home page).
    fetch("/data/statewide.json").then(function (r) { return r.json(); }).then(function (sw) {
      var row = sw.facilities.filter(function (x) { return x.slug === slug; })[0];
      aqiVal = row ? row.aqi : null; aqiCatVal = row ? row.aqi_category : null;
      fillAqiTile(aqiVal, aqiCatVal, row ? row.aqi_as_of : null, lat, lon);
    }).catch(function () { fillAqiTile(null, null, null, lat, lon); });

    // Redraw chart on resize (debounced).
    var rt; window.addEventListener("resize", function () {
      clearTimeout(rt); rt = setTimeout(drawChart, 200);
    });
  });
})();
