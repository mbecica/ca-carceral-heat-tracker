/* ============================================================================
   Per-facility detail map. Ported from PHI phi-detail-map.js.

   Shows ALL facilities as temperature-colored dots (ringed if at/over threshold),
   centered on the selected facility, which gets an accent ring. Every facility
   stays clickable so a visitor can jump to another profile without going back to
   the statewide map. Boundary polygons replace dots past a zoom threshold.
   ============================================================================ */
(function () {
  "use strict";

  var STATEWIDE_URL = "/data/statewide.json";
  var FACILITIES_URL = "/data/facilities.json";
  var BOUND_URL = "/data/facility_boundaries.geojson";
  var POLY_ZOOM = 11, DOT_R = 5;
  var BASEMAP = "light_all";   // keep in sync with cht-statewide.js

  function isMobile() { return window.matchMedia && window.matchMedia("(max-width: 820px)").matches; }
  function isDark() { return document.documentElement.dataset.theme === "dark"; }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function tileUrl() { return "https://{s}.basemaps.cartocdn.com/" + BASEMAP + "/{z}/{x}/{y}{r}.png"; }
  function slugPath(slug) { return "/" + slug + "/"; }
  function ready(fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  function fmt(n) { return n == null || isNaN(n) ? "—" : Math.round(n); }
  function fmtAsOf(s) { try { return new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }); } catch (e) { return s; } }
  // One aligned tooltip temperature row (label · right value · muted timestamp).
  function tempRow(label, val, time) {
    return '<span class="cht-ltip__k">' + label + "</span>" +
      '<span class="cht-ltip__v">' + (val != null ? fmt(val) + "°F" : "—") + "</span>" +
      '<span class="cht-ltip__t">' + (time || "") + "</span>";
  }
  // EPA AQI category color (kept in sync with cht-statewide.js).
  function aqiColor(a) {
    if (a == null) return cssVar("--cht-null");
    if (a <= 50) return "#00e400"; if (a <= 100) return "#ffd000"; if (a <= 150) return "#ff7e00";
    if (a <= 200) return "#ff0000"; if (a <= 300) return "#8f3f97"; return "#7e0023";
  }

  var started = false, baselinePeriod = "";

  ready(function () {
    // No map at mobile widths; but if the window is later widened to desktop,
    // initialize it then (so a page opened on mobile still gets a map when widened).
    if (isMobile()) {
      var onResize = function () {
        if (!isMobile() && !started) { window.removeEventListener("resize", onResize); init(); }
      };
      window.addEventListener("resize", onResize);
      return;
    }
    init();
  });

  function init() {
    if (started) return;
    started = true;
    var el = document.getElementById("cht-detail-map");
    if (!el || !window.L) { if (el) el.style.display = "none"; return; }
    var activeSlug = el.getAttribute("data-slug");

    Promise.all([
      fetch(STATEWIDE_URL).then(function (r) { return r.json(); }),
      fetch(FACILITIES_URL).then(function (r) { return r.json(); }),
      fetch(BOUND_URL).then(function (r) { return r.json(); }).catch(function () { return { type: "FeatureCollection", features: [] }; })
    ]).then(function (res) {
      var statewide = res[0], facilities = res[1], boundaries = res[2];
      baselinePeriod = ((facilities.meta && facilities.meta.threshold && facilities.meta.threshold.baseline_period) || "").replace("-", "–");
      var facBySlug = {}; facilities.facilities.forEach(function (f) { facBySlug[f.slug] = f; });
      var data = statewide.facilities.map(function (row) {
        var fac = facBySlug[row.slug] || {};
        return { slug: row.slug, name: row.name, county: row.county, jurisdiction: row.jurisdiction,
          code: fac.cdcr ? fac.cdcr.code : null,
          lat: row.lat, lon: row.lon, temp: row.current_temp_f,
          tempAsOf: row.current_temp_as_of, aqi: row.aqi, aqiCat: row.aqi_category,
          max24: row.last24h_max_f, max24At: row.last24h_max_at,
          avg: fac.baseline_summer_avg_high_f,
          status: window.CHTStatus.computeStatus(row.recent_daily_max_f, fac.baseline_summer_avg_high_f, fac.threshold_f, row.last24h_max_f) };
      });
      var bySlug = {}; data.forEach(function (d) { bySlug[d.slug] = d; });
      var active = bySlug[activeSlug];
      if (!active || active.lat == null) { el.style.display = "none"; return; }

      function fill(d) { return window.CHTTempScale.tempColor(d.temp) || cssVar("--cht-null"); }
      // Ring thickness = status severity (matches the statewide map); active
      // facility keeps its accent ring.
      function stroke(d) {
        if (d.slug === activeSlug) return { color: cssVar("--accent"), weight: 3.5 };
        if (d.status.hasData && d.status.overHi) return { color: cssVar("--cht-ring"), weight: 3.5 };
        if (d.status.hasData && d.status.overAvg) return { color: cssVar("--cht-ring"), weight: 2 };
        return { color: cssVar("--cht-map-stroke"), weight: 1.2 };
      }
      // Identical body to the statewide map tooltip (cht-statewide.js contentHtml):
      // name, place, aligned temp list (Latest / 24 Hour Max / Historic avg max), AQI.
      function tip(d) {
        var nm = d.code ? d.name.replace(/\s*\([^)]*\)\s*$/, "") + ' <span class="cht-tcode">' + d.code + "</span>" : d.name;
        var temps = '<span class="cht-ltip__temps">' +
          tempRow("Latest", d.temp, d.tempAsOf ? fmtAsOf(d.tempAsOf) : "") +
          (d.max24 != null ? tempRow("24 hour max", d.max24, d.max24At ? fmtAsOf(d.max24At) : "") : "") +
          (d.avg != null ? tempRow("Historic avg max", d.avg, baselinePeriod ? "(" + baselinePeriod + ")" : "") : "") +
          "</span>";
        var aqi = d.aqi != null
          ? '<span class="cht-ltip__val">AQI ' + d.aqi + (d.aqiCat ? " · " + d.aqiCat : "") + '<i class="cht-aqi-mini" style="background:' + aqiColor(d.aqi) + '"></i></span>'
          : "";
        return '<span class="cht-ltip__name">' + nm + "</span>" +
          '<span class="cht-ltip__sub">' + (d.county || "") + " County · " + (d.jurisdiction || "") + "</span>" +
          temps + aqi;
      }

      var map = L.map("cht-detail-map", { center: [active.lat, active.lon], zoom: 6, scrollWheelZoom: true });
      map.zoomControl.setPosition("topright");
      var tiles = L.tileLayer(tileUrl(), {
        subdomains: "abcd", maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }).addTo(map);

      var circles = {}, polys = {};
      var circleGroup = L.featureGroup();
      data.forEach(function (d) {
        if (d.lat == null || d.lon == null) return;
        var isA = d.slug === activeSlug, st = stroke(d);
        var m = L.circleMarker([d.lat, d.lon], {
          radius: DOT_R + (isA ? 2 : 0), weight: st.weight, color: st.color, opacity: 1,
          fillColor: fill(d), fillOpacity: isA ? 0.95 : 0.85
        });
        m.bindTooltip(tip(d), { direction: "top", className: "cht-ltip", opacity: 1 });
        m.on("click", function () { if (!isA) window.location.href = slugPath(d.slug); });
        circles[d.slug] = m; circleGroup.addLayer(m);
      });
      if (circles[activeSlug]) circles[activeSlug].bringToFront();

      var polyGroup = L.geoJSON(boundaries, {
        onEachFeature: function (feat, layer) {
          var d = bySlug[feat.properties.slug]; if (!d) return;
          var isA = d.slug === activeSlug, st = stroke(d);
          polys[d.slug] = layer;
          layer.setStyle({ fillColor: fill(d), color: st.color, weight: st.weight, fillOpacity: isA ? 0.8 : 0.6 });
          layer.bindTooltip(tip(d), { sticky: true, className: "cht-ltip", opacity: 1 });
          layer.on("click", function () { if (!isA) window.location.href = slugPath(d.slug); });
        }
      });

      var polyShown = false;
      function updateMode() {
        var wantPoly = map.getZoom() >= POLY_ZOOM;
        if (wantPoly && !polyShown) { map.removeLayer(circleGroup); polyGroup.addTo(map); polyShown = true; }
        else if (!wantPoly && polyShown) { map.removeLayer(polyGroup); circleGroup.addTo(map); polyShown = false; }
      }
      circleGroup.addTo(map);
      map.on("zoomend", updateMode);
      var activePoly = polys[activeSlug];
      if (activePoly && activePoly.getBounds().isValid()) map.fitBounds(activePoly.getBounds(), { padding: [90, 90], maxZoom: 13, animate: false });
      else map.setView([active.lat, active.lon], 12, { animate: false });
      updateMode();

      setTimeout(function () { map.invalidateSize(); }, 60);
      window.addEventListener("resize", function () { map.invalidateSize(); });
      var onTheme = function () {
        tiles.setUrl(tileUrl());
        data.forEach(function (d) {
          var st = stroke(d), f = fill(d);
          if (circles[d.slug]) circles[d.slug].setStyle({ fillColor: f, color: st.color });
          if (polys[d.slug]) polys[d.slug].setStyle({ fillColor: f, color: st.color });
        });
      };
      document.addEventListener("cht:themechange", onTheme);
      if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
    }).catch(function () { el.style.display = "none"; });
  }
})();
