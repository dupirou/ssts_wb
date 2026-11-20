/**
 * Exact Plackett-Luce race outcome distributions with numerical stability
 * and strict conservation invariants. Zero external dependencies.
 */

/**
 * Convert raw log-scores s_i into normalized positive weights exp(s_i - max_s).
 * @param {number[]} scores
 * @returns {number[]}
 */
export function scoresToWeights(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error('scores must be a non-empty array');
  }
  let maxScore = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!Number.isFinite(s)) {
      throw new Error(`Invalid non-finite score at index ${i}: ${s}`);
    }
    if (s > maxScore) maxScore = s;
  }
  const weights = new Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    // Clamp exponent differential to avoid underflow to 0 across extreme gaps.
    weights[i] = Math.exp(Math.max(-50, scores[i] - maxScore));
  }
  return weights;
}

/**
 * Exact 1st-place probabilities P(rank_i = 1) = w_i / sum_j w_j.
 * @param {number[]} weights Positive weights (or log-scores if isLogScore=true)
 * @param {{ isLogScore?: boolean }} [options]
 * @returns {number[]}
 */
export function firstPlaceProbs(weights, { isLogScore = false } = {}) {
  const w = isLogScore ? scoresToWeights(weights) : weights;
  if (!Array.isArray(w) || w.length === 0) {
    throw new Error('weights must be a non-empty array');
  }
  let total = 0;
  for (let i = 0; i < w.length; i++) {
    if (!(w[i] > 0) || !Number.isFinite(w[i])) {
      throw new Error(`Invalid weight at index ${i}: ${w[i]}`);
    }
    total += w[i];
  }
  return w.map((x) => x / total);
}

/**
 * Exact Plackett-Luce top-K probabilities P(rank_i <= K) via subset DP.
 * Merges identical picked subsets so n=9, K=4 visits only 130 states.
 * Guarantees sum_i P(rank_i <= K) === min(K, n) up to floating-point epsilon.
 *
 * @param {number[]} weights Positive Plackett-Luce strength weights
 * @param {number} places Number of qualifying places K >= 0
 * @returns {number[]}
 */
export function topPlaces(weights, places) {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('weights must be a non-empty array');
  }
  const n = weights.length;
  for (let i = 0; i < n; i++) {
    if (!(weights[i] > 0) || !Number.isFinite(weights[i])) {
      throw new Error(`Invalid weight at index ${i}: ${weights[i]}`);
    }
  }
  const k = Math.max(0, Math.floor(places || 0));
  if (k === 0) return new Array(n).fill(0);
  if (k >= n) return new Array(n).fill(1);
  if (k === 1) return firstPlaceProbs(weights);

  if (n > 20) {
    throw new Error(`topPlaces bitmask DP supports n <= 20, got ${n}`);
  }

  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weights[i];

  const probs = new Array(n).fill(0);
  // Map from bitmask of already-selected skaters -> exact state probability.
  let layer = new Map([[0, 1.0]]);

  for (let slot = 0; slot < k; slot++) {
    const nextLayer = slot + 1 < k ? new Map() : null;
    for (const [mask, stateProb] of layer) {
      let pickedWeight = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) pickedWeight += weights[i];
      }
      const remWeight = totalWeight - pickedWeight;
      if (!(remWeight > 0)) continue;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) continue;
        const pPick = (stateProb * weights[i]) / remWeight;
        probs[i] += pPick;
        if (nextLayer) {
          const nextMask = mask | (1 << i);
          nextLayer.set(nextMask, (nextLayer.get(nextMask) || 0) + pPick);
        }
      }
    }
    if (nextLayer) layer = nextLayer;
  }

  return probs;
}

/**
 * Exact expected rank under Plackett-Luce:
 * E[rank_i] = 1 + sum_{j != i} w_j / (w_i + w_j).
 * @param {number[]} weights
 * @returns {number[]}
 */
export function expectedPlaces(weights) {
  const n = weights.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let place = 1;
    const wi = weights[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const wj = weights[j];
      place += wj / (wi + wj);
    }
    out[i] = place;
  }
  return out;
}

/**
 * Compute full heat predictions from per-skater log-scores s_i.
 * @param {number[]} scores
 * @param {number} [bigQ=0]
 * @returns {{ weights: number[], pFirst: number[], pBigQ: number[], expectedPlace: number[] }}
 */
export function predictHeat(scores, bigQ = 0) {
  const weights = scoresToWeights(scores);
  const pFirst = firstPlaceProbs(weights);
  const pBigQ = topPlaces(weights, bigQ);
  const expectedPlace = expectedPlaces(weights);
  return { weights, pFirst, pBigQ, expectedPlace };
}
