/* ============================================================================
   Historic temperatures (detail page): days per year at or above a threshold,
   for a chosen date range, plus the total for the whole range.

   Data: history/{slug}.json (final years, 1991 → …) + history/current/{slug}.json
   (the year(s) PRISM is still revising). Both are { start, end, tmax:[°F] } with
   one value per day from `start`; they meet with no gap, so they're joined into
   one array indexed by day offset from 1991-01-01. Loaded only when the section
   scrolls near view.

   The threshold is applied here, never baked into the data: a preset or custom
   °F, or "avg" = the facility's threshold_f (the same number the rest of the site
   uses — just a shortcut to that °F, so it works for every year). A day counts
   when its high is AT OR ABOVE the threshold, matching cht-status.js.

   State lives in the URL (?t=97&range=last5, or ?t=95&from=2018-03-14&to=2022-09-01)
   so a result can be linked to or cited.
   ============================================================================ */
(function () {
  "use strict";

  var DAY = 86400000;
  var T_MIN = 50, T_MAX = 125;
  var DEFAULT_T = "90", DEFAULT_RANGE = "last10";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function ready(fn) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn(); }
  function $(id) { return document.getElementById(id); }

  // Dates are plain calendar days, handled in UTC so no time zone can shift them.
  function parse(iso) { var p = iso.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function ymd(y, m, d) { return Date.UTC(y, m, d); }
  function yearOf(t) { return new Date(t).getUTCFullYear(); }
  function fmtDate(t) { var d = new Date(t); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
  function fmtShort(t) { var d = new Date(t); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate(); }
  function fmtN(n) { return n.toLocaleString("en-US"); }
  function hasOption(sel, v) { return Array.prototype.some.call(sel.options, function (o) { return o.value === v; }); }
  function validT(v) { return /^\d{2,3}$/.test(v) && +v >= T_MIN && +v <= T_MAX; }

  ready(function () {
    var root = $("cht-hist");
    if (!root) return;
    var slug = root.getAttribute("data-slug");
    var avgT = root.getAttribute("data-threshold");
    avgT = avgT === "" || avgT == null ? null : +avgT;

    var els = {
      thr: $("cht-hist-thr"), range: $("cht-hist-range"), custom: $("cht-hist-custom"),
      tCustom: $("cht-hist-tcustom"), tVal: $("cht-hist-tval"),
      dCustom: $("cht-hist-dcustom"), d0: $("cht-hist-d0"), d1: $("cht-hist-d1"),
      total: $("cht-hist-total"), totalSub: $("cht-hist-total-sub"),
      chart: $("cht-hist-chart"), table: $("cht-hist-table")
    };
    var data = null;   // { t0, last, v:[°F per day from t0] }
    // t: preset °F string, "avg", or a custom °F string (tCustom marks which).
    var state = { t: DEFAULT_T, tCustom: false, range: DEFAULT_RANGE, from: null, to: null };

    readUrl();

    // ---- Load lazily -------------------------------------------------------
    function load() {
      Promise.all([
        fetch("/data/history/" + slug + ".json").then(function (r) { return r.json(); }),
        fetch("/data/history/current/" + slug + ".json").then(function (r) { return r.json(); })
      ]).then(function (res) {
        var a = res[0], c = res[1];
        if (parse(a.end) + DAY !== parse(c.start)) throw new Error("history files don't meet");
        data = { t0: parse(a.start), last: parse(c.end), v: a.tmax.concat(c.tmax) };
        labelPresets();
        els.d0.min = els.d1.min = iso(data.t0); els.d0.max = els.d1.max = iso(data.last);
        syncControls();
        render();
      }).catch(function () {
        els.total.textContent = "—";
        els.totalSub.textContent = "History unavailable right now.";
      });
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { io.disconnect(); load(); }
      }, { rootMargin: "400px" });
      io.observe(root);
    } else { load(); }

    // Preset labels carry real years, from the latest day in the data.
    function labelPresets() {
      var Y = yearOf(data.last);
      els.range.querySelector('[value="ytd"]').textContent = Y + " so far";
      els.range.querySelector('[value="pair"]').textContent = (Y - 1) + " and " + Y;
      els.range.querySelector('[value="all"]').textContent = "Since " + yearOf(data.t0);
    }

    // ---- Range resolution ---------------------------------------------------
    function presetRange(key) {
      var L = data.last, Y = yearOf(L);
      switch (key) {
        case "ytd":    return [ymd(Y, 0, 1), L];
        case "pair":   return [ymd(Y - 1, 0, 1), L];
        case "last5":  return [ymd(Y - 4, 0, 1), L];
        case "last10": return [ymd(Y - 9, 0, 1), L];
        case "all":    return [data.t0, L];
      }
      return null;
    }

    // [from, to] clamped to the data.
    function resolve() {
      var r = state.range === "custom" ? [state.from, state.to] : presetRange(state.range);
      var from = Math.max(r[0], data.t0), to = Math.min(r[1], data.last);
      return [from, Math.max(from, to)];
    }

    // ---- Counting -----------------------------------------------------------
    function count(from, to) {
      var T = state.t === "avg" ? avgT : +state.t;
      var years = [], total = 0;
      for (var y = yearOf(from); y <= yearOf(to); y++) {
        var a = Math.max(from, ymd(y, 0, 1)), b = Math.min(to, ymd(y, 11, 31));
        var n = 0;
        for (var t = a; t <= b; t += DAY) {
          var v = data.v[Math.round((t - data.t0) / DAY)];
          if (v != null && v >= T) n++;
        }
        var partial = a !== ymd(y, 0, 1) || b !== ymd(y, 11, 31);
        years.push({ year: y, n: n, from: a, to: b, partial: partial, soFar: b === data.last && partial });
        total += n;
      }
      return { T: T, years: years, total: total };
    }

    // ---- Render -------------------------------------------------------------
    function tLabel(T) { return state.t === "avg" ? "10°F above average max (" + Math.round(T) + "°F)" : T + "°F"; }

    function render() {
      if (!data) return;
      var r = resolve(), res = count(r[0], r[1]);

      els.total.textContent = fmtN(res.total);
      els.totalSub.innerHTML = (res.total === 1 ? "day" : "days") + " at or above <strong>" + tLabel(res.T) +
        "</strong> · " + fmtDate(r[0]) + " – " + fmtDate(r[1]);

      els.table.querySelector("tbody").innerHTML = res.years.map(function (d) {
        return "<tr><td>" + d.year + "</td><td>" + d.n + "</td><td>" + fmtDate(d.from) + " – " + fmtDate(d.to) + "</td></tr>";
      }).join("");

      drawChart(res);   // always drawn, even for one year, so the layout doesn't jump
      writeUrl();
    }

    function drawChart(res) {
      var d3 = window.d3, el = els.chart;
      if (!d3) return;
      el.innerHTML = "";
      var ys = res.years;
      var margin = { top: 18, right: 8, bottom: 24, left: 44 };
      var width = Math.max(280, el.clientWidth || 480), height = 220;
      var iw = width - margin.left - margin.right, ih = height - margin.top - margin.bottom;
      var svg = d3.select(el).append("svg").attr("viewBox", "0 0 " + width + " " + height)
        .attr("preserveAspectRatio", "xMidYMid meet");
      var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

      var x = d3.scalePoint().domain(ys.map(function (d) { return d.year; })).range([0, iw]).padding(0.5);
      var ymax = d3.max(ys, function (d) { return d.n; }) || 1;
      var y = d3.scaleLinear().domain([0, ymax]).nice(4).range([ih, 0]);
      var step = x.step();

      g.append("g").attr("class", "cht-grid").selectAll("line").data(y.ticks(4)).enter().append("line")
        .attr("class", "cht-gridline").attr("x1", 0).attr("x2", iw)
        .attr("y1", function (d) { return y(d); }).attr("y2", function (d) { return y(d); });
      var every = Math.ceil(ys.length / Math.max(1, Math.floor(iw / 42)));
      g.append("g").attr("class", "cht-axis").attr("transform", "translate(0," + ih + ")")
        .call(d3.axisBottom(x).tickSizeOuter(0).tickValues(ys.map(function (d) { return d.year; })
          .filter(function (yr, i) { return (ys.length - 1 - i) % every === 0; })));
      g.append("g").attr("class", "cht-axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("d")).tickSizeOuter(0));
      g.append("text").attr("class", "cht-hist-ylabel").attr("transform", "rotate(-90)")
        .attr("x", -ih / 2).attr("y", -margin.left + 11).attr("text-anchor", "middle").text("Days");

      // Dots: filled for a whole year, hollow for part of one.
      var dots = g.append("g").selectAll("circle").data(ys).enter().append("circle")
        .attr("class", function (d) { return "cht-hist-dot" + (d.partial ? " cht-hist-dot--partial" : ""); })
        .attr("cx", function (d) { return x(d.year); }).attr("cy", function (d) { return y(d.n); })
        .attr("r", step >= 14 ? 5 : 4);

      // Values above the dots when there's room.
      if (step >= 24) {
        g.append("g").selectAll("text").data(ys).enter().append("text").attr("class", "cht-hist-val")
          .attr("x", function (d) { return x(d.year); }).attr("y", function (d) { return y(d.n) - 9; })
          .attr("text-anchor", "middle").text(function (d) { return d.n; });
      }

      // Hover: each year's whole column is the hit target.
      var tip = document.querySelector(".cht-hist-tip");
      if (!tip) { tip = document.createElement("div"); tip.className = "cht-chart__tip cht-hist-tip"; document.body.appendChild(tip); }
      g.append("g").selectAll("rect").data(ys).enter().append("rect")
        .attr("x", function (d) { return x(d.year) - step / 2; }).attr("width", step).attr("y", 0).attr("height", ih)
        .style("fill", "transparent")
        .on("mousemove", function (event, d) {
          dots.classed("cht-hist-dot--hover", function (b) { return b === d; });
          var note = d.soFar ? "<br>So far this year: " + fmtShort(d.from) + " – " + fmtShort(d.to)
                   : d.partial ? "<br>" + fmtShort(d.from) + " – " + fmtShort(d.to) + " only" : "";
          tip.innerHTML = "<strong>" + d.year + "</strong> · " + d.n + (d.n === 1 ? " day" : " days") + note;
          // Flip to the cursor's left near the right edge so it never runs off screen.
          var w = tip.offsetWidth;
          tip.style.left = (event.clientX + 12 + w > window.innerWidth - 8 ? event.clientX - 12 - w : event.clientX + 12) + "px";
          tip.style.top = (event.clientY - 10) + "px";
          tip.classList.add("cht-chart__tip--in");
        })
        .on("mouseleave", function () { dots.classed("cht-hist-dot--hover", false); tip.classList.remove("cht-chart__tip--in"); });
    }

    // ---- Controls -----------------------------------------------------------
    function syncControls() {
      els.thr.value = state.tCustom ? "custom" : state.t;
      els.range.value = state.range;
      els.tCustom.hidden = !state.tCustom;
      els.dCustom.hidden = state.range !== "custom";
      els.custom.hidden = els.tCustom.hidden && els.dCustom.hidden;
      if (state.tCustom) els.tVal.value = state.t;
      if (data && state.range === "custom") {
        var r = resolve();
        els.d0.value = iso(r[0]); els.d1.value = iso(r[1]);
      }
    }

    function toCustomRange(from, to) { state.range = "custom"; state.from = from; state.to = to; }

    els.thr.addEventListener("change", function () {
      if (els.thr.value === "custom") {
        state.tCustom = true;   // keep the current number as the starting value
        if (state.t === "avg") state.t = String(Math.round(avgT));
        syncControls(); els.tVal.focus(); render();
        return;
      }
      state.tCustom = false;
      state.t = els.thr.value;
      syncControls(); render();
    });
    els.tVal.addEventListener("input", function () {
      if (!validT(els.tVal.value)) return;   // wait for a whole °F in range
      state.t = String(+els.tVal.value); render();
    });
    els.tVal.addEventListener("change", function () { syncControls(); });   // snap an invalid entry back
    els.range.addEventListener("change", function () {
      if (els.range.value === "custom") { var r = resolve(); toCustomRange(r[0], r[1]); }
      else state.range = els.range.value;
      syncControls(); render();
    });
    function datesChanged() {
      if (!els.d0.value || !els.d1.value) return;
      var a = parse(els.d0.value), b = parse(els.d1.value);
      if (b < a) { var s = a; a = b; b = s; }
      toCustomRange(a, b); syncControls(); render();
    }
    els.d0.addEventListener("change", datesChanged);
    els.d1.addEventListener("change", datesChanged);

    // ---- URL state ----------------------------------------------------------
    function readUrl() {
      var q = new URLSearchParams(location.search);
      var t = q.get("t");
      if (t === "avg" && avgT != null) state.t = t;
      else if (t && validT(t)) { state.t = String(+t); state.tCustom = !hasOption(els.thr, state.t); }
      var f = q.get("from"), to = q.get("to"), r = q.get("range");
      if (f && to && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        var a = parse(f), b = parse(to);
        toCustomRange(Math.min(a, b), Math.max(a, b));
      } else if (r && r !== "custom" && hasOption(els.range, r)) {
        state.range = r;
      }
      syncControls();
    }
    function writeUrl() {
      var q = new URLSearchParams(location.search);
      ["t", "range", "from", "to"].forEach(function (k) { q.delete(k); });
      if (state.t !== DEFAULT_T) q.set("t", state.t);
      if (state.range === "custom") { var r = resolve(); q.set("from", iso(r[0])); q.set("to", iso(r[1])); }
      else if (state.range !== DEFAULT_RANGE) q.set("range", state.range);
      var s = q.toString();
      history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
    }

    var rt;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(render, 150); });
  });
})();
