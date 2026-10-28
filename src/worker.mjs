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

/* Race-window sync: GitHub's own cron is often hours late, so a Cloudflare Cron Trigger (every 10 min)
   asks GitHub Actions to run the existing sync workflow. To keep load on ISU's site modest it syncs
   every 10 min only around each racing session, hourly during the rest of a race window, never outside. */
const SYNC_REPO = 'dupirou/ssts_wb';
const SYNC_WORKFLOW = 'sync.yml';
const HOUR_MS = 3600_000, DAY_MS = 24 * HOUR_MS, TICK_MS = 10 * 60_000;

export function inRaceWindow(stations, now) {
  // From two days before the first race date through three days after the last.
  return stations.filter(s => now >= Date.parse(s.date_start + 'T00:00:00Z') - 2 * DAY_MS &&
    now < Date.parse(s.date_end + 'T00:00:00Z') + 3 * DAY_MS);
}

// From 2h before a competition day's first round start until 2h after its last one.
export function inRacingSession(entries, now) {
  const days = new Map();
  for (const e of entries) {
    const t = Date.parse(e.utc_start);
    if (!Number.isFinite(t)) {
      console.error(JSON.stringify({event: 'sync_invalid_schedule_time', local_date: e.local_date, utc_start: e.utc_start}));
      continue;
    }
    const d = days.get(e.local_date);
    days.set(e.local_date, d ? [Math.min(d[0], t), Math.max(d[1], t)] : [t, t]);
  }
  return [...days.values()].some(([first, last]) => now >= first - 2 * HOUR_MS && now <= last + 2 * HOUR_MS);
}

export async function syncDecision(env, now) {
  const asset = path => env.ASSETS.fetch(new Request('https://assets.local' + path));
  let active;
  try {
    const calendar = await asset('/data/calendar.json');
    if (!calendar.ok) throw new Error('calendar.json unavailable: ' + calendar.status);
    const body = await calendar.json();
    if (!Array.isArray(body.stations)) throw new Error('calendar.json missing stations');
    active = inRaceWindow(body.stations, now);
  } catch (error) {
    console.error(JSON.stringify({event: 'sync_calendar_unavailable', error: String(error?.message || error)}));
    // Without a calendar, stay on a bounded hourly fallback rather than disabling sync entirely.
    return Math.floor(now / TICK_MS) % 6 === 0 ? 'hourly' : 'skip';
  }
  if (!active.length) return 'outside_window';
  for (const station of active) {
    const detail = await asset('/data/' + station.id + '.json');
    if (detail.ok && inRacingSession((await detail.json()).entries || [], now)) return 'session';
  }
  // Ticks land on :00, :10, …; only the top-of-hour tick runs between sessions.
  return Math.floor(now / TICK_MS) % 6 === 0 ? 'hourly' : 'skip';
}

const HEARTBEAT_KEY = 'sync:last_success';
const SESSION_STALE_MS = 30 * 60_000;
const DEFAULT_STALE_MS = 36 * HOUR_MS;

async function validHeartbeatToken(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const encoder = new TextEncoder();
  const digest = async input => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
  const [actual, expected] = await Promise.all([
    digest(request.headers.get('Authorization') || ''), digest('Bearer ' + secret),
  ]);
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= actual[i] ^ expected[i];
  return different === 0;
}

async function acceptHeartbeat(request, env) {
  if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405, false, {Allow: 'POST'});
  if (!env.HEARTBEAT_SECRET || !env.SYNC_HEALTH_KV) return json({error: 'heartbeat_unavailable'}, 503);
  if (!(await validHeartbeatToken(request, env.HEARTBEAT_SECRET))) return json({error: 'unauthorized'}, 401);
  const timestamp = new Date().toISOString();
  try {
    await env.SYNC_HEALTH_KV.put(HEARTBEAT_KEY, JSON.stringify({checked_at: timestamp}));
    return json({status: 'ok', checked_at: timestamp});
  } catch (error) {
    console.error(JSON.stringify({event: 'heartbeat_write_error', message: String(error?.message || error)}));
    return json({error: 'heartbeat_unavailable'}, 503);
  }
}

async function freshness(env, dataset) {
  const original = dataset.checked_at || null;
  let checked_at = original;
  let source = 'snapshot';
  let degraded = false;
  try {
    if (!env.SYNC_HEALTH_KV) throw new Error('KV binding not configured');
    const pulse = await env.SYNC_HEALTH_KV.get(HEARTBEAT_KEY, 'json');
    if (!pulse || typeof pulse.checked_at !== 'string' || !Number.isFinite(Date.parse(pulse.checked_at))) {
      throw new Error('No valid heartbeat');
    }
    checked_at = pulse.checked_at;
    source = 'heartbeat';
  } catch (error) {
    degraded = true;
    console.error(JSON.stringify({event: 'heartbeat_read_fallback', message: String(error?.message || error)}));
  }
  let threshold = DEFAULT_STALE_MS;
  if (source === 'heartbeat') {
    try {
      if (await syncDecision(env, Date.now()) === 'session') threshold = SESSION_STALE_MS;
    } catch (error) {
      degraded = true;
      console.error(JSON.stringify({event: 'heartbeat_session_fallback', message: String(error?.message || error)}));
    }
  }
  const age = checked_at ? Date.now() - Date.parse(checked_at) : null;
  return {
    checked_at, data_checked_at: original, freshness_source: source, freshness_degraded: degraded,
    stale: dataset.update_status === 'error' || (age !== null && age > threshold),
  };
}

async function dispatchSync(env, now) {
  const decision = await syncDecision(env, now);
  if (decision === 'outside_window' || decision === 'skip') return decision;
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.error(JSON.stringify({event: 'sync_dispatch_error', code: 'no_token'}));
    return 'no_token';
  }
  const response = await fetch(`https://api.github.com/repos/${SYNC_REPO}/actions/workflows/${SYNC_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + env.GITHUB_DISPATCH_TOKEN, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stsswb-cron', 'Content-Type': 'application/json'},
    body: JSON.stringify({ref: 'main', inputs: {sync_decision: decision}}),
  });
  if (response.status !== 204) {
    const code = [401, 403].includes(response.status) ? 'github_permission_denied' : 'github_dispatch_failed';
    console.error(JSON.stringify({event: 'sync_dispatch_error', code, status: response.status}));
    throw new Error('GitHub dispatch failed: ' + response.status);
  }
  return 'dispatched:' + decision;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchSync(env, controller.scheduledTime)
      .then(result => console.log(JSON.stringify({event: 'sync_dispatch', result})))
      .catch(error => {
        console.error(JSON.stringify({event: 'sync_dispatch_exception', message: String(error?.message || error), stack: error?.stack}));
        throw error;
      }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/heartbeat') return acceptHeartbeat(request, env);
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
        const items = prediction.items.filter(item => matches(item, url.searchParams));
        return json({...prediction, ...await freshness(env, prediction), total: items.length, items}, 200, head);
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
      if (resource === 'results' || resource === 'penalties') {
        meta.status = dataset.items.some(i => i.evidence === 'official_results') ? 'available' : 'not_published';
      }
      return json({schema_version: 1, event_id: eventId, resource, ...meta,
        ...await freshness(env, dataset), total: items.length, items}, 200, head);
    } catch (error) {
      console.error('Competition snapshot unavailable', error?.message);
      return json({error: 'data_unavailable'}, 503, head);
    }
  },
};
