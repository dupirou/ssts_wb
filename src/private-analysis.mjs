import historical from './historical-heats.mjs';

const key = (name, country) => country + ':' + name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/['’]/g,'').split(/[^A-Z]+/).filter(Boolean).sort().join('-');
const athlete = p => key(p.name_latin || p.name, p.country);
// Regularized Plackett–Luce scores over ordered finishers. An unseen skater starts at zero.
function ratings(races) {
  const scores = new Map(races.flat().map(id => [id, 0]));
  const counts = new Map();
  for (const race of races) for (const id of race) counts.set(id, 1 + (counts.get(id) || 0));
  for (let step = 0; step < 80; step++) {
    const gradient = new Map([...scores].map(([id, value]) => [id, -value]));
    for (const race of races) {
      let total = 0;
      const weights = race.map(id => Math.exp(scores.get(id)));
      for (let i = race.length - 1; i >= 0; i--) {
        total += weights[i];
        if (i === race.length - 1) continue;
        gradient.set(race[i], gradient.get(race[i]) + 1);
        for (let j = i; j < race.length; j++) gradient.set(race[j], gradient.get(race[j]) - weights[j] / total);
      }
    }
    for (const [id, g] of gradient) scores.set(id, scores.get(id) + 0.55 * g / (1 + counts.get(id)));
  }
  return scores;
}

function topPlaces(weights, places) {
  const probabilities = weights.map(() => 0);
  function visit(remaining, slots, probability) {
    if (!slots) return;
    const total = remaining.reduce((sum, i) => sum + weights[i], 0);
    for (const i of remaining) {
      const next = probability * weights[i] / total;
      probabilities[i] += next;
      visit(remaining.filter(j => j !== i), slots - 1, next);
    }
  }
  if (places >= weights.length) return weights.map(() => 1);
  visit(weights.map((_, i) => i), places, 1);
  return probabilities;
}

async function asset(env, path) {
  const response = await env.ASSETS.fetch(new URL(path, 'https://assets.local'));
  if (!response.ok) throw new Error('Missing race data');
  return response.json();
}

async function report(env, gender, distance, roundKey) {
  const calendar = await asset(env, '/data/calendar.json');
  const today = new Date().toISOString().slice(0, 10);
  const next = calendar.stations.find(s => s.date_end >= today);
  const stations = calendar.stations.filter(s => s.date_start <= today || s.id === next?.id);
  const sets = await Promise.all(stations.map(s => asset(env, '/data/competitions/' + s.id + '/rounds.json')));
  const usePrior = gender === 'men' && distance === 1500;
  const races = usePrior ? historical.map(h => h.map(([name, country]) => key(name, country))) : [];
  const stats = new Map(), selected = [];
  for (const [i, set] of sets.entries()) {
    const station = stations[i];
    for (const heat of set.items) {
      if (heat.gender !== gender || heat.distance_m !== distance || heat.format !== 'individual') continue;
      if (heat.round_key === roundKey) selected.push({station, heat});
      if (heat.evidence !== 'official_results' || heat.result_status?.toLowerCase() !== 'official') continue;
      const ordered = heat.participants.filter(p => p.rank > 0 && !p.penalty && !['DNS','DNF'].includes(p.result)).sort((a,b) => a.rank-b.rank);
      if (ordered.length >= 2) races.push(ordered.map(athlete));
      for (const p of heat.participants.filter(p => p.result !== 'DNS')) {
        const id = athlete(p);
        const row = stats.get(id) || {name:p.name, country:p.country, starts:0, wins:0};
        row.starts++;
        if (p.rank === 1 && !p.penalty) row.wins++;
        stats.set(id, row);
      }
    }
  }
  const hasForecast = ({station, heat}) => heat.evidence === 'official_start_list' &&
    station.date_end >= today && (!heat.local_date || heat.local_date >= today);
  const pending = selected.filter(hasForecast);
  const score = pending.length ? ratings(races) : new Map();
  let slots = 0;
  if (pending.length && pending[0].station.detail_status === 'verified') {
    const schedule = await asset(env, '/data/' + pending[0].station.id + '.json');
    const rule = schedule.entries.find(e => e.round_key === roundKey)?.qualification?.code;
    slots = Number(/^(\d+)Q/.exec(rule || '')?.[1] || 0);
  }
  return selected.map(({heat, station}) => {
    const people = heat.participants.filter(p => p.result !== 'DNS');
    const forecast = hasForecast({heat, station});
    const weights = people.map(p => Math.exp(score.get(athlete(p)) || 0));
    const total = weights.reduce((a,b) => a+b, 0);
    const direct = forecast && slots ? topPlaces(weights, slots) : null;
    return {id:heat.id, people:people.map((p,i) => {
      const row = stats.get(athlete(p));
      return {id:p.athlete_id, starts:row?.starts || 0, wins:row?.wins || 0,
        first:forecast ? weights[i]/total : null, direct:direct?.[i] ?? null};
    })};
  });
}

const lifetime = 7 * 86400;
const encoder = new TextEncoder();
const cookieName = '__Host-ssts_analysis';
const reply = (status, data, cookie) => Response.json(data, {status, headers:{
  'Cache-Control':'private, no-store', 'X-Robots-Tag':'noindex', ...(cookie ? {'Set-Cookie':cookie} : {})
}});
const cookie = (value, age) => cookieName + '=' + value + '; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Strict; Path=/';

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
}

export async function privateAnalysis(request, env) {
  const secret = env.ANALYSIS_PASSWORD;
  if (!secret || request.method !== 'POST') return reply(404, {});
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply(403, {});
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply(415, {});
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object') return reply(400, {});
  const now = Math.floor(Date.now()/1000);
  if (data.action === 'logout') return reply(200, {}, cookie('', 0));
  if (data.action === 'login') {
    if (typeof data.password !== 'string') return reply(401, {});
    const digest = s => crypto.subtle.digest('SHA-256', encoder.encode(s));
    const [a,b] = await Promise.all([digest(data.password), digest(secret)]);
    const left = new Uint8Array(a), right = new Uint8Array(b);
    let diff = 0;
    for (let i=0; i<left.length; i++) diff |= left[i] ^ right[i];
    if (diff) return reply(401, {});
    const exp = String(now + lifetime);
    const sig = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(exp));
    const hex = Array.from(new Uint8Array(sig), n=>n.toString(16).padStart(2,'0')).join('');
    return reply(200, {}, cookie(exp + '.' + hex, lifetime));
  }
  const token = (request.headers.get('Cookie') || '').split(/;\s*/).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const parts = /^(\d{10})\.([0-9a-f]{64})$/.exec(token || '');
  if (!parts || Number(parts[1]) <= now) return reply(401, {});
  const sig = Uint8Array.from(parts[2].match(/../g), s=>parseInt(s,16));
  if (!await crypto.subtle.verify('HMAC', await signingKey(secret), sig, encoder.encode(parts[1]))) return reply(401, {});
  if (data.action !== 'round' || !['men','women'].includes(data.gender) || ![500,1000,1500].includes(data.distance) ||
      typeof data.roundKey !== 'string' || !data.roundKey || data.roundKey.length > 180) return reply(400, {});
  try { return reply(200, await report(env, data.gender, data.distance, data.roundKey)); }
  catch { return reply(503, {}); }
}
