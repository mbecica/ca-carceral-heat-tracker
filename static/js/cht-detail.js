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
  function fillAqiTile(aqi, category, lat, lon) {
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
    if (sub) sub.innerHTML = (category ? category + " · " : "") + link;
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
  // Detail CSV: the facility's full record + its recent daily maxes (one row per day,
  // metadata repeated so the file is a clean tidy table).
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
      pct_of_capacity: fac.capacity_pct, avg_summer_max_f: fac.baseline_summer_avg_high_f,
      threshold_f: fac.threshold_f, website: fac.website
    };
  }
  function facilityCsv(fac, recent, aqi, aqiCat) {
    var f = metaFrom(fac || {});
    var metaVals = META_COLS.map(function (c) {
      var v = f[c];
      if (c === "pct_of_capacity" && v != null) return (v * 100).toFixed(0);
      return v;
    });
    var current = [recent.current_temp_f, recent.current_temp_as_of, aqi, aqiCat];
    var head = META_COLS.concat(["current_temp_f", "current_temp_as_of", "aqi", "aqi_category", "date", "daily_max_f"]);
    var rows = [head.map(csvCell).join(",")];
    (recent.daily_max || []).forEach(function (d) {
      rows.push(metaVals.concat(current).concat([d.date, d.max_f]).map(csvCell).join(","));
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

    // CSV download: the facility's full record + its recent daily maxes.
    // The full record comes from facilities.json, fetched on demand.
    var dl = $("cht-download");
    if (dl) dl.addEventListener("click", function () {
      if (!recentData) return;
      dl.disabled = true;
      fetch("/data/facilities.json").then(function (r) { return r.json(); }).then(function (all) {
        var fac = all.facilities.filter(function (x) { return x.slug === slug; })[0] || {};
        download(slug + "-data.csv", facilityCsv(fac, recentData, aqiVal, aqiCatVal));
      }).catch(function () {
        download(slug + "-data.csv", facilityCsv({}, recentData, aqiVal, aqiCatVal));
      }).then(function () { dl.disabled = false; });
    });

    // Recent live data -> temp tile + chart.
    fetch("/data/recent/" + slug + ".json").then(function (r) { return r.json(); }).then(function (recent) {
      recentData = recent;
      // Link to the actual RTMA dataset we sample (via Earth Engine). RTMA is a
      // gridded model with no per-point weather page, so this points at the source
      // itself; the human-readable NWS page lives on the station note below.
      var rtmaSrc = '<a class="cht-src" href="https://developers.google.com/earth-engine/datasets/catalog/NOAA_NWS_RTMA" target="_blank" rel="noopener">NOAA RTMA</a>';
      fillTempTile(recent.current_temp_f, recent.current_temp_as_of, rtmaSrc);
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
      fillAqiTile(aqiVal, aqiCatVal, lat, lon);
    }).catch(function () { fillAqiTile(null, null, lat, lon); });

    // Redraw chart on resize (debounced).
    var rt; window.addEventListener("resize", function () {
      clearTimeout(rt); rt = setTimeout(drawChart, 200);
    });
  });
})();
