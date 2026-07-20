/* ============================================================================
   14-day hourly temperature chart (D3). The one genuinely new component.

   Draws: the facility's recent hourly trace, the 2016–2025 historic envelope for
   the SAME calendar window (shaded min–max + dashed median), a dashed horizontal
   threshold line, and day gridlines. Colors come from CSS classes so light/dark
   track automatically; only resize triggers a redraw.

   The band file is 3672 values = 153 season-days (Jun 1–Oct 31) × 24 hours. Each
   recent hourly point is matched to its hour-of-season index so the band aligns
   under the trace. Exposed on window.CHTChart.
   ============================================================================ */
(function () {
  "use strict";

  var DAYS_BEFORE = { 6: 0, 7: 30, 8: 61, 9: 92, 10: 122 };  // days from Jun 1 to month start
  var SEASON_HOURS = 153 * 24;

  function localParts(date, tz) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, month: "numeric", day: "numeric", hour: "numeric", hour12: false
    }).formatToParts(date).reduce(function (o, p) { o[p.type] = p.value; return o; }, {});
    return { month: +parts.month, day: +parts.day, hour: (+parts.hour) % 24 };
  }

  // Band index for a UTC Date in the facility's local season, or null if off-season.
  function bandIndex(date, tz) {
    var p = localParts(date, tz);
    if (!(p.month in DAYS_BEFORE)) return null;
    var idx = (DAYS_BEFORE[p.month] + (p.day - 1)) * 24 + p.hour;
    return idx >= 0 && idx < SEASON_HOURS ? idx : null;
  }

  function fmtDate(date, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(date);
  }
  function fmtDateTime(date, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", hour12: true }).format(date);
  }

  function draw(el, opts) {
    if (!el || !window.d3) return;
    el.__opts = opts;   // let the page redraw on resize with the same inputs
    var d3 = window.d3, tz = opts.tz || "America/Los_Angeles";
    var threshold = opts.threshold != null ? +opts.threshold : null;
    var band = opts.band || null;

    var pts = (opts.hourly || []).filter(function (h) { return h && h.f != null; })
      .map(function (h) { return { date: new Date(h.t), f: +h.f }; });
    if (pts.length < 2) { el.innerHTML = '<p class="cht-na">Not enough recent data to chart.</p>'; return; }

    // Aligned band series under each recent point.
    var bandPts = pts.map(function (pt) {
      if (!band) return null;
      var i = bandIndex(pt.date, tz);
      if (i == null) return null;
      return { date: pt.date, min: band.min[i], median: band.median[i], max: band.max[i] };
    });
    var hasBand = band && bandPts.some(function (b) { return b; });
    var bandClean = bandPts.filter(Boolean);

    el.innerHTML = "";
    var margin = { top: 12, right: 14, bottom: 24, left: 34 };
    var width = Math.max(280, el.clientWidth || 480);
    var height = 300;
    var iw = width - margin.left - margin.right, ih = height - margin.top - margin.bottom;

    var svg = d3.select(el).append("svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("preserveAspectRatio", "xMidYMid meet");
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scaleTime().domain(d3.extent(pts, function (d) { return d.date; })).range([0, iw]);

    var yVals = pts.map(function (d) { return d.f; });
    if (hasBand) bandClean.forEach(function (b) { if (b.min != null) yVals.push(b.min); if (b.max != null) yVals.push(b.max); });
    if (threshold != null) yVals.push(threshold);
    var ymin = Math.min.apply(null, yVals) - 3, ymax = Math.max.apply(null, yVals) + 3;
    var y = d3.scaleLinear().domain([ymin, ymax]).nice().range([ih, 0]);

    // Day gridlines + x axis (labels in facility tz). Denser ticks for short ranges.
    var spanDays = (x.domain()[1] - x.domain()[0]) / 86400000;
    var dayTicks = x.ticks(d3.timeDay.every(spanDays <= 8 ? 1 : 2));
    g.append("g").attr("class", "cht-grid").selectAll("line").data(dayTicks).enter().append("line")
      .attr("class", "cht-gridline").attr("x1", function (d) { return x(d); }).attr("x2", function (d) { return x(d); })
      .attr("y1", 0).attr("y2", ih);
    g.append("g").attr("class", "cht-axis").attr("transform", "translate(0," + ih + ")")
      .call(d3.axisBottom(x).tickValues(dayTicks).tickFormat(function (d) { return fmtDate(d, tz); }).tickSizeOuter(0));
    g.append("g").attr("class", "cht-axis")
      .call(d3.axisLeft(y).ticks(5).tickFormat(function (d) { return d + "°"; }).tickSizeOuter(0));

    // Historic band (area) + median.
    if (hasBand) {
      var area = d3.area().defined(function (d) { return d && d.min != null && d.max != null; })
        .x(function (d) { return x(d.date); }).y0(function (d) { return y(d.min); }).y1(function (d) { return y(d.max); });
      g.append("path").datum(bandPts).attr("class", "cht-band").attr("d", area);
      var medLine = d3.line().defined(function (d) { return d && d.median != null; })
        .x(function (d) { return x(d.date); }).y(function (d) { return y(d.median); });
      g.append("path").datum(bandPts).attr("class", "cht-band-median").attr("d", medLine);
    }

    // Threshold line.
    if (threshold != null) {
      g.append("line").attr("class", "cht-threshold").attr("x1", 0).attr("x2", iw).attr("y1", y(threshold)).attr("y2", y(threshold));
      g.append("text").attr("class", "cht-thresh-label").attr("x", iw).attr("y", y(threshold) - 4).attr("text-anchor", "end")
        .text("10°F above average (" + Math.round(threshold) + "°)");
    }

    // Recent trace.
    var line = d3.line().x(function (d) { return x(d.date); }).y(function (d) { return y(d.f); });
    g.append("path").datum(pts).attr("class", "cht-trace").attr("d", line);

    // Hover: cursor + dot + tooltip.
    var cursor = g.append("line").attr("class", "cht-chart__cursor").attr("y1", 0).attr("y2", ih).style("display", "none");
    var dot = g.append("circle").attr("class", "cht-chart__dot").attr("r", 3.5).style("display", "none");
    var tip = document.createElement("div"); tip.className = "cht-chart__tip"; document.body.appendChild(tip);
    var bis = d3.bisector(function (d) { return d.date; }).left;
    svg.append("rect").attr("transform", "translate(" + margin.left + "," + margin.top + ")")
      .attr("width", iw).attr("height", ih).style("fill", "none").style("pointer-events", "all")
      .on("mousemove", function (event) {
        var mx = d3.pointer(event, g.node())[0], t0 = x.invert(mx);
        var i = bis(pts, t0, 1), a = pts[i - 1], b = pts[i], d = (b && (t0 - a.date > b.date - t0)) ? b : a;
        if (!d) return;
        cursor.attr("x1", x(d.date)).attr("x2", x(d.date)).style("display", null);
        dot.attr("cx", x(d.date)).attr("cy", y(d.f)).style("display", null);
        var bp = hasBand ? bandPts[pts.indexOf(d)] : null;
        tip.innerHTML = "<strong>" + Math.round(d.f) + "°F</strong> · " + fmtDateTime(d.date, tz) +
          (bp && bp.min != null ? "<br>historic " + Math.round(bp.min) + "–" + Math.round(bp.max) + "°" : "");
        tip.style.left = (event.clientX + 12) + "px"; tip.style.top = (event.clientY - 10) + "px";
        tip.classList.add("cht-chart__tip--in");
      })
      .on("mouseleave", function () { cursor.style("display", "none"); dot.style("display", "none"); tip.classList.remove("cht-chart__tip--in"); });

    drawLegend(opts.legendEl, hasBand, threshold != null);
  }

  function drawLegend(el, hasBand, hasThresh) {
    if (!el) return;
    var items = ['<span class="cht-chart-legend__item"><span class="cht-chart-legend__swatch" style="background:var(--cht-over)"></span>Hourly °F</span>'];
    if (hasBand) items.push('<span class="cht-chart-legend__item"><span class="cht-chart-legend__band"></span>2016–2025 range (median dashed)</span>');
    if (hasThresh) items.push('<span class="cht-chart-legend__item"><span class="cht-chart-legend__swatch" style="background:var(--primary)"></span>10°F above average</span>');
    el.innerHTML = items.join("");
  }

  window.CHTChart = { draw: draw, bandIndex: bandIndex };
})();
