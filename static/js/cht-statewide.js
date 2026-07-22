/* ============================================================================
   Statewide dashboard controller.

   Joins static/data/statewide.json (raw live rows) + facilities.json (comparison
   line, jurisdiction, population, county) on `slug`, computes each facility's
   two-tier status client-side via CHTStatus, and drives a Leaflet map + client-
   sorted table. Page-wide filters — a "Heat" dropdown (Over average / 10°F+ above
   average), jurisdiction / population / county multi-select, and search — narrow
   the map AND the table together; "Clear all" resets. A dismissable alert flags
   the count of facilities over their historic average.

   Map: dot FILL = absolute current temperature (CHTTempScale); a neutral near-
   black RING marks status, its THICKNESS the severity (thin = over average,
   thick = 10°F+ above average) — a colorblind-safe cue that stays legible on an
   already-red hot dot. On mobile a Map/Table toggle switches panes and tapping a
   dot opens a popup with a "View details" link.
   ============================================================================ */
(function () {
  "use strict";

  var STATEWIDE_URL = "/data/statewide.json";
  var FACILITIES_URL = "/data/facilities.json";
  var BOUND_URL = "/data/facility_boundaries.geojson";
  var POLY_ZOOM = 13, DOT_R = 5;   // only swap dots→polygons well zoomed-in, so polygons are big enough to tap on mobile
  // Basemap: CARTO Positron — a neutral light canvas so hot (dark-red) dots read clearly.
  // Swap here to try others: "dark_all", "rastertiles/voyager", "light_nolabels".
  var BASEMAP = "light_all";

  var CA_COUNTIES = ["Alameda","Alpine","Amador","Butte","Calaveras","Colusa","Contra Costa","Del Norte","El Dorado","Fresno","Glenn","Humboldt","Imperial","Inyo","Kern","Kings","Lake","Lassen","Los Angeles","Madera","Marin","Mariposa","Mendocino","Merced","Modoc","Mono","Monterey","Napa","Nevada","Orange","Placer","Plumas","Riverside","Sacramento","San Benito","San Bernardino","San Diego","San Francisco","San Joaquin","San Luis Obispo","San Mateo","Santa Barbara","Santa Clara","Santa Cruz","Shasta","Sierra","Siskiyou","Solano","Sonoma","Stanislaus","Sutter","Tehama","Trinity","Tulare","Tuolumne","Ventura","Yolo","Yuba"];

  var POP_BUCKETS = [
    { id: "u500", label: "Under 500",     test: function (p) { return p != null && p >= 0 && p < 500; } },
    { id: "500",  label: "500–1,999",     test: function (p) { return p != null && p >= 500 && p < 2000; } },
    { id: "2000", label: "2,000 or more", test: function (p) { return p != null && p >= 2000; } },
    { id: "unknown", label: "Unknown",    test: function (p) { return !(p != null && p >= 0); } }
  ];
  function popBucketId(d) {
    var p = d.fac.population;
    for (var i = 0; i < POP_BUCKETS.length; i++) if (POP_BUCKETS[i].test(p)) return POP_BUCKETS[i].id;
    return "unknown";
  }

  var state = { heat: new Set(), jurisdiction: new Set(), population: new Set(), county: new Set(), search: "" };

  // Max-temperature filter: a dual-handle range over the 24-hour max (d.max24),
  // living in the Max temperature dropdown alongside the historic over-avg floors.
  var TEMP_DOMAIN = [50, 115];   // slider bounds, °F
  var maxState = { min: TEMP_DOMAIN[0], max: TEMP_DOMAIN[1] };
  // A slider spanning the full domain means "no constraint"; a facility with no
  // 24h reading can't fall inside a range.
  function maxActive() { return maxState.min > TEMP_DOMAIN[0] || maxState.max < TEMP_DOMAIN[1]; }
  function maxMatch(d) { return d.max24 != null && d.max24 >= maxState.min && d.max24 <= maxState.max; }
  var sort = { key: "today", dir: "desc" };   // default: hottest current temperature first
  var data = [], bySlug = {}, meta = null, alertDismissed = false, baselinePeriod = "";
  var alertTier = "avg";   // which floor the alert bar currently represents: "hi" (10°F+) or "avg"
  var map = null, tiles = null, circleGroup = null, polyGroup = null, polyShown = false, userMarker = null;
  var circles = {}, polys = {};

  function ready(fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  function isMobile() { return window.matchMedia && window.matchMedia("(max-width: 820px)").matches; }
  function isDark() { return document.documentElement.dataset.theme === "dark"; }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function slugPath(slug) { return "/" + slug + "/"; }
  function tileUrl() { return "https://{s}.basemaps.cartocdn.com/" + BASEMAP + "/{z}/{x}/{y}{r}.png"; }
  function fillFor(d) { return window.CHTTempScale.tempColor(d.currentTemp) || cssVar("--cht-null"); }
  function isOverAvg(d) { return d.status.hasData && d.status.overAvg; }
  function isOverHi(d) { return d.status.hasData && d.status.overHi; }
  function heatLevel(d) { return d.status.hasData ? d.status.level : -1; }
  function fmt(n, dp) { return n == null || isNaN(n) ? "—" : (dp ? (+n).toFixed(dp) : Math.round(n)); }
  function fmtAsOf(s) { try { return new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }); } catch (e) { return s; } }
  // CDCR code -> pill; strips the "(Code)" the name already carries.
  function baseName(d) { return d.code ? d.name.replace(/\s*\([^)]*\)\s*$/, "") : d.name; }
  function codePill(d) { return d.code ? ' <span class="cht-tcode">' + d.code + "</span>" : ""; }
  function aqiColor(a) {
    if (a == null) return cssVar("--cht-null");
    if (a <= 50) return "#00e400"; if (a <= 100) return "#ffd000"; if (a <= 150) return "#ff7e00";
    if (a <= 200) return "#ff0000"; if (a <= 300) return "#8f3f97"; return "#7e0023";
  }

  // Ring encodes status by THICKNESS on a neutral near-black stroke, not by hue,
  // so it reads on an already-red hot dot and survives colorblindness.
  // Tune the two weights (and --cht-ring) to taste; kept here as the single knob.
  var RING_W_AVG = 2, RING_W_HI = 3.5;
  function strokeStyle(d) {
    if (isOverHi(d)) return { color: cssVar("--cht-ring"), weight: RING_W_HI, opacity: 1 };
    if (isOverAvg(d)) return { color: cssVar("--cht-ring"), weight: RING_W_AVG, opacity: 1 };
    return { color: cssVar("--cht-map-stroke"), weight: 1, opacity: 1 };
  }

  // One aligned row of the tooltip temperature list: label, right-aligned value,
  // de-emphasized timestamp (a moment for Latest/24h, the baseline period for historic).
  function tempRow(label, val, time) {
    return '<span class="cht-ltip__k">' + label + "</span>" +
      '<span class="cht-ltip__v">' + (val != null ? fmt(val) + "°F" : "—") + "</span>" +
      '<span class="cht-ltip__t">' + (time || "") + "</span>";
  }
  /* Shared tooltip/popup body: name, place, an aligned temperature list
     (Latest / 24 Hour Max / Historic avg max, each timestamped), then AQI. */
  function contentHtml(d) {
    var avg = d.fac && d.fac.baseline_summer_avg_high_f;
    var temps = '<span class="cht-ltip__temps">' +
      tempRow("Latest", d.currentTemp, d.tempAsOf ? fmtAsOf(d.tempAsOf) : "") +
      (d.max24 != null ? tempRow("24 hour max", d.max24, d.max24At ? fmtAsOf(d.max24At) : "") : "") +
      (avg != null ? tempRow("Historic avg max", avg, baselinePeriod ? "(" + baselinePeriod + ")" : "") : "") +
      "</span>";
    var aqi = d.aqi != null
      ? '<span class="cht-ltip__val">AQI ' + d.aqi + (d.aqiCat ? " · " + d.aqiCat : "") + '<i class="cht-aqi-mini" style="background:' + aqiColor(d.aqi) + '"></i></span>'
      : "";
    return '<span class="cht-ltip__name">' + baseName(d) + codePill(d) + "</span>" +
      '<span class="cht-ltip__sub">' + (d.county || "") + " County · " + (d.jurisdiction || "") + "</span>" +
      temps + aqi;
  }
  function popupHtml(d) {
    return '<div class="cht-lpop__body">' + contentHtml(d) +
      '<a class="cht-lpop__link" href="' + slugPath(d.slug) + '">View details →</a></div>';
  }

  // Heat filter: each checked option is a FLOOR (avg = level ≥ 1, hi = level ≥ 2);
  // a facility passes if it clears any checked floor. Since over-hi implies over-
  // avg, checking both is the same as checking "avg" alone.
  function heatMatch(d) {
    return (state.heat.has("avg") && isOverAvg(d)) || (state.heat.has("hi") && isOverHi(d));
  }
  function matches(d) {
    if (state.heat.size && !heatMatch(d)) return false;
    if (maxActive() && !maxMatch(d)) return false;
    if (state.jurisdiction.size && !state.jurisdiction.has(d.jurisdiction)) return false;
    if (state.population.size && !state.population.has(popBucketId(d))) return false;
    if (state.county.size && !state.county.has(d.county)) return false;
    var q = state.search.trim().toLowerCase();
    if (q && (d.name || "").toLowerCase().indexOf(q) < 0
          && (d.county || "").toLowerCase().indexOf(q) < 0
          && (d.code || "").toLowerCase().indexOf(q) < 0) return false;   // also match CDCR code (e.g. CCWF)
    return true;
  }
  function anyActive() { return state.heat.size || maxActive() || state.jurisdiction.size || state.population.size || state.county.size || state.search.trim(); }

  function highlight(slug, on) {
    if (circles[slug]) circles[slug].setStyle({ weight: (on ? 1.5 : 0) + strokeStyle(bySlug[slug]).weight });
    if (on && circles[slug]) circles[slug].bringToFront();
    var row = document.querySelector('#cht-table tr[data-slug="' + slug + '"]');
    if (row) row.classList.toggle("cht-row-hl", on);
  }

  /* Desktop: hover tooltip + click navigates. Mobile: tap opens a popup with a
     "View details" link (no direct navigation). */
  function bindMarker(layer, d, sticky) {
    if (isMobile()) {
      layer.bindPopup(popupHtml(d), { className: "cht-lpop", closeButton: true, autoPan: true });
    } else {
      // Keep "top" intentionally: Leaflet's "auto" only flips left/right (no top/bottom),
      // so it jumps side-to-side as you browse between markers. Consistent-above reads
      // better; the tradeoff is it can clip near the map edge.
      layer.bindTooltip(contentHtml(d), { direction: "top", sticky: !!sticky, className: "cht-ltip", opacity: 1 });
      layer.on("click", function () { window.location.href = slugPath(d.slug); });
      layer.on("mouseover", function () { highlight(d.slug, true); });
      layer.on("mouseout", function () { highlight(d.slug, false); });
    }
  }

  function drawMap(boundaries) {
    map = L.map("cht-map", { center: [37.2, -119.4], zoom: 6, scrollWheelZoom: true });
    tiles = L.tileLayer(tileUrl(), {
      subdomains: "abcd", maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    circleGroup = L.featureGroup();
    // Hotter status on top so its thicker ring isn't occluded by calmer dots.
    data.slice().sort(function (a, b) { return heatLevel(a) - heatLevel(b); }).forEach(function (d) {
      if (d.lat == null || d.lon == null) return;
      var st = strokeStyle(d);
      var m = L.circleMarker([d.lat, d.lon], { radius: DOT_R, weight: st.weight, color: st.color, opacity: 1, fillColor: fillFor(d), fillOpacity: 0.9 });
      bindMarker(m, d, false);
      circles[d.slug] = m;
    });

    polyGroup = L.geoJSON(boundaries, {
      style: function () { return { weight: 1.2, color: cssVar("--cht-map-stroke"), fillOpacity: 0.75 }; },
      onEachFeature: function (feat, layer) {
        var d = bySlug[feat.properties.slug]; if (!d) return;
        var st = strokeStyle(d);
        polys[d.slug] = layer;
        layer.setStyle({ fillColor: fillFor(d), color: st.color, weight: st.weight });
        bindMarker(layer, d, true);
      }
    });

    applyMapFilter();
    circleGroup.addTo(map);
    map.fitBounds(circleGroup.getBounds(), { padding: [10, 10], maxZoom: 7 });
    map.on("zoomend", updateMode);

    // "My location" as an on-map control (top-right), not a legend item.
    var LocateCtl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        var b = L.DomUtil.create("button", "cht-locate");
        b.type = "button"; b.id = "cht-locate";
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>My location';
        L.DomEvent.disableClickPropagation(b);
        return b;
      }
    });
    map.addControl(new LocateCtl());
    wireLocate();

    setTimeout(function () { map.invalidateSize(); }, 60);
    window.addEventListener("resize", function () { map.invalidateSize(); });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { tiles.setUrl(tileUrl()); recolor(); });
  }

  function updateMode() {
    if (!map) return;
    var wantPoly = map.getZoom() >= POLY_ZOOM;
    if (wantPoly && !polyShown) { map.removeLayer(circleGroup); applyMapFilter(); polyGroup.addTo(map); polyShown = true; }
    else if (!wantPoly && polyShown) { map.removeLayer(polyGroup); circleGroup.addTo(map); polyShown = false; }
  }

  function applyMapFilter() {
    data.forEach(function (d) {
      var show = matches(d), c = circles[d.slug], p = polys[d.slug];
      if (c) { if (show) circleGroup.addLayer(c); else circleGroup.removeLayer(c); }
      if (p) { if (show) { if (!polyGroup.hasLayer(p)) polyGroup.addLayer(p); } else if (polyGroup.hasLayer(p)) polyGroup.removeLayer(p); }
    });
  }

  function recolor() {
    data.forEach(function (d) {
      var st = strokeStyle(d), fill = fillFor(d);
      if (circles[d.slug]) circles[d.slug].setStyle({ fillColor: fill, color: st.color, weight: st.weight });
      if (polys[d.slug]) polys[d.slug].setStyle({ fillColor: fill, color: st.color, weight: st.weight });
    });
  }

  /* ---- Geolocation: "My location" on-map control ----
     Surfaces WHY it fails (silent failure was impossible to debug): geolocation only
     works in a secure context (https or localhost) — over a plain-http LAN IP the
     browser refuses it with no prompt, which is the usual "nothing happens on mobile". */
  function flashLocate(msg, keep) {
    var host = document.querySelector(".cht-dash__map"); if (!host) return;
    var el = document.getElementById("cht-locate-msg");
    if (!el) { el = document.createElement("div"); el.id = "cht-locate-msg"; el.className = "cht-locate-msg"; host.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(el._t); if (!keep) el._t = setTimeout(function () { el.hidden = true; }, 4500);
  }
  function hideLocate() { var el = document.getElementById("cht-locate-msg"); if (el) el.hidden = true; }
  function locateMe() {
    if (!map) return;
    if (!window.isSecureContext) return flashLocate("“My location” needs a secure (https) connection");
    if (!navigator.geolocation) return flashLocate("Location isn’t available in this browser");
    flashLocate("Locating…", true);
    map.locate({ setView: true, maxZoom: 11, enableHighAccuracy: true, timeout: 10000 });
  }
  function wireLocate() {
    var btn = document.getElementById("cht-locate");
    if (btn) btn.addEventListener("click", locateMe);
    if (!map) return;
    map.on("locationfound", function (e) {
      hideLocate();
      if (userMarker) userMarker.setLatLng(e.latlng);
      else userMarker = L.circleMarker(e.latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#2f6fd0", fillOpacity: 1 }).addTo(map).bindTooltip("You are here", { className: "cht-ltip" });
    });
    map.on("locationerror", function (e) {
      flashLocate(e && e.code === 1 ? "Location permission denied" : "Couldn’t get your location");
      if (window.console) console.warn("heat tracker: location error", e && (e.message || e.code));
    });
  }

  function drawLegend() {
    var el = document.getElementById("cht-legend"); if (!el) return;
    var cells = window.CHTTempScale.legendCells(55, 110, 5)
      .map(function (c) { return '<span class="cht-legend__scale-cell" style="background:' + c.color + '"></span>'; }).join("");
    // Order: fill-color legend (temp gradient + no-data) grouped first, then the two
    // status rings together. "My location" is a map control, not a legend item.
    el.innerHTML =
      '<span class="cht-legend__group"><span class="cht-legend__ends">55°</span>' +
      '<span class="cht-legend__scale">' + cells + "</span>" +
      '<span class="cht-legend__ends">110°F latest</span></span>' +
      '<span class="cht-legend__item"><span class="cht-legend__swatch" style="background:var(--cht-null)"></span>no data</span>' +
      '<span class="cht-legend__pair">' +
        '<span class="cht-legend__item"><span class="cht-legend__ring cht-legend__ring--avg"></span>Above historic avg</span>' +
        '<span class="cht-legend__item"><span class="cht-legend__ring cht-legend__ring--hi"></span>10°F above historic avg</span>' +
      '</span>';
  }

  function sortVal(d, key) {
    var s = d.status;
    if (key === "name") return d.name || "";
    if (key === "county") return d.county || "";
    if (key === "jurisdiction") return d.jurisdiction || "";
    if (key === "today") return d.currentTemp != null ? d.currentTemp : -Infinity;  // "Latest" column
    if (key === "max24") return d.max24 != null ? d.max24 : -Infinity;
    if (key === "over") return s.hasData ? s.deltaAvg : -Infinity;
    return 0;
  }
  function rebuildTable() {
    var tbody = document.querySelector("#cht-table tbody"); if (!tbody) return;
    var rows = data.filter(matches);
    var text = sort.key === "name" || sort.key === "county" || sort.key === "jurisdiction";
    rows.sort(function (a, b) {
      var av = sortVal(a, sort.key), bv = sortVal(b, sort.key);
      var cmp = text ? String(av).localeCompare(String(bv)) : (av - bv);
      return sort.dir === "asc" ? cmp : -cmp;
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td class="cht-empty" colspan="5">No facilities match.</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function (d) {
        var s = d.status;
        return '<tr data-slug="' + d.slug + '">' +
          '<td class="cht-cell-name"><span class="cht-cell-dot" style="background:' + fillFor(d) + '"></span><a href="' + slugPath(d.slug) + '">' + baseName(d) + "</a>" + codePill(d) + "</td>" +
          '<td class="cht-hide-sm">' + (d.county || "") + "</td>" +
          '<td class="cht-hide-md">' + (d.jurisdiction || "") + "</td>" +
          '<td class="cht-num cht-only-lg">' + (d.max24 != null ? fmt(d.max24) + "°" : "—") + "</td>" +
          '<td class="cht-num">' + (d.currentTemp != null ? fmt(d.currentTemp) + "°" : "—") + "</td>" +
          "</tr>";
      }).join("");
    }

    tbody.querySelectorAll("tr[data-slug]").forEach(function (row) {
      var slug = row.getAttribute("data-slug");
      row.addEventListener("mouseenter", function () { highlight(slug, true); });
      row.addEventListener("mouseleave", function () { highlight(slug, false); });
      row.addEventListener("click", function (e) { if (e.target.closest("a")) return; window.location.href = slugPath(slug); });
    });
    document.querySelectorAll("#cht-table th[data-sort]").forEach(function (th) {
      var active = th.getAttribute("data-sort") === sort.key;
      th.classList.toggle("cht-sort-active", active);
      th.setAttribute("aria-sort", active ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  /* ---- Alert (statewide, escalating) ----
     Lead with the most severe non-empty tier: if any facility hit 10°F+ above its
     historic average in the last 24h, headline THAT; else fall back to the over-
     average count; if neither, hide the bar entirely. The "View" link filters to
     whichever tier is showing. */
  function updateAlert() {
    var nHi = data.filter(isOverHi).length, nAvg = data.filter(isOverAvg).length;
    var el = document.getElementById("cht-alert");
    var cEl = document.getElementById("cht-alert-count"), lEl = document.getElementById("cht-alert-label"), link = document.getElementById("cht-alert-link");
    var n, label;
    if (nHi >= 1) {
      alertTier = "hi"; n = nHi;
      label = (n === 1 ? "facility was" : "facilities were") + " 10°F+ above their average summer maximum temperature in the last 24 hours";
    } else if (nAvg >= 1) {
      alertTier = "avg"; n = nAvg;
      label = (n === 1 ? "facility was" : "facilities were") + " above their average summer maximum temperature in the last 24 hours";
    } else {
      alertTier = "avg";
      if (el) el.hidden = true;
      return;
    }
    if (cEl) cEl.textContent = n;
    if (lEl) lEl.textContent = label;
    if (link) {
      link.textContent = "View " + n + (n === 1 ? " facility" : " facilities");
      link.setAttribute("aria-pressed", state.heat.has(alertTier) ? "true" : "false");
    }
    if (el) el.hidden = alertDismissed;
  }

  // Toggle one heat-filter floor ("avg" | "hi") and sync its checkbox + the alert
  // link's pressed state. Both feed the same state.heat set as the Heat dropdown.
  function setHeat(key, on) {
    if (on) state.heat.add(key); else state.heat.delete(key);
    var cb = document.querySelector('.cht-fdrop[data-filter="heat"] input[value="' + key + '"]');
    if (cb) cb.checked = on;
    var link = document.getElementById("cht-alert-link");
    if (link) link.setAttribute("aria-pressed", state.heat.has(alertTier) ? "true" : "false");
    applyAll();
  }

  /* ---- Filter dropdowns ---- */
  function optionRow(filter, value, label, count, disabled) {
    return '<label class="cht-fopt' + (disabled ? " cht-fopt--dis" : "") + '">' +
      '<input type="checkbox" value="' + value.replace(/"/g, "&quot;") + '"' + (state[filter].has(value) ? " checked" : "") + (disabled ? " disabled" : "") + ">" +
      '<span class="cht-fopt__lab">' + label + "</span><span class=\"cht-fopt__ct\">" + count + "</span></label>";
  }
  function setPanel(filter, html) {
    var panel = document.querySelector('.cht-fdrop[data-filter="' + filter + '"] .cht-fdrop__panel');
    if (panel) panel.innerHTML = html;
  }
  // Heat dropdown: two fixed FLOOR options with a ring swatch matching the map
  // (thickness = severity). Values "avg"/"hi" feed state.heat via the generic
  // change handler in wireDropdowns.
  function heatOptionRow(value, label, count) {
    return '<label class="cht-fopt">' +
      '<input type="checkbox" value="' + value + '"' + (state.heat.has(value) ? " checked" : "") + ">" +
      '<span class="cht-fopt__lab">' + label + "</span><span class=\"cht-fopt__ct\">" + count + "</span></label>";
  }

  /* ---- Max-temperature range slider ----
     A minimal dual-handle range: two <input type=range> overlaid, values derived
     with min/max so the handles can cross without breaking the range. Bound to a
     state object ({min,max}) by a DOM id prefix. */
  function sliderHtml(pfx, st, noun) {
    var lo = TEMP_DOMAIN[0], hi = TEMP_DOMAIN[1];
    return '<div class="cht-trange">' +
      '<div class="cht-trange__out"><span id="' + pfx + '-lo">' + st.min + '°</span>' +
      '<span class="cht-trange__dash">–</span>' +
      '<span id="' + pfx + '-hi">' + st.max + '°F</span></div>' +
      '<div class="cht-trange__slider">' +
        '<div class="cht-trange__rail"></div>' +
        '<div class="cht-trange__fill" id="' + pfx + '-fill"></div>' +
        '<input type="range" class="cht-trange__in" id="' + pfx + '-min" min="' + lo + '" max="' + hi + '" step="1" value="' + st.min + '" aria-label="Minimum ' + noun + '">' +
        '<input type="range" class="cht-trange__in" id="' + pfx + '-max" min="' + lo + '" max="' + hi + '" step="1" value="' + st.max + '" aria-label="Maximum ' + noun + '">' +
      "</div>" +
      '<div class="cht-trange__ends"><span>' + lo + '°</span><span>' + hi + '°F</span></div>' +
    "</div>";
  }
  function updateSliderUi(pfx, st) {
    var lo = TEMP_DOMAIN[0], hi = TEMP_DOMAIN[1], span = hi - lo;
    var loEl = document.getElementById(pfx + "-lo"), hiEl = document.getElementById(pfx + "-hi"), fill = document.getElementById(pfx + "-fill");
    if (loEl) loEl.textContent = st.min + "°";
    if (hiEl) hiEl.textContent = st.max + "°F";
    if (fill) { var l = (st.min - lo) / span * 100, r = (st.max - lo) / span * 100; fill.style.left = l + "%"; fill.style.width = (r - l) + "%"; }
  }
  function wireSlider(pfx, st) {
    var mi = document.getElementById(pfx + "-min"), ma = document.getElementById(pfx + "-max");
    if (!mi || !ma) return;
    function sync() {
      st.min = Math.min(+mi.value, +ma.value);
      st.max = Math.max(+mi.value, +ma.value);
      updateSliderUi(pfx, st);
      applyAll();
    }
    mi.addEventListener("input", sync);
    ma.addEventListener("input", sync);
    updateSliderUi(pfx, st);
  }
  // Max temperature dropdown: a 24-hour-max slider first under the "In the last
  // 24 hours:" header, then the historic over-average floors (state.heat).
  function buildHeatPanel() {
    setPanel("heat",
      '<div class="cht-fhead">In the last 24 hours:</div>' +
      sliderHtml("cht-smax", maxState, "24-hour max temperature") +
      heatOptionRow("avg", "Above historic avg", data.filter(isOverAvg).length) +
      heatOptionRow("hi", "10°F above historic avg", data.filter(isOverHi).length));
    wireSlider("cht-smax", maxState);
  }

  function buildDropdowns() {
    buildHeatPanel();

    var jc = {}; data.forEach(function (d) { jc[d.jurisdiction] = (jc[d.jurisdiction] || 0) + 1; });
    setPanel("jurisdiction", Object.keys(jc).sort(function (a, b) { return jc[b] - jc[a]; })
      .map(function (j) { return optionRow("jurisdiction", j, j, jc[j], false); }).join(""));

    var pc = {}; data.forEach(function (d) { var b = popBucketId(d); pc[b] = (pc[b] || 0) + 1; });
    var asOf = meta && meta.vintages && meta.vintages.population_cdcr_as_of;
    var note = '<p class="cht-fnote">Population as of ' + (asOf || "2025") + " where known; unavailable for most non-CDCR facilities.</p>";
    setPanel("population", note + POP_BUCKETS.map(function (b) { return optionRow("population", b.id, b.label, pc[b.id] || 0, !(pc[b.id])); }).join(""));

    var cc = {}; data.forEach(function (d) { cc[d.county] = (cc[d.county] || 0) + 1; });
    setPanel("county", CA_COUNTIES.map(function (c) { return optionRow("county", c, c, cc[c] || 0, !(cc[c])); }).join(""));

    wireDropdowns();
  }

  function updateBadges() {
    document.querySelectorAll(".cht-fdrop").forEach(function (dd) {
      var f = dd.getAttribute("data-filter"), badge = dd.querySelector(".cht-fdrop__badge"), n = state[f].size;
      if (f === "heat" && maxActive()) n += 1;   // the 24h-max slider shares the Max temperature dropdown
      if (badge) { badge.textContent = n; badge.hidden = n === 0; }
      dd.classList.toggle("cht-fdrop--active", n > 0);
    });
    var active = !!anyActive();
    var clear = document.getElementById("cht-clear");
    if (clear) clear.hidden = !active;
    // Mobile: dot on the "Filters" button when any filter/search is active.
    var ft = document.getElementById("cht-filter-toggle");
    if (ft) ft.classList.toggle("cht-filter-toggle--active", active);
    // Keep the alert's "View facilities" link in sync with its active floor.
    var link = document.getElementById("cht-alert-link");
    if (link) link.setAttribute("aria-pressed", state.heat.has(alertTier) ? "true" : "false");
  }

  function applyAll() {
    if (map) applyMapFilter();
    rebuildTable();
    updateBadges();
    persist();
  }

  /* ---- Session persistence: keep the filtered/sorted view (and mobile Map/Table
     pane) across navigation — e.g. opening a detail page and clicking "Back to
     statewide view". Session-scoped (sessionStorage); resets when the tab closes. */
  var SS_KEY = "cht.statewide.v1";
  function persist() {
    try {
      var dash = document.querySelector(".cht-dash");
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        heat: Array.from(state.heat), jurisdiction: Array.from(state.jurisdiction),
        population: Array.from(state.population), county: Array.from(state.county),
        maxMin: maxState.min, maxMax: maxState.max,
        search: state.search, sortKey: sort.key, sortDir: sort.dir,
        view: dash ? dash.getAttribute("data-mobile-view") : null
      }));
    } catch (e) { /* storage unavailable (private mode) — no-op */ }
  }
  function restore() {
    try {
      var s = JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
      if (!s) return;
      state.heat = new Set(s.heat || []); state.jurisdiction = new Set(s.jurisdiction || []);
      state.population = new Set(s.population || []); state.county = new Set(s.county || []);
      if (typeof s.maxMin === "number") maxState.min = s.maxMin;
      if (typeof s.maxMax === "number") maxState.max = s.maxMax;
      state.search = s.search || "";
      if (s.sortKey) { sort.key = s.sortKey; sort.dir = s.sortDir || "desc"; }
      var input = document.getElementById("cht-search");
      if (input) input.value = state.search;
      var dash = document.querySelector(".cht-dash");
      if (dash && s.view) {
        dash.setAttribute("data-mobile-view", s.view);
        document.querySelectorAll(".cht-viewtoggle__btn").forEach(function (b) {
          b.setAttribute("aria-selected", b.getAttribute("data-view") === s.view ? "true" : "false");
        });
      }
    } catch (e) { /* ignore malformed state */ }
  }

  function wireDropdowns() {
    document.querySelectorAll(".cht-fdrop").forEach(function (dd) {
      var f = dd.getAttribute("data-filter");
      var btn = dd.querySelector(".cht-fdrop__btn"), panel = dd.querySelector(".cht-fdrop__panel");
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = panel.hidden;
        closeAllPanels();
        panel.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      panel.addEventListener("click", function (e) { e.stopPropagation(); });
      panel.addEventListener("change", function (e) {
        var cb = e.target; if (cb.type !== "checkbox") return;
        if (cb.checked) state[f].add(cb.value); else state[f].delete(cb.value);
        applyAll();
      });
    });
    document.addEventListener("click", closeAllPanels);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAllPanels(); });
  }
  function closeAllPanels() {
    document.querySelectorAll(".cht-fdrop__panel").forEach(function (p) { p.hidden = true; });
    document.querySelectorAll(".cht-fdrop__btn").forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
  }

  /* ---- CSV download of the current (filtered, sorted) view ---- */
  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function statewideCsv(rows) {
    var head = ["slug", "name", "county", "city", "jurisdiction", "security", "latitude", "longitude",
      "population", "population_as_of", "design_capacity", "pct_of_capacity",
      "avg_summer_max_f", "current_temp_f", "current_temp_as_of", "forecast_high_f", "today_max_f",
      "high_24h_f", "high_24h_at", "f_above_average", "over_average", "over_10f_above_average",
      "aqi", "aqi_category", "website"];
    var lines = [head.join(",")];
    rows.forEach(function (d) {
      var f = d.fac || {}, s = d.status, r = d.row || {}, avg = f.baseline_summer_avg_high_f;
      var cap = f.capacity;
      if (cap == null && f.population != null && f.capacity_pct) cap = Math.round(f.population / f.capacity_pct);
      lines.push([
        d.slug, d.name, d.county, f.city, d.jurisdiction, f.security, d.lat, d.lon,
        f.population, f.population_as_of, cap, f.capacity_pct == null ? "" : (f.capacity_pct * 100).toFixed(0),
        avg, d.currentTemp, d.tempAsOf, r.today_forecast_high_f, s.hasData ? s.todayMax : "",
        d.max24 == null ? "" : d.max24, d.max24At || "",
        (s.hasData && avg != null && s.recentMax != null) ? (s.recentMax - avg).toFixed(1) : "",
        isOverAvg(d) ? "yes" : "no", isOverHi(d) ? "yes" : "no",
        d.aqi, d.aqiCat, f.website
      ].map(csvCell).join(","));
    });
    return lines.join("\n");
  }
  // Always the full dataset (all facilities), sorted by name for a stable file.
  function downloadCurrent() {
    var rows = data.slice().sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
    var blob = new Blob([statewideCsv(rows)], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "ca-carceral-heat-current.csv"; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function wireSort() {
    document.querySelectorAll("#cht-table th[data-sort]").forEach(function (th) {
      var key = th.getAttribute("data-sort");
      th.setAttribute("tabindex", "0");
      function toggle() {
        if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
        else { sort.key = key; sort.dir = (key === "name" || key === "county" || key === "jurisdiction") ? "asc" : "desc"; }
        rebuildTable();
        persist();
      }
      th.addEventListener("click", toggle);
      th.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  function wireControls() {
    var search = document.getElementById("cht-search");
    if (search) search.addEventListener("input", function () { state.search = search.value; applyAll(); });

    var link = document.getElementById("cht-alert-link");
    if (link) link.addEventListener("click", function () { setHeat(alertTier, !state.heat.has(alertTier)); });

    var dismiss = document.getElementById("cht-alert-dismiss");
    if (dismiss) dismiss.addEventListener("click", function () { alertDismissed = true; var a = document.getElementById("cht-alert"); if (a) a.hidden = true; });

    var dl = document.getElementById("cht-download");
    if (dl) dl.addEventListener("click", downloadCurrent);

    var clear = document.getElementById("cht-clear");
    if (clear) clear.addEventListener("click", function () {
      state.heat.clear(); state.jurisdiction.clear(); state.population.clear(); state.county.clear(); state.search = "";
      maxState.min = TEMP_DOMAIN[0]; maxState.max = TEMP_DOMAIN[1];
      var s = document.getElementById("cht-search"); if (s) s.value = "";
      document.querySelectorAll(".cht-fdrop__panel input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
      buildHeatPanel();   // reset the 24h-max slider controls to their defaults
      closeAllPanels();
      applyAll();
    });

    // Mobile: filters + search collapse under a "Filters" button, opening as an
    // overlay OVER the map (positioned just below the mobile bar so the map keeps
    // its height). The toggle button and the "Done" button both collapse it.
    var dashEl = document.querySelector(".cht-dash");
    var fToggle = document.getElementById("cht-filter-toggle");
    var fClose = document.getElementById("cht-filter-close");
    var filtersEl = document.getElementById("cht-filters");
    function positionFilters() {
      if (!filtersEl) return;
      var bar = document.querySelector(".cht-mobilebar");
      filtersEl.style.top = (bar ? bar.offsetTop + bar.offsetHeight : 0) + "px";
    }
    function setFiltersOpen(open) {
      if (!dashEl) return;
      if (open) { positionFilters(); dashEl.setAttribute("data-filters", "open"); }
      else { dashEl.removeAttribute("data-filters"); }
      if (fToggle) fToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (fToggle) fToggle.addEventListener("click", function () { setFiltersOpen(dashEl.getAttribute("data-filters") !== "open"); });
    if (fClose) fClose.addEventListener("click", function () { setFiltersOpen(false); });
    window.addEventListener("resize", function () {
      if (dashEl && dashEl.getAttribute("data-filters") === "open") positionFilters();
    });

    // Mobile Map/Table view toggle.
    var dash = dashEl;
    document.querySelectorAll(".cht-viewtoggle__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        if (dash) dash.setAttribute("data-mobile-view", view);
        document.querySelectorAll(".cht-viewtoggle__btn").forEach(function (b) { b.setAttribute("aria-selected", b === btn ? "true" : "false"); });
        if (view === "map" && map) setTimeout(function () { map.invalidateSize(); }, 30);
        persist();
      });
    });
  }

  function setAsOf() {
    if (!meta) return;
    var t = meta.generated_at ? "as of " + new Date(meta.generated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    var el = document.getElementById("cht-asof"), foot = document.querySelector("[data-cht-asof]");
    if (el) el.textContent = t ? " · " + t : "";
    if (foot) foot.textContent = t ? "Data " + t : "";
  }

  ready(function () {
    Promise.all([
      fetch(STATEWIDE_URL).then(function (r) { return r.json(); }),
      fetch(FACILITIES_URL).then(function (r) { return r.json(); }),
      fetch(BOUND_URL).then(function (r) { return r.json(); }).catch(function () { return { type: "FeatureCollection", features: [] }; })
    ]).then(function (res) {
      var statewide = res[0], facilities = res[1], boundaries = res[2];
      meta = statewide.meta;
      baselinePeriod = ((facilities.meta && facilities.meta.threshold && facilities.meta.threshold.baseline_period) || "").replace("-", "–");
      var facBySlug = {}; facilities.facilities.forEach(function (f) { facBySlug[f.slug] = f; });
      data = statewide.facilities.map(function (row) {
        var fac = facBySlug[row.slug] || {};
        return {
          slug: row.slug, name: row.name, county: row.county, jurisdiction: row.jurisdiction,
          code: fac.cdcr ? fac.cdcr.code : null,
          lat: row.lat, lon: row.lon, currentTemp: row.current_temp_f, tempAsOf: row.current_temp_as_of,
          max24: row.last24h_max_f, max24At: row.last24h_max_at,
          aqi: row.aqi, aqiCat: row.aqi_category,
          status: window.CHTStatus.computeStatus(row.recent_daily_max_f, fac.baseline_summer_avg_high_f, fac.threshold_f, row.last24h_max_f), fac: fac, row: row
        };
      });
      data.forEach(function (d) { bySlug[d.slug] = d; });

      restore();      // hydrate filters/search/sort/view from the last session before first render
      buildDropdowns();
      wireSort();
      wireControls();
      rebuildTable();
      updateBadges();
      updateAlert();
      setAsOf();
      if (window.L) { drawLegend(); drawMap(boundaries); }
    }).catch(function (e) {
      if (window.console) console.error("heat tracker: statewide load failed", e);
      var tbody = document.querySelector("#cht-table tbody");
      if (tbody) tbody.innerHTML = '<tr><td class="cht-empty" colspan="4">Could not load current conditions.</td></tr>';
    });
  });
})();
