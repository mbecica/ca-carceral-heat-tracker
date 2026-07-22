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
     @param recentMaxF  number °F trailing-24h peak (statewide/recent last24h_max_f).
                      When provided, THIS drives over-average status instead of the
                      latest daily bucket — the latest bucket is always partial (it
                      ends whenever the last observation lands), so it under-reports;
                      a fixed 24h window is time-of-day independent. Falls back to the
                      latest daily bucket when omitted (older data / callers).
     @returns { hasData, asOf, todayMax, recentMax, avgF, hiF, overAvg, overHi, level,
                deltaAvg, deltaHi, streak }
       - recentMax the value status is computed against (24h peak, or latest day)
       - overAvg   recentMax >= avgF  (i.e. hit the average in the last 24h)
       - overHi    recentMax >= hiF
       - level     0 under avg · 1 over avg · 2 over hi
       - deltaAvg  signed °F of recentMax over the average (negative = under)
       - deltaHi   signed °F of recentMax over the hi line
       - todayMax  the latest daily bucket's max (kept for CSV/reference display)
       - streak    trailing consecutive days at/over the AVERAGE (kept for future
                   use; NOT surfaced in the UI at present)
  */
  function computeStatus(dailyMax, avgF, hiF, recentMaxF) {
    var days = (dailyMax || []).filter(function (d) { return d && d.max_f != null; });
    if (!days.length && recentMaxF == null) return { hasData: false };
    var todayMax = days.length ? days[days.length - 1].max_f : null;
    var asOf = days.length ? days[days.length - 1].date : null;
    // Status basis: the trailing-24h peak when available, else the latest daily bucket.
    var t = recentMaxF != null ? recentMaxF : todayMax;
    var overAvg = avgF != null && t != null && t >= avgF;
    var overHi = hiF != null && t != null && t >= hiF;
    var streak = 0;
    if (avgF != null) for (var i = days.length - 1; i >= 0 && days[i].max_f >= avgF; i--) streak++;
    return {
      hasData: true,
      asOf: asOf,
      todayMax: todayMax,
      recentMax: t,
      avgF: avgF,
      hiF: hiF,
      overAvg: overAvg,
      overHi: overHi,
      level: overHi ? 2 : (overAvg ? 1 : 0),
      deltaAvg: (avgF != null && t != null) ? t - avgF : null,
      deltaHi: (hiF != null && t != null) ? t - hiF : null,
      streak: streak
    };
  }

  window.CHTStatus = { computeStatus: computeStatus };
})();
