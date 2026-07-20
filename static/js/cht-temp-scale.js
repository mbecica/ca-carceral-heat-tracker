/* ============================================================================
   Temperature color scale for the statewide map dots.

   Mary's call: the map classifies facilities by ABSOLUTE current temperature on
   a standard weather-map gradient (not by threshold status — that's the ring).
   This is a single swappable lookup: the anchor stops below are the whole scale,
   so the exact NWS-style palette is easy to tune on the prototype.

   Stops are a piecewise-linear ramp in °F, interpolated in RGB, spanning the
   full meteorological range so it reads like a NWS temperature map:
   cool purples/blues -> greens -> yellows -> oranges -> reds -> hot magenta.
   Exposed on window.CHTTempScale.
   ============================================================================ */
(function () {
  "use strict";

  // [°F, [r,g,b]] anchors, ascending. Tune here to restyle the whole map.
  var STOPS = [
    [20,  [110, 74, 168]],   // purple
    [30,  [96, 90, 200]],    // indigo
    [40,  [74, 127, 208]],   // blue
    [50,  [63, 176, 201]],   // cyan
    [60,  [75, 179, 122]],   // green
    [70,  [167, 207, 82]],   // yellow-green
    [80,  [242, 209, 61]],   // yellow
    [90,  [242, 165, 61]],   // orange
    [100, [232, 100, 46]],   // deep orange
    [110, [207, 42, 42]],    // red
    [120, [143, 29, 90]]     // hot magenta-red
  ];

  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  /* Color for a temperature in °F. null/undefined -> null (caller uses --cht-null). */
  function tempColor(f) {
    if (f == null || isNaN(f)) return null;
    if (f <= STOPS[0][0]) return rgb(STOPS[0][1]);
    if (f >= STOPS[STOPS.length - 1][0]) return rgb(STOPS[STOPS.length - 1][1]);
    for (var i = 0; i < STOPS.length - 1; i++) {
      var lo = STOPS[i], hi = STOPS[i + 1];
      if (f >= lo[0] && f <= hi[0]) {
        var t = (f - lo[0]) / (hi[0] - lo[0]);
        return rgb([lerp(lo[1][0], hi[1][0], t), lerp(lo[1][1], hi[1][1], t), lerp(lo[1][2], hi[1][2], t)]);
      }
    }
    return rgb(STOPS[STOPS.length - 1][1]);
  }

  /* Sampled cells for a compact legend gradient across [min,max] °F. */
  function legendCells(min, max, step) {
    min = min == null ? 55 : min; max = max == null ? 110 : max; step = step || 5;
    var cells = [];
    for (var f = min; f <= max; f += step) cells.push({ f: f, color: tempColor(f) });
    return cells;
  }

  window.CHTTempScale = { tempColor: tempColor, legendCells: legendCells, stops: STOPS };
})();
