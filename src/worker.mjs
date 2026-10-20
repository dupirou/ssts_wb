/** Read-only API over the last validated official snapshot. No upstream scraping per visit. */
const resources = new Set(['entries', 'rounds', 'results', 'rankings', 'penalties', 'predictions']);
const filters = new Set(['country', 'gender', 'distance_m', 'round_key', 'athlete_id', 'ranking_type']);
const json = (data, status = 200, head = false, extra = {}) => new Response(head ? null : JSON.stringify(data), {
  status, headers: {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=60, s-maxage=60' : 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra},
});

function matches(item, query, participant = item) {
  for (const [key, value] of query) {
    if (key === 'country' || key === 'athlete_id') {
      if (participant[key] !== value) return false;
    } else if (String(item[key] ?? '') !== value) return false;
  }
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const head = request.method === 'HEAD';
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({error: 'method_not_allowed'}, 405, head, {Allow: 'GET, HEAD'});
    }
    const route = url.pathname.match(/^\/api\/v1\/events(?:\/([a-z]+)(?:\/(entries|rounds|results|rankings|penalties|predictions))?)?\/?$/);
    if (!route) return json({error: 'not_found'}, 404, head);
    for (const [key, value] of url.searchParams) {
      if (!filters.has(key) || !value || url.searchParams.getAll(key).length !== 1 || value.length > 160) {
        return json({error: 'invalid_filter', field: key}, 400, head);
      }
      if ((key === 'country' && !/^[A-Z]{3}$/.test(value)) ||
          (key === 'gender' && !['men','women','mixed'].includes(value)) ||
          (key === 'ranking_type' && !['event','world','world_tour'].includes(value)) ||
          (key === 'distance_m' && !['500','1000','1500','2000','3000','5000'].includes(value))) {
        return json({error: 'invalid_filter', field: key}, 400, head);
      }
    }
    try {
      const indexResponse = await env.ASSETS.fetch(new URL('/data/competitions/index.json', url));
      if (!indexResponse.ok) return json({error: 'data_unavailable'}, 503, head);
      const index = await indexResponse.json();
      const [, eventId, resource] = route;
      if (!eventId) {
        if (url.search) return json({error: 'filters_require_resource'}, 400, head);
        return json(index, 200, head);
      }
      if (!index.events.some(e => e.id === eventId)) return json({error: 'event_not_found'}, 404, head);
      if (!resource) {
        if (url.search) return json({error: 'filters_require_resource'}, 400, head);
        return json({schema_version: 1, event_id: eventId,
          endpoints: [...resources].map(r => `/api/v1/events/${eventId}/${r}`)}, 200, head);
      }
      if (resource === 'predictions') {
        if ([...url.searchParams].some(([k]) => !['gender', 'distance_m', 'round_key'].includes(k))) {
          return json({error: 'unsupported_prediction_filter'}, 400, head);
        }
        const stored = await env.ASSETS.fetch(new URL(`/data/predictions/${eventId}.json`, url));
        if (!stored.ok) return json({error: 'data_unavailable'}, 503, head);
        const prediction = await stored.json();
        if (prediction.schema_version !== 1 || prediction.event_id !== eventId || prediction.evidence !== 'model_prediction_not_official') {
          throw new Error('Invalid prediction snapshot');
        }
        const items = prediction.items.filter(item => matches(item, url.searchParams));
        return json({...prediction, total: items.length, items}, 200, head);
      }
      const stored = await env.ASSETS.fetch(new URL(`/data/competitions/${eventId}.json`, url));
      if (!stored.ok) return json({error: 'data_unavailable'}, 503, head);
      const snapshot = await stored.json();
      const dataset = snapshot[['results','penalties'].includes(resource) ? 'rounds' : resource];
      let items = dataset.items;
      if (resource === 'rounds') {
        items = items.filter(item => item.participants.some(p => matches(item, url.searchParams, p)));
      } else if (resource === 'results' || resource === 'penalties') {
        items = items.filter(item => item.evidence === 'official_results').flatMap(item =>
          item.participants.filter(p => matches(item, url.searchParams, p) &&
            (resource !== 'penalties' || p.penalty != null)).map(p => ({...item, participants: undefined, ...p,
              heat_id: item.id, id: `${item.id}/${p.athlete_id}`})));
      } else {
        items = items.filter(item => matches(item, url.searchParams));
      }
      const {items: unused, ...meta} = dataset;
      const age = dataset.checked_at ? Date.now() - Date.parse(dataset.checked_at) : null;
      if (resource === 'results' || resource === 'penalties') {
        meta.status = dataset.items.some(i => i.evidence === 'official_results') ? 'available' : 'not_published';
      }
      return json({schema_version: 1, event_id: eventId, resource, ...meta,
        stale: dataset.update_status === 'error' || (age !== null && age > 36 * 3600_000),
        total: items.length, items}, 200, head);
    } catch (error) {
      console.error('Competition snapshot unavailable', error?.message);
      return json({error: 'data_unavailable'}, 503, head);
    }
  },
};
