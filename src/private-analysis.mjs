import historical from './historical-heats.mjs';

const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const page = (body, status = 200) => new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>私人分析</title><style>body{font:16px/1.6 system-ui;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#203040}input,select,button{font:inherit;padding:.35rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.3rem;border-bottom:1px solid #ddd}summary{cursor:pointer}</style><main>${body}</main></html>`, {status, headers});
const key = (name, country) => country + ':' + name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/['’]/g,'').split(/[^A-Z]+/).filter(Boolean).sort().join('-');
const athlete = p => key(p.name_latin || p.name, p.country);
const percent = n => Math.round(n * 100) + '%';

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

async function report(env, gender, distance) {
  const calendar = await asset(env, '/data/calendar.json');
  const today = new Date().toISOString().slice(0, 10);
  const next = calendar.stations.find(s => s.date_end >= today);
  const stations = calendar.stations.filter(s => s.date_start <= today || s.id === next?.id);
  const sets = await Promise.all(stations.map(s => asset(env, '/data/competitions/' + s.id + '/rounds.json')));
  const usePrior = gender === 'men' && distance === 1500;
  const races = usePrior ? historical.map(h => h.map(([name, country]) => key(name, country))) : [];
  const stats = new Map(), upcoming = [];
  for (const [i, set] of sets.entries()) {
    const station = stations[i];
    for (const heat of set.items) {
      if (heat.gender !== gender || heat.distance_m !== distance || heat.format !== 'individual') continue;
      if (heat.evidence === 'official_start_list' && station.date_end >= today && (!heat.local_date || heat.local_date >= today)) {
        upcoming.push({station, heat});
      }
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
  const score = upcoming.length ? ratings(races) : new Map();
  let body = '<h1>' + (gender === 'men' ? '男子' : '女子') + ' ' + distance + ' 米</h1><h2>待赛分组</h2>';
  if (!upcoming.length) body += '<p>暂无官方待赛分组。</p>';
  else {
    const rules = new Map();
    for (const station of new Set(upcoming.map(x => x.station))) {
      if (station.detail_status !== 'verified') continue;
      const schedule = await asset(env, '/data/' + station.id + '.json');
      for (const e of schedule.entries || []) rules.set(e.round_key, e.qualification?.code);
    }
    for (const {station, heat} of upcoming) {
      const people = heat.participants.filter(p => p.result !== 'DNS');
      if (!people.length) continue;
      const weights = people.map(p => Math.exp(score.get(athlete(p)) || 0));
      const total = weights.reduce((a,b) => a+b,0);
      const slots = Number(/^(\d+)Q/.exec(rules.get(heat.round_key) || '')?.[1] || 0);
      const direct = slots ? topPlaces(weights, slots) : null;
      body += '<h3>' + [station.city,heat.round_label,heat.heat_label].filter(Boolean).map(escape).join(' · ') + '</h3><table><tr><th>选手</th><th>小组第一</th>' + (direct ? '<th>按名次晋级</th>' : '') + '</tr>';
      people.forEach((p,i) => {body += '<tr><td>' + escape(p.name) + '</td><td>' + percent(weights[i]/total) + '</td>' + (direct ? '<td>' + percent(direct[i]) + '</td>' : '') + '</tr>';});
      body += '</table>';
    }
  }
  body += '<p>预测使用' + (usePrior ? '2025/26 赛季 155 组历史成绩及' : '') + '本赛季正式逐组成绩。无交手记录的选手从平均评分起算。</p><h2>本赛季小组胜率</h2><table><tr><th>选手</th><th>第一 / 出赛</th><th>胜率</th></tr>';
  for (const row of [...stats.values()].sort((a,b) => b.wins - a.wins || a.starts - b.starts)) body += '<tr><td>' + escape(row.name) + ' · ' + escape(row.country) + '</td><td>' + row.wins + ' / ' + row.starts + '</td><td>' + percent(row.wins/row.starts) + '</td></tr>';
  return body + '</table>';
}

export async function privateAnalysis(request, env) {
  if (!env.ANALYSIS_PASSWORD) return new Response(null, {status:404, headers});
  const form = '<h1>私人分析</h1><form method="post"><label>密码 <input type="password" name="password" required autocomplete="current-password"></label> <select aria-label="性别" name="gender"><option value="men">男子</option><option value="women">女子</option></select> <select aria-label="距离" name="distance"><option>1500</option><option>1000</option><option>500</option></select> <button>查看</button></form>';
  if (request.method === 'GET') return page(form, 401);
  if (request.method !== 'POST') return new Response(null, {status:405, headers});
  if (request.headers.get('Origin') && request.headers.get('Origin') !== new URL(request.url).origin) return page(form, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return page(form, 415);
  const fields = new URLSearchParams(await request.text());
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a,b] = await Promise.all([digest(fields.get('password') || ''), digest(env.ANALYSIS_PASSWORD)]);
  let difference = 0;
  for (let i=0; i<a.length; i++) difference |= a[i] ^ b[i];
  if (difference) return page(form + '<p>密码有误。</p>', 401);
  const gender = fields.get('gender'), distance = Number(fields.get('distance'));
  if (!['men','women'].includes(gender) || ![500,1000,1500].includes(distance)) return page(form, 400);
  try { return page(await report(env, gender, distance) + '<p><a href="/internal/analysis">返回选择项目</a></p>'); }
  catch { return page('<p>暂时无法读取比赛数据。</p>', 503); }
}
