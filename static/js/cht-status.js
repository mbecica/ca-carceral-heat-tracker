/* ============================================================================
   Heat-status compute layer — the ONE place a threshold turns into status.

   Design constraint (flagged by Mary in Phase 2, do not re-couple): the committed
   data is RAW OBSERVATIONS ONLY. Nothing here reads a file or knows where the
   threshold came from — the caller passes `threshold_f` in. That keeps the
   threshold swappable: change it, pluralize it, or make it user-selectable and
   only the ARGUMENT changes, never this module and never the data pipeline.

   Everything is exposed on window.CHTStatus. Pure functions, no DOM, no fetch.
   ============================================================================ */
(function () {
  "use strict";

  /* Compute status for one facility from its daily maxes + a threshold.
     @param dailyMax   [{date, max_f}] ascending by date (statewide row's
                       recent_daily_max_f, or a recent/{slug}.json daily_max).
     @param thresholdF number °F, or null/undefined if unknown.
     @returns { hasData, asOf, todayMax, thresholdF, over, deltaF, streak }
       - over    today's (most recent complete day's) max >= threshold
       - deltaF  signed °F of today's max over the threshold (negative = under)
       - streak  trailing consecutive days at/over threshold (kept for future use;
                 NOT surfaced in the UI at present)
  */
  function computeStatus(dailyMax, thresholdF) {
    var days = (dailyMax || []).filter(function (d) { return d && d.max_f != null; });
    if (!days.length || thresholdF == null) return { hasData: false };
    var today = days[days.length - 1];
    var streak = 0;
    for (var i = days.length - 1; i >= 0 && days[i].max_f >= thresholdF; i--) streak++;
    return {
      hasData: true,
      asOf: today.date,
      todayMax: today.max_f,
      thresholdF: thresholdF,
      over: today.max_f >= thresholdF,
      deltaF: today.max_f - thresholdF,
      streak: streak
    };
  }

  /* Count facilities currently over threshold, for the headline stat.
     @param rows  statewide.json facilities (each with recent_daily_max_f)
     @param threshOf  fn(row) -> thresholdF  (join to facilities.json)
  */
  function countOver(rows, threshOf) {
    var n = 0;
    (rows || []).forEach(function (r) {
      var s = computeStatus(r.recent_daily_max_f, threshOf(r));
      if (s.hasData && s.over) n++;
    });
    return n;
  }

  window.CHTStatus = { computeStatus: computeStatus, countOver: countOver };
})();
