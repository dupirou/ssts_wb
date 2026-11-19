import splits from './opening-splits.mjs';

const lane = (p) =>
  Number.isInteger(p.starting_position) && p.starting_position > 0 ? p.starting_position : null;
const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

// Estimate the lane effect after accounting for opponent strength. For measured
// splits, remove their lane trend before estimating an athlete's typical start.
export function sprintModel(heats, rating, athlete) {
  const pairs = [],
    observations = [],
    profiles = new Map();
  let laneSquares = 8,
    laneProduct = 0;
  for (const h of heats) {
    const skaters = h.participants.filter(
      (p) => lane(p) && p.rank > 0 && !p.penalty && !['DNS', 'DNF'].includes(p.result)
    );
    const measured = skaters
      .map((p) => ({ p, t: p.opening_split_seconds ?? splits[h.id + '/' + p.athlete_id] }))
      .filter(({ t }) => typeof t === 'number' && t > 0 && t < 15);
    const start = new Map();
    if (measured.length >= 2) {
      const avgTime = mean(measured.map((x) => x.t)),
        avgLane = mean(measured.map((x) => lane(x.p)));
      for (const { p, t } of measured) {
        const x = lane(p) - avgLane,
          y = t - avgTime;
        observations.push({ id: athlete(p), x, y, t });
        laneSquares += x * x;
        laneProduct += x * y;
        start.set(p, t);
      }
    }
    for (const [i, a] of skaters.entries())
      for (const b of skaters.slice(i + 1)) {
        if (a.rank === b.rank) continue;
        pairs.push({
          offset: (rating.get(athlete(a)) || 0) - (rating.get(athlete(b)) || 0),
          lane: lane(b) - lane(a),
          start: start.has(a) && start.has(b) ? start.get(b) - start.get(a) : null,
          win: Number(a.rank < b.rank)
        });
      }
  }
  const trend = laneProduct / laneSquares;
  for (const { id, x, y, t } of observations) {
    const p = profiles.get(id) || { sum: 0, time: 0, n: 0 };
    p.sum += x * trend - y;
    p.time += t;
    p.n++;
    profiles.set(id, p);
  }
  function fit(feature, prior, base) {
    let beta = 0;
    for (let i = 0; i < 10; i++) {
      let grad = -prior * beta,
        curvature = prior;
      for (const row of pairs) {
        const x = feature(row);
        if (x == null) continue;
        const prob = 1 / (1 + Math.exp(-base(row) - beta * x));
        grad += x * (row.win - prob);
        curvature += x * x * prob * (1 - prob);
      }
      beta += grad / curvature;
    }
    return beta;
  }
  const laneBeta = fit(
    (row) => row.lane,
    20,
    (row) => row.offset
  );
  const startBeta = fit(
    (row) => (row.start == null ? null : row.start - trend * row.lane),
    12,
    (row) => row.offset + laneBeta * row.lane
  );
  return (p, center) => {
    const profile = profiles.get(athlete(p));
    return {
      adjustment:
        laneBeta * (center - (lane(p) ?? center)) +
        startBeta * (profile ? profile.sum / (profile.n + 4) : 0),
      lane: lane(p),
      opening: profile ? profile.time / profile.n : null,
      samples: profile?.n || 0
    };
  };
}
