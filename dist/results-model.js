/* Pure result contracts. Used by the build and browser; no DOM, fetch or clock. */
(function (host) {
  'use strict';
  const site = (host.SSTS = host.SSTS || {});
  const projectKeys = [
    ['women', 500],
    ['women', 1000],
    ['women', 1500],
    ['women', 3000],
    ['men', 500],
    ['men', 1000],
    ['men', 1500],
    ['men', 5000],
    ['mixed', 2000]
  ];
  const included = (r) =>
    r.format === 'individual'
      ? [500, 1000, 1500].includes(r.distance_m)
      : r.format === 'relay' && [2000, 3000, 5000].includes(r.distance_m);
  const matchesProject = (r, key) =>
    r.gender === key[0] &&
    r.distance_m === key[1] &&
    r.format === (key[1] >= 2000 ? 'relay' : 'individual');
  const projectId = (key) => key.join('-');
  const medalResult = (r) =>
    r.medal_eligible !== false &&
    r.medal_verified !== false &&
    r.status === 'classified' &&
    r.rank >= 1 &&
    r.rank <= 3 &&
    (r.rank_scope !== 'final' || r.final_group === 'A');
  const kindMatches = (value, kind) =>
    kind === 'all' ||
    value === kind ||
    (kind === 'circuit' && ['worldcup', 'worldtour'].includes(value));
  const normalizeKind = (kind) => (['worldcup', 'worldtour'].includes(kind) ? 'circuit' : kind);
  // Search projections and detail rows use this single predicate; no event-wide name bag.
  const normalizeSearch = (value) =>
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  function resultSearchRow(row, people) {
    const person = (id) => (people?.get ? people.get(id) : people?.[id]);
    const subjects =
      row.format === 'relay'
        ? [{ name: row.name, aliases: ['中国队'] }, ...(row.members || [])]
        : [row];
    const names = subjects
      .map((subject) => {
        const registered = person(subject.athlete_id);
        return [
          ...new Set(
            [
              subject.name,
              registered?.name,
              ...(registered?.aliases || []),
              ...(subject.aliases || [])
            ]
              .map(normalizeSearch)
              .filter(Boolean)
          )
        ].join(' ');
      })
      .filter(Boolean);
    return { gender: row.gender, distance_m: row.distance_m, names: [...new Set(names)] };
  }
  function resultSearchRows(rows, people) {
    return [
      ...new Map(
        rows.map((row) => {
          const projection = resultSearchRow(row, people);
          return [JSON.stringify(projection), projection];
        })
      ).values()
    ];
  }
  function resultFilter({ athlete = '', gender = 'all', distance = 'all' } = {}) {
    return {
      tokens: normalizeSearch(athlete).split(' ').filter(Boolean),
      gender,
      distance: String(distance)
    };
  }
  const hasResultFilter = (filter) =>
    filter.tokens.length > 0 || filter.gender !== 'all' || filter.distance !== 'all';
  const matchesResultSearch = (row, filter) =>
    (filter.gender === 'all' || row.gender === filter.gender) &&
    (filter.distance === 'all' || String(row.distance_m) === filter.distance) &&
    (!filter.tokens.length ||
      row.names.some((name) => filter.tokens.every((token) => name.includes(token))));
  const eventMatchesResults = (event, filter) =>
    !hasResultFilter(filter) || event.search_rows.some((row) => matchesResultSearch(row, filter));
  const empty = () => ({
    events: 0,
    entries: 0,
    starts: 0,
    medals: [0, 0, 0],
    a_finals: 0,
    top8: 0
  });
  function rowStatistics(rows) {
    rows = rows.filter((r) => included(r) && r.medal_eligible !== false);
    const starts = rows.filter((r) => r.status !== 'DNS' && r.started !== false);
    return {
      events: 0,
      entries: rows.length,
      starts: starts.length,
      medals: [1, 2, 3].map((rank) => rows.filter((r) => medalResult(r) && r.rank === rank).length),
      a_finals: starts.filter((r) => r.final_group === 'A').length,
      top8: rows.filter(
        (r) =>
          r.status === 'classified' &&
          r.rank >= 1 &&
          r.rank <= 8 &&
          (r.rank_scope !== 'final' || r.final_group === 'A')
      ).length
    };
  }
  function sumStats(values) {
    const total = empty();
    for (const s of values) {
      for (const key of ['events', 'entries', 'starts', 'a_finals', 'top8'])
        total[key] += s[key] || 0;
      s.medals.forEach((n, i) => (total.medals[i] += n));
    }
    return total;
  }
  function statistics(events) {
    const stats = sumStats(events.map((e) => e.summary?.totals || rowStatistics(e.results || [])));
    stats.events = events.length;
    return stats;
  }
  function bestResult(rows) {
    // Rank scopes are incomparable: prefer published overall classifications whenever available.
    const official = rows.filter(
      (r) => r.rank != null && r.rank_scope !== 'final' && !r.classification_missing
    );
    const group = rows.filter(
      (r) => r.rank != null && r.rank_scope === 'final' && ['A', 'B'].includes(r.final_group)
    );
    const byRank = (a, b) =>
      Number(a.status !== 'classified') - Number(b.status !== 'classified') || a.rank - b.rank;
    // If no overall result exists, show the supported A/B final place explicitly as a group place.
    return (
      official.sort(byRank)[0] ||
      group.sort(
        (a, b) =>
          Number(a.status !== 'classified') - Number(b.status !== 'classified') ||
          Number(a.final_group === 'B') - Number(b.final_group === 'B') ||
          a.rank - b.rank
      )[0] ||
      null
    );
  }
  function athleteStatistics(events) {
    const people = new Map();
    const person = (id, name) => {
      if (!people.has(id))
        people.set(id, { id, name, starts: 0, relay: 0, medals: [0, 0, 0], finals: 0, best: null });
      return people.get(id);
    };
    for (const event of events) {
      if (event.summary) {
        for (const p of event.summary.athletes) {
          const total = person(p.id, p.name);
          for (const key of ['starts', 'relay', 'finals']) total[key] += p[key];
          p.medals.forEach((n, i) => (total.medals[i] += n));
          if (p.best != null && (total.best == null || p.best < total.best)) total.best = p.best;
        }
        continue;
      }
      for (const r of event.results || []) {
        if (!included(r) || r.medal_eligible === false) continue;
        if (r.format === 'relay') {
          for (const m of r.members || [])
            if (m.rounds?.length) person(m.athlete_id, m.name).relay++;
        } else {
          const p = person(r.athlete_id, r.name);
          if (r.status !== 'DNS' && r.started !== false) p.starts++;
          if (medalResult(r)) p.medals[r.rank - 1]++;
          if (r.final_group === 'A' && r.status !== 'DNS' && r.started !== false) p.finals++;
          if (
            r.rank_scope !== 'final' &&
            r.rank &&
            r.status === 'classified' &&
            (p.best == null || r.rank < p.best)
          )
            p.best = r.rank;
        }
      }
    }
    return [...people.values()].sort(
      (a, b) =>
        b.medals[0] - a.medals[0] ||
        b.medals[1] - a.medals[1] ||
        b.medals[2] - a.medals[2] ||
        b.finals - a.finals ||
        a.name.localeCompare(b.name)
    );
  }
  function summarize(event) {
    const rows = (event.results || []).filter(included);
    const projects = Object.fromEntries(
      projectKeys.map((key) => {
        const selected = rows.filter((r) => matchesProject(r, key));
        const offered =
          event.programme == null ? null : event.programme.some((r) => matchesProject(r, key));
        const state = selected.length
          ? 'recorded'
          : offered === false
            ? 'not_offered'
            : event.coverage === 'complete' && (offered || event.participation === 'none')
              ? 'zero'
              : 'uncollected';
        // Best-result projections retain identity, status and medal eligibility, never provenance blobs or lineups.
        const best = bestResult(selected);
        const compact =
          best &&
          Object.fromEntries(
            [
              'rank',
              'rank_scope',
              'final_group',
              'status',
              'format',
              'name',
              'athlete_id',
              'medal_eligible',
              'medal_verified'
            ]
              .filter((k) => k in best)
              .map((k) => [k, best[k]])
          );
        return [
          projectId(key),
          {
            state,
            totals: rowStatistics(selected),
            best: compact,
            group_only: selected.some((r) => r.rank != null),
            missing_classifications: selected.some((r) => r.classification_missing)
          }
        ];
      })
    );
    return {
      totals: statistics([{ results: rows }]),
      projects,
      athletes: athleteStatistics([{ results: rows }])
    };
  }
  function scopeEvents(index, mode, id, kind = 'all') {
    const seasons = mode === 'cycle' ? index.cycles.find((c) => c.id === id)?.seasons || [] : [id];
    return index.events.filter((e) => seasons.includes(e.season) && kindMatches(e.kind, kind));
  }
  function scopeCoverage(index, mode, id, kind, events) {
    const seasons = mode === 'cycle' ? index.cycles.find((c) => c.id === id)?.seasons || [] : [id];
    const inventories = (index.inventory || []).filter(
      (s) => seasons.includes(s.season) && kindMatches(s.kind, kind)
    );
    const expectedIds = new Set(inventories.flatMap((s) => s.official_event_ids).map(String));
    const availableIds = new Set(
      events.map((e) => String(e.official_event_id)).filter((id) => id !== 'undefined')
    );
    const missing = [...expectedIds].filter((id) => !availableIds.has(id));
    const pending = (index.pending || []).filter(
      (e) => seasons.includes(e.season) && kindMatches(e.kind, kind)
    );
    // Unknown and future seasons remain unknown; an empty inventory entry explicitly means no events.
    const known = seasons.every((s) => inventories.some((scope) => scope.season === s));
    const partial =
      !known ||
      missing.length > 0 ||
      pending.length > 0 ||
      events.some((e) => e.coverage !== 'complete');
    const expected = expectedIds.size;
    return {
      expected,
      available: events.length,
      partial,
      known,
      missing,
      state: !events.length
        ? known && expected === 0 && !pending.length
          ? 'not_offered'
          : 'uncollected'
        : partial
          ? 'partial'
          : 'complete'
    };
  }
  function projectSummary(events, key, scope) {
    const projects = events.map(
      (e) => e.summary?.projects[projectId(key)] || summarize(e).projects[projectId(key)]
    );
    const totals = sumStats(projects.map((p) => p.totals));
    const best = bestResult(projects.map((p) => p.best).filter(Boolean));
    const state = totals.entries
      ? 'recorded'
      : scope?.partial || !events.length
        ? scope?.state === 'not_offered'
          ? 'not_offered'
          : 'uncollected'
        : projects.every((p) => p.state === 'not_offered')
          ? 'not_offered'
          : projects.every((p) => ['zero', 'not_offered'].includes(p.state))
            ? 'zero'
            : 'uncollected';
    return {
      state,
      totals,
      best,
      partial: !!scope?.partial,
      group_only: projects.some((p) => p.group_only),
      missing_classifications: projects.some((p) => p.missing_classifications)
    };
  }
  site.resultsModel = {
    normalizeSearch,
    resultSearchRow,
    resultSearchRows,
    resultFilter,
    hasResultFilter,
    matchesResultSearch,
    eventMatchesResults,
    projectKeys,
    projectId,
    included,
    matchesProject,
    medalResult,
    kindMatches,
    normalizeKind,
    statistics,
    summarize,
    athleteStatistics,
    scopeEvents,
    scopeCoverage,
    projectSummary
  };
})(typeof window === 'undefined' ? globalThis : window);
