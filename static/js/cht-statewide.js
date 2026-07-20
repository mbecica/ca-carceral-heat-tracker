/* ============================================================================
   Statewide dashboard controller.

   Joins static/data/statewide.json (raw live rows) + facilities.json (comparison
   line, jurisdiction, population, county) on `slug`, computes each facility's
   status client-side via CHTStatus, and drives a Leaflet map + client-sorted
   table. Page-wide filters — an "10°F+ above normal" toggle, jurisdiction /
   population / county multi-select, and search — narrow the map AND the table
   together; "Clear all" resets. A dismissable alert flags the over-normal count.

   Map: dot FILL = absolute current temperature (CHTTempScale); a RING marks
   facilities 10°F or more above their summer normal. On mobile a Map/Table toggle
   switches panes and tapping a dot opens a popup with a "View details" link.
   ============================================================================ */
(function () {
  "use strict";

  var STATEWIDE_URL = "/data/statewide.json";
  var FACILITIES_URL = "/data/facilities.json";
  var BOUND_URL = "/data/facility_boundaries.geojson";
  var POLY_ZOOM = 10, DOT_R = 5;
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

  var state = { overOnly: false, jurisdiction: new Set(), population: new Set(), county: new Set(), search: "" };
  var sort = { key: "today", dir: "desc" };   // default: hottest current temperature first
  var data = [], bySlug = {}, meta = null, alertDismissed = false;
  var map = null, tiles = null, circleGroup = null, polyGroup = null, polyShown = false, userMarker = null;
  var circles = {}, polys = {};

  function ready(fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  function isMobile() { return window.matchMedia && window.matchMedia("(max-width: 820px)").matches; }
  function isDark() { return document.documentElement.dataset.theme === "dark"; }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function slugPath(slug) { return "/" + slug + "/"; }
  function tileUrl() { return "https://{s}.basemaps.cartocdn.com/" + BASEMAP + "/{z}/{x}/{y}{r}.png"; }
  function fillFor(d) { return window.CHTTempScale.tempColor(d.currentTemp) || cssVar("--cht-null"); }
  function isOver(d) { return d.status.hasData && d.status.over; }
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

  function strokeStyle(d) {
    return isOver(d)
      ? { color: cssVar("--cht-over"), weight: 3, opacity: 1 }
      : { color: cssVar("--cht-map-stroke"), weight: 1, opacity: 1 };
  }

  /* Shared tooltip/popup body: name, place, current temp + as-of, avg summer max, AQI. */
  function contentHtml(d) {
    var t = d.currentTemp;
    var now = t != null ? fmt(t) + "°F" + (d.tempAsOf ? " · as of " + fmtAsOf(d.tempAsOf) : "") : "—";
    var avg = d.fac && d.fac.baseline_summer_avg_high_f;
    var avgLine = avg != null ? '<span class="cht-ltip__sub">Avg. summer max: ' + fmt(avg) + "°F</span>" : "";
    var aqi = d.aqi != null
      ? '<span class="cht-ltip__val">AQI ' + d.aqi + (d.aqiCat ? " · " + d.aqiCat : "") + '<i class="cht-aqi-mini" style="background:' + aqiColor(d.aqi) + '"></i></span>'
      : "";
    return '<span class="cht-ltip__name">' + baseName(d) + codePill(d) + "</span>" +
      '<span class="cht-ltip__sub">' + (d.county || "") + " County · " + (d.jurisdiction || "") + "</span>" +
      '<span class="cht-ltip__val">Now: ' + now + "</span>" + avgLine + aqi;
  }
  function popupHtml(d) {
    return '<div class="cht-lpop__body">' + contentHtml(d) +
      '<a class="cht-lpop__link" href="' + slugPath(d.slug) + '">View details →</a></div>';
  }

  function matches(d) {
    if (state.overOnly && !isOver(d)) return false;
    if (state.jurisdiction.size && !state.jurisdiction.has(d.jurisdiction)) return false;
    if (state.population.size && !state.population.has(popBucketId(d))) return false;
    if (state.county.size && !state.county.has(d.county)) return false;
    var q = state.search.trim().toLowerCase();
    if (q && (d.name || "").toLowerCase().indexOf(q) < 0 && (d.county || "").toLowerCase().indexOf(q) < 0) return false;
    return true;
  }
  function anyActive() { return state.overOnly || state.jurisdiction.size || state.population.size || state.county.size || state.search.trim(); }

  function highlight(slug, on) {
    if (circles[slug]) circles[slug].setStyle({ weight: on ? 4 : strokeStyle(bySlug[slug]).weight });
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
    data.slice().sort(function (a, b) { return (isOver(a) ? 1 : 0) - (isOver(b) ? 1 : 0); }).forEach(function (d) {
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

  /* ---- Geolocation: "My location" control in the legend ---- */
  function locateMe() {
    if (!map || !navigator.geolocation) return;
    map.locate({ setView: true, maxZoom: 11, enableHighAccuracy: true });
  }
  function wireLocate() {
    var btn = document.getElementById("cht-locate");
    if (btn) btn.addEventListener("click", locateMe);
    if (!map) return;
    map.on("locationfound", function (e) {
      if (userMarker) userMarker.setLatLng(e.latlng);
      else userMarker = L.circleMarker(e.latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#2f6fd0", fillOpacity: 1 }).addTo(map).bindTooltip("You are here", { className: "cht-ltip" });
    });
    map.on("locationerror", function () { if (window.console) console.warn("heat tracker: location unavailable"); });
  }

  function drawLegend() {
    var el = document.getElementById("cht-legend"); if (!el) return;
    var cells = window.CHTTempScale.legendCells(55, 110, 5)
      .map(function (c) { return '<span class="cht-legend__scale-cell" style="background:' + c.color + '"></span>'; }).join("");
    el.innerHTML =
      '<span class="cht-legend__group"><span class="cht-legend__ends">55°</span>' +
      '<span class="cht-legend__scale">' + cells + "</span>" +
      '<span class="cht-legend__ends">110°F now</span></span>' +
      '<span class="cht-legend__item"><span class="cht-legend__ring"></span>10°F above average</span>' +
      '<span class="cht-legend__item"><span class="cht-legend__swatch" style="background:var(--cht-null)"></span>no data</span>' +
      '<button type="button" class="cht-locate" id="cht-locate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>My location</button>';
    wireLocate();
  }

  function sortVal(d, key) {
    var s = d.status;
    if (key === "name") return d.name || "";
    if (key === "county") return d.county || "";
    if (key === "jurisdiction") return d.jurisdiction || "";
    if (key === "today") return s.hasData ? s.todayMax : -Infinity;
    if (key === "over") return s.hasData ? s.deltaF : -Infinity;
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
      tbody.innerHTML = '<tr><td class="cht-empty" colspan="4">No facilities match.</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function (d) {
        var s = d.status;
        return '<tr data-slug="' + d.slug + '">' +
          '<td class="cht-cell-name"><span class="cht-cell-dot" style="background:' + fillFor(d) + '"></span><a href="' + slugPath(d.slug) + '">' + baseName(d) + "</a>" + codePill(d) + "</td>" +
          '<td class="cht-hide-sm">' + (d.county || "") + "</td>" +
          '<td class="cht-hide-md">' + (d.jurisdiction || "") + "</td>" +
          '<td class="cht-num">' + (s.hasData ? fmt(s.todayMax) + "°" : "—") + "</td>" +
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

  /* ---- Alert (statewide total over normal) ---- */
  function updateAlert() {
    var n = data.filter(isOver).length;
    var el = document.getElementById("cht-alert");
    var cEl = document.getElementById("cht-alert-count"), lEl = document.getElementById("cht-alert-label"), link = document.getElementById("cht-alert-link");
    if (cEl) cEl.textContent = n;
    if (lEl) lEl.textContent = (n === 1 ? "facility is" : "facilities are") + " currently 10°F or more above their average summer maximum";
    if (link) link.textContent = "View " + n + (n === 1 ? " facility" : " facilities");
    if (el) el.hidden = alertDismissed || n === 0;
  }

  function setOverOnly(on) {
    state.overOnly = on;
    var toggle = document.getElementById("cht-over-toggle"), link = document.getElementById("cht-alert-link");
    if (toggle) toggle.setAttribute("aria-pressed", on ? "true" : "false");
    if (link) link.setAttribute("aria-pressed", on ? "true" : "false");
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
  function buildDropdowns() {
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
      if (badge) { badge.textContent = n; badge.hidden = n === 0; }
      dd.classList.toggle("cht-fdrop--active", n > 0);
    });
    var clear = document.getElementById("cht-clear");
    if (clear) clear.hidden = !anyActive();
  }

  function applyAll() {
    if (map) applyMapFilter();
    rebuildTable();
    updateBadges();
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
      "avg_summer_max_f", "current_temp_f", "current_temp_as_of", "today_max_f",
      "f_above_average", "flagged_above_average", "aqi", "aqi_category", "website"];
    var lines = [head.join(",")];
    rows.forEach(function (d) {
      var f = d.fac || {}, s = d.status, avg = f.baseline_summer_avg_high_f;
      var cap = f.capacity;
      if (cap == null && f.population != null && f.capacity_pct) cap = Math.round(f.population / f.capacity_pct);
      lines.push([
        d.slug, d.name, d.county, f.city, d.jurisdiction, f.security, d.lat, d.lon,
        f.population, f.population_as_of, cap, f.capacity_pct == null ? "" : (f.capacity_pct * 100).toFixed(0),
        avg, d.currentTemp, d.tempAsOf, s.hasData ? s.todayMax : "",
        (s.hasData && avg != null) ? (s.todayMax - avg).toFixed(1) : "", isOver(d) ? "yes" : "no",
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
      }
      th.addEventListener("click", toggle);
      th.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  function wireControls() {
    var search = document.getElementById("cht-search");
    if (search) search.addEventListener("input", function () { state.search = search.value; applyAll(); });

    var over = document.getElementById("cht-over-toggle");
    if (over) over.addEventListener("click", function () { setOverOnly(!state.overOnly); });

    var link = document.getElementById("cht-alert-link");
    if (link) link.addEventListener("click", function () { setOverOnly(!state.overOnly); });

    var dismiss = document.getElementById("cht-alert-dismiss");
    if (dismiss) dismiss.addEventListener("click", function () { alertDismissed = true; var a = document.getElementById("cht-alert"); if (a) a.hidden = true; });

    var dl = document.getElementById("cht-download");
    if (dl) dl.addEventListener("click", downloadCurrent);

    var clear = document.getElementById("cht-clear");
    if (clear) clear.addEventListener("click", function () {
      state.jurisdiction.clear(); state.population.clear(); state.county.clear(); state.search = "";
      var s = document.getElementById("cht-search"); if (s) s.value = "";
      document.querySelectorAll(".cht-fdrop__panel input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
      closeAllPanels();
      setOverOnly(false);   // also clears the over toggle, then applyAll runs
    });

    // Mobile Map/Table view toggle.
    var dash = document.querySelector(".cht-dash");
    document.querySelectorAll(".cht-viewtoggle__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        if (dash) dash.setAttribute("data-mobile-view", view);
        document.querySelectorAll(".cht-viewtoggle__btn").forEach(function (b) { b.setAttribute("aria-selected", b === btn ? "true" : "false"); });
        if (view === "map" && map) setTimeout(function () { map.invalidateSize(); }, 30);
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
      var facBySlug = {}; facilities.facilities.forEach(function (f) { facBySlug[f.slug] = f; });
      data = statewide.facilities.map(function (row) {
        var fac = facBySlug[row.slug] || {};
        return {
          slug: row.slug, name: row.name, county: row.county, jurisdiction: row.jurisdiction,
          code: fac.cdcr ? fac.cdcr.code : null,
          lat: row.lat, lon: row.lon, currentTemp: row.current_temp_f, tempAsOf: row.current_temp_as_of,
          aqi: row.aqi, aqiCat: row.aqi_category,
          status: window.CHTStatus.computeStatus(row.recent_daily_max_f, fac.threshold_f), fac: fac, row: row
        };
      });
      data.forEach(function (d) { bySlug[d.slug] = d; });

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
