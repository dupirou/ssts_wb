import fs from 'node:fs';
import { key, ratings, chinaResults } from '../src/private-analysis.mjs';
import historical1000 from '../src/historical-women-1000.mjs';
import { sprintModel } from '../src/sprint-model.mjs';
// Run from the repository root. The test station remains unseen during fitting.
const load = (city) =>
  JSON.parse(
    fs.readFileSync('dist/data/competitions/' + city + '/rounds.json', 'utf8')
  ).items.filter(
    (h) =>
      h.format === 'individual' &&
      h.evidence === 'official_results' &&
      h.result_status === 'Official'
  );
const id = (p) => key(p.name_latin || p.name, p.country);
for (const [gender, d] of [
  ['men', 500],
  ['women', 500],
  ['women', 1000]
]) {
  const select = (city) => load(city).filter((h) => h.gender === gender && h.distance_m === d);
  const hs = select('vancouver'),
    test = select('montreal');
  const races = hs
    .map((h) =>
      h.participants
        .filter((p) => p.rank > 0 && !p.penalty && !['DNS', 'DNF'].includes(p.result))
        .sort((a, b) => a.rank - b.rank)
        .map(id)
    )
    .filter((r) => r.length > 1);
  const old = ratings(races),
    score = ratings(
      d === 1000 ? races.concat(historical1000.map((r) => r.map(([n, c]) => key(n, c)))) : races,
      chinaResults(gender, d).standings
    );
  const sprint = sprintModel(hs, score, id);
  const tally = [0, 1].map(() => ({ hit: 0, n: 0, cn: 0, mae: 0, loss: 0 }));
  for (const h of test) {
    const ps = h.participants.filter((p) => p.result !== 'DNS'),
      win = ps.findIndex((p) => p.rank === 1 && !p.penalty);
    if (win < 0 || ps.length < 2) continue;
    const lanes = ps.map((p) => p.starting_position).filter((x) => x > 0),
      center = lanes.reduce((a, b) => a + b, 0) / (lanes.length || 1);
    for (const [j, map] of [old, score].entries()) {
      const t = tally[j],
        w = ps.map((p) =>
          Math.exp((map.get(id(p)) || 0) + (j && d === 500 ? sprint(p, center).adjustment : 0))
        );
      t.n++;
      t.loss -= Math.log(w[win] / w.reduce((a, b) => a + b));
      if (w[win] === Math.max(...w)) t.hit += 1 / w.filter((x) => x === w[win]).length;
      ps.forEach((p, i) => {
        if (p.country !== 'CHN' || !p.rank || p.penalty || p.result === 'DNF') return;
        const pred = w.reduce((z, v, k) => z + (i === k ? 0 : v / (v + w[i])), 1);
        t.cn++;
        t.mae += Math.abs(p.rank - pred);
      });
    }
  }
  console.log(
    gender,
    d,
    tally.map((t, i) => ({
      model: i ? 'updated' : 'baseline',
      heats: t.n,
      firstAccuracy: t.hit / t.n,
      logLoss: t.loss / t.n,
      chinaRankedStarts: t.cn,
      chinaRankMAE: t.mae / t.cn
    }))
  );
}
