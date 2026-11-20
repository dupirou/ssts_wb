/**
 * Layer 4 Athlete Deep-Dive Explainer.
 *
 * Produces structured per-starter explanations:
 * - path_breakdown
 * - factor_attribution (exact additive decomposition of s_i - mean(s_h) into 7 components + incident_drag)
 * - key_rivals (1-2 closest competitors with historical clean-race H2H records)
 * - heat_pace_profile
 * - what_if_clean_race
 *
 * Zero external dependencies.
 */

export function h2hKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/**
 * Update a compact H2H map ("idA|idB" -> [winsA, winsB]) using clean finishers
 * (status in {'OK', 'NO_TIME'} and rank > 0) from one completed heat.
 */
export function recordCleanHeatH2H(h2hMap, heatRows) {
  const clean = heatRows.filter(
    (r) => (r.status === 'OK' || r.status === 'NO_TIME') && Number.isInteger(r.rank) && r.rank > 0
  );
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i];
    for (let j = i + 1; j < clean.length; j++) {
      const b = clean[j];
      if (a.athlete_id === b.athlete_id || a.rank === b.rank) continue;
      const firstId = a.athlete_id < b.athlete_id ? a.athlete_id : b.athlete_id;
      const key = a.athlete_id < b.athlete_id ? `${a.athlete_id}|${b.athlete_id}` : `${b.athlete_id}|${a.athlete_id}`;
      let rec = h2hMap.get(key);
      if (!rec) {
        rec = [0, 0];
        h2hMap.set(key, rec);
      }
      const aWon = a.rank < b.rank;
      const firstWon = a.athlete_id === firstId ? aWon : !aWon;
      if (firstWon) rec[0] += 1;
      else rec[1] += 1;
    }
  }
}

/**
 * Query historical clean-race H2H record from idA's perspective against idB,
 * optionally combining a base read-only h2h object with an incremental overlay Map.
 */
export function lookupH2H(h2hStore, idA, idB, overlayStore = null) {
  if (!idA || !idB || idA === idB) {
    return { h2h_wins: 0, h2h_losses: 0, h2h_total: 0 };
  }
  const key = h2hKey(idA, idB);
  const aIsFirst = idA < idB;
  let wins = 0;
  let losses = 0;

  if (h2hStore) {
    const rec = h2hStore instanceof Map ? h2hStore.get(key) : h2hStore[key];
    if (rec) {
      wins += aIsFirst ? rec[0] : rec[1];
      losses += aIsFirst ? rec[1] : rec[0];
    }
  }
  if (overlayStore) {
    const rec2 = overlayStore instanceof Map ? overlayStore.get(key) : overlayStore[key];
    if (rec2) {
      wins += aIsFirst ? rec2[0] : rec2[1];
      losses += aIsFirst ? rec2[1] : rec2[0];
    }
  }
  return { h2h_wins: wins, h2h_losses: losses, h2h_total: wins + losses };
}

/**
 * Compute exact additive linear attribution of s_i - mean(s_h).
 * Guarantee: sum of the 7 named feature components === (s_i - mean_s) within floating-point precision (< 1e-12).
 */
export function computeFactorAttribution(featuresMatrix, scores, scaledTheta, idx, mcPerson) {
  const n = featuresMatrix.length;
  const d = Math.min(scaledTheta.length, featuresMatrix[0]?.length || 0);
  const meanX = new Array(d).fill(0);
  let meanS = 0;
  for (let i = 0; i < n; i++) {
    meanS += scores[i];
    const xi = featuresMatrix[i];
    for (let k = 0; k < d; k++) meanX[k] += xi[k];
  }
  meanS /= Math.max(n, 1);
  for (let k = 0; k < d; k++) meanX[k] /= Math.max(n, 1);

  const xi = featuresMatrix[idx];
  const contrib = (k) => (k < d ? scaledTheta[k] * (xi[k] - meanX[k]) : 0);

  const base_skill = contrib(0);
  const lane = contrib(1) + contrib(2) + contrib(8);
  const repechage_context = contrib(3);
  const recent_form = contrib(4);
  const opening_split = contrib(5);
  const finishing_kick = contrib(6);
  const venue_pace = contrib(7);
  const total_relative_strength = scores[idx] - meanS;
  const incident_drag = mcPerson.what_if_clean
    ? mcPerson.p_total_advance - mcPerson.what_if_clean.p_total_advance
    : 0;

  return {
    base_skill,
    lane,
    opening_split,
    finishing_kick,
    venue_pace,
    recent_form,
    repechage_context,
    total_relative_strength,
    incident_drag,
  };
}

/**
 * Select 1-2 closest in-heat competitors competing around the skater's qualification path.
 */
export function selectKeyRivals(idx, participants, scores, mcPeople, h2hStore, h2hOverlay = null) {
  const self = participants[idx];
  const selfScore = scores[idx];
  const selfAdv = mcPeople[idx].p_total_advance;

  const candidates = [];
  for (let j = 0; j < participants.length; j++) {
    if (j === idx) continue;
    const opp = participants[j];
    const scoreDist = Math.abs(scores[j] - selfScore);
    const advDist = Math.abs(mcPeople[j].p_total_advance - selfAdv);
    const cutoffBonus = mcPeople[j].p_total_advance >= 0.2 && mcPeople[j].p_total_advance <= 0.8 ? -0.1 : 0;
    candidates.push({
      j,
      priority: scoreDist + 0.35 * advDist + cutoffBonus,
    });
  }
  candidates.sort((a, b) => a.priority - b.priority);

  return candidates.slice(0, 2).map(({ j }) => {
    const opp = participants[j];
    const h2h = lookupH2H(
      h2hStore,
      self.canonical_id || self.athlete_id,
      opp.canonical_id || opp.athlete_id,
      h2hOverlay
    );
    return {
      athlete_id: opp.athlete_id,
      name: opp.name,
      country: opp.country,
      strength_diff: selfScore - scores[j],
      ...h2h,
    };
  });
}

/**
 * Build complete 5-module deepDive objects for every participant of a pending heat.
 */
export function explainHeat({ participants, features, scores, scaledTheta, mcHeat, h2hStore, h2hOverlay = null }) {
  const heat_pace_profile = mcHeat.heat_pace || null;
  return participants.map((_, idx) => {
    const mcP = mcHeat.people[idx];
    const path_breakdown = {
      p_first: mcP.p_first,
      p_big_q: mcP.p_big_q,
      p_small_q: mcP.p_small_q,
      p_total_advance: mcP.p_total_advance,
      p_incident: mcP.p_incident,
      p_pen: mcP.p_pen,
      p_dnf: mcP.p_dnf,
      expected_place: mcP.expected_place,
    };
    const factor_attribution = computeFactorAttribution(features, scores, scaledTheta, idx, mcP);
    const key_rivals = selectKeyRivals(idx, participants, scores, mcHeat.people, h2hStore, h2hOverlay);
    const what_if_clean_race = mcP.what_if_clean
      ? {
          p_first: mcP.what_if_clean.p_first,
          p_big_q: mcP.what_if_clean.p_big_q,
          p_small_q: mcP.what_if_clean.p_small_q,
          p_total_advance: mcP.what_if_clean.p_total_advance,
          expected_place: mcP.what_if_clean.expected_place,
        }
      : null;

    return {
      path_breakdown,
      factor_attribution,
      key_rivals,
      heat_pace_profile,
      what_if_clean_race,
    };
  });
}
