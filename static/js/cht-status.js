/* ============================================================================
   Heat-status compute layer — the ONE place thresholds turn into status.

   Design constraint (flagged by Mary in Phase 2, do not re-couple): the committed
   data is RAW OBSERVATIONS ONLY. Nothing here reads a file or knows where the
   thresholds came from — the caller passes them in. That keeps them swappable:
   change them, pluralize them, or make them user-selectable and only the
   ARGUMENTS change, never this module and never the data pipeline.

   Two thresholds now define a two-tier status (Mary, Phase 3 revision):
     avgF — the facility's summer average daily high (baseline_summer_avg_high_f)
     hiF  — the "well above" line, avgF + 10°F (threshold_f)
   yielding level 0 (under average), 1 (over average), 2 (10°F+ above average).

   Everything is exposed on window.CHTStatus. Pure functions, no DOM, no fetch.
   ============================================================================ */
(function () {
  "use strict";

  /* Compute status for one facility from its daily maxes + two thresholds.
     @param dailyMax  [{date, max_f}] ascending by date (statewide row's
                      recent_daily_max_f, or a recent/{slug}.json daily_max).
     @param avgF      number °F summer average daily high, or null if unknown.
     @param hiF       number °F "10°F above average" line, or null if unknown.
     @returns { hasData, asOf, todayMax, avgF, hiF, overAvg, overHi, level,
                deltaAvg, deltaHi, streak }
       - overAvg   today's (most recent complete day's) max >= avgF
       - overHi    today's max >= hiF
       - level     0 under avg · 1 over avg · 2 over hi
       - deltaAvg  signed °F of today's max over the average (negative = under)
       - deltaHi   signed °F of today's max over the hi line
       - streak    trailing consecutive days at/over the AVERAGE (kept for future
                   use; NOT surfaced in the UI at present)
  */
  function computeStatus(dailyMax, avgF, hiF) {
    var days = (dailyMax || []).filter(function (d) { return d && d.max_f != null; });
    if (!days.length) return { hasData: false };
    var today = days[days.length - 1];
    var t = today.max_f;
    var overAvg = avgF != null && t >= avgF;
    var overHi = hiF != null && t >= hiF;
    var streak = 0;
    if (avgF != null) for (var i = days.length - 1; i >= 0 && days[i].max_f >= avgF; i--) streak++;
    return {
      hasData: true,
      asOf: today.date,
      todayMax: t,
      avgF: avgF,
      hiF: hiF,
      overAvg: overAvg,
      overHi: overHi,
      level: overHi ? 2 : (overAvg ? 1 : 0),
      deltaAvg: avgF != null ? t - avgF : null,
      deltaHi: hiF != null ? t - hiF : null,
      streak: streak
    };
  }

  window.CHTStatus = { computeStatus: computeStatus };
})();
