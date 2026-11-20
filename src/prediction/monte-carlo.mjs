/**
 * Layer 3 Round-Level Monte Carlo Simulation Engine (V2).
 *
 * Uses contiguous Float64Array / Int32Array flat buffers, precomputed normal LUT,
 * inline deterministic Mulberry32 PRNG, and the Gumbel-Max trick (s_i - ln(-ln U_i))
 * for zero-allocation Plackett-Luce sampling (<50ms per 8x5 round @ 10,000 iterations).
 *
 * Features:
 * - Incident decoupling (PEN/YC/RC + DNF) before racing order simulation
 * - Exact Big-Q and cross-heat Small-q simulation with venue-adjusted pace & leader effect
 * - Mid-round live updates via completedHeats (freezes actual Q, ADV slot reductions, & candidate times)
 * - What-If clean-race output (what_if_clean) using exact analytical PL + clean Small-q pass
 * - Strict probability conservation and <200ms latency at N=10,000
 */

import { predictHeat } from './plackett-luce.mjs';

const LUT_SIZE = 65536;
const LUT_MASK = LUT_SIZE - 1;

// Precomputed zero-mean unit-variance Gaussian and Gumbel lookup tables generated once at module load.
const NORM_LUT = (() => {
  const arr = new Float64Array(LUT_SIZE);
  let s = 0x9e3779b9;
  const inv = 1 / 4294967296;
  const twoPi = 2 * Math.PI;
  const nextU = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) * inv;
  };
  for (let i = 0; i < LUT_SIZE; i += 2) {
    const mag = Math.sqrt(-2.0 * Math.log(nextU()));
    const ang = twoPi * nextU();
    arr[i] = mag * Math.cos(ang);
    arr[i + 1] = mag * Math.sin(ang);
  }
  return arr;
})();

const GUMBEL_LUT = (() => {
  const arr = new Float64Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const u = (i + 0.5) / LUT_SIZE;
    arr[i] = -Math.log(-Math.log(u));
  }
  return arr;
})();

export function createPrng(seed = 20261119) {
  let state = seed >>> 0;
  let hasSpare = false;
  let spare = 0;

  function nextUniform() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  }

  function nextNormal() {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const u1 = nextUniform();
    const u2 = nextUniform();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const angle = 2.0 * Math.PI * u2;
    spare = mag * Math.sin(angle);
    hasSpare = true;
    return mag * Math.cos(angle);
  }

  return { nextUniform, nextNormal };
}

function parseCompletedHeat(heatSpec, smallQFromPlace) {
  const parts = heatSpec.participants || [];
  const active = parts.filter((p) => p.status !== 'DNS');
  let advCount = Number.isInteger(heatSpec.adv_count) ? heatSpec.adv_count : 0;
  if (!Number.isInteger(heatSpec.adv_count)) {
    for (const p of active) {
      if (
        p.qual_type === 'ADV' &&
        (p.qual_target === 'NEXT' || p.qual_target === 'FA' || p.qual_target == null)
      ) {
        advCount++;
      }
    }
  }

  let candParticipantIdx = -1;
  let candTime = Infinity;
  if (heatSpec.small_q_candidate && typeof heatSpec.small_q_candidate.time_s === 'number') {
    candTime = heatSpec.small_q_candidate.time_s;
    candParticipantIdx = active.findIndex(
      (p) => p.athlete_id === heatSpec.small_q_candidate.athlete_id
    );
  } else if (smallQFromPlace > 0) {
    const idx = active.findIndex(
      (p) =>
        (p.status === 'OK' || p.status === 'NO_TIME') &&
        p.rank === smallQFromPlace &&
        typeof p.time_s === 'number' &&
        p.time_s > 0
    );
    if (idx >= 0) {
      candParticipantIdx = idx;
      candTime = active[idx].time_s;
    }
  }

  return {
    id: heatSpec.id,
    active,
    advCount,
    candParticipantIdx,
    candTime,
  };
}

export function simulateRound(roundInput, options = {}) {
  const {
    iterations = 10000,
    seed = 20261119,
    includeWhatIfClean = true,
  } = options;

  const allHeats = roundInput.heats || [];
  const completedList = roundInput.completedHeats || [];

  const bigQDefault = roundInput.bigQ ?? (allHeats[0]?.big_q || 0);
  const smallQPlanned = roundInput.smallQPlanned ?? (allHeats[0]?.small_q_planned || 0);
  const smallQFromPlace =
    roundInput.smallQFromPlace ??
    (allHeats[0]?.small_q_from_place || (smallQPlanned > 0 ? bigQDefault + 1 : 0));

  let completedAdvTotal = 0;
  const completedParsed = new Map();
  for (const ch of completedList) {
    const parsed = parseCompletedHeat(ch, smallQFromPlace);
    completedAdvTotal += parsed.advCount;
    completedParsed.set(ch.id, parsed);
  }
  for (const h of allHeats) {
    if (h.completed && !completedParsed.has(h.id)) {
      const parsed = parseCompletedHeat(h, smallQFromPlace);
      completedAdvTotal += parsed.advCount;
      completedParsed.set(h.id, parsed);
    }
  }

  const qActual = Math.max(0, smallQPlanned - completedAdvTotal);

  const pendingHeats = [];
  const fixedCandEntries = [];
  const outHeatMeta = allHeats.map((h, idx) => {
    const comp = completedParsed.get(h.id);
    if (comp) {
      if (comp.candParticipantIdx >= 0 && Number.isFinite(comp.candTime)) {
        fixedCandEntries.push({
          outHeatIdx: idx,
          participantIdx: comp.candParticipantIdx,
          timeS: comp.candTime,
        });
      }
      return { id: h.id, isCompleted: true, active: comp.active, comp };
    }
    const active = (h.participants || []).filter((p) => p.status !== 'DNS');
    const pace = h.heat_pace || {};
    pendingHeats.push({
      outHeatIdx: idx,
      heat: h,
      active,
      bigQ: h.big_q ?? bigQDefault,
      tHeatMean: pace.expectedTimeS ?? pace.expected_time_s ?? 42.0,
      sigmaHeat: pace.sigmaHeat ?? 0.72,
      gapBeta: pace.gapBeta ?? [0.1, 0.25, 0.14],
      sigmaGap: pace.sigmaGap ?? 0.35,
      timeScale: pace.timeScale ?? 1.2,
    });
    return { id: h.id, isCompleted: false, active, heat: h };
  });

  for (const ch of completedList) {
    if (!allHeats.some((h) => h.id === ch.id)) {
      const idx = outHeatMeta.length;
      const comp = completedParsed.get(ch.id);
      if (comp.candParticipantIdx >= 0 && Number.isFinite(comp.candTime)) {
        fixedCandEntries.push({
          outHeatIdx: idx,
          participantIdx: comp.candParticipantIdx,
          timeS: comp.candTime,
        });
      }
      outHeatMeta.push({ id: ch.id, isCompleted: true, active: comp.active, comp });
    }
  }

  const numOutHeats = outHeatMeta.length;
  const outStart = new Int32Array(numOutHeats);
  const outLen = new Int32Array(numOutHeats);
  let totalOutSkaters = 0;
  for (let i = 0; i < numOutHeats; i++) {
    outStart[i] = totalOutSkaters;
    outLen[i] = outHeatMeta[i].active.length;
    totalOutSkaters += outLen[i];
  }

  const numPending = pendingHeats.length;
  const pOutStart = new Int32Array(numPending);
  const pLen = new Int32Array(numPending);
  const pOutHeatIdx = new Int32Array(numPending);
  const pBigQ = new Int32Array(numPending);
  const pTHeat = new Float64Array(numPending);
  const pSigmaHeat = new Float64Array(numPending);
  const pGapB0 = new Float64Array(numPending);
  const pGapB1 = new Float64Array(numPending);
  const pGapB2 = new Float64Array(numPending);
  const pSigmaGap = new Float64Array(numPending);
  const pSkaterScale = new Float64Array(numPending);

  const pScores = new Float64Array(totalOutSkaters);
  const pPen = new Float64Array(totalOutSkaters);
  const pInc = new Float64Array(totalOutSkaters);
  const pZPace = new Float64Array(totalOutSkaters);

  let maxHeatLen = 1;
  for (let h = 0; h < numPending; h++) {
    const ph = pendingHeats[h];
    const oIdx = ph.outHeatIdx;
    const base = outStart[oIdx];
    const n = ph.active.length;
    if (n > maxHeatLen) maxHeatLen = n;
    pOutStart[h] = base;
    pLen[h] = n;
    pOutHeatIdx[h] = oIdx;
    pBigQ[h] = ph.bigQ;
    pTHeat[h] = ph.tHeatMean;
    pSigmaHeat[h] = ph.sigmaHeat;
    pGapB0[h] = ph.gapBeta[0] ?? 0.1;
    pGapB1[h] = ph.gapBeta[1] ?? 0.25;
    pGapB2[h] = ph.gapBeta[2] ?? 0.14;
    pSigmaGap[h] = ph.sigmaGap;
    pSkaterScale[h] = -0.15 * ph.timeScale;

    for (let i = 0; i < n; i++) {
      const part = ph.active[i];
      const slot = base + i;
      pScores[slot] = part.s_score ?? 0;
      const pp = part.p_pen ?? 0;
      const pd = part.p_dnf ?? 0;
      pPen[slot] = pp;
      pInc[slot] = Math.min(0.4, pp + pd);
      pZPace[slot] = part.z_pace ?? 0;
    }
  }

  const totalFixedCands = fixedCandEntries.length;
  const fixedGlobalSlots = new Int32Array(totalFixedCands);
  const fixedTimes = new Float64Array(totalFixedCands);
  for (let f = 0; f < totalFixedCands; f++) {
    fixedGlobalSlots[f] = outStart[fixedCandEntries[f].outHeatIdx] + fixedCandEntries[f].participantIdx;
    fixedTimes[f] = fixedCandEntries[f].timeS;
  }

  const maxRoundCands = numPending + totalFixedCands;
  const gumbels = new Float64Array(maxHeatLen);
  const ord = new Int32Array(maxHeatLen);
  const candTimes = new Float64Array(maxRoundCands);
  const candGlobalSlot = new Int32Array(maxRoundCands);
  const candSortOrd = new Int32Array(maxRoundCands);

  const INV_2_32 = 1 / 4294967296;
  const needSmallQ = qActual > 0 && smallQFromPlace > 0;

  function runPass(withIncidents, passIters, passSeed) {
    const outFirst = new Float64Array(totalOutSkaters);
    const outBigQ = new Float64Array(totalOutSkaters);
    const outSmallQ = new Float64Array(totalOutSkaters);
    const outPen = new Float64Array(totalOutSkaters);
    const outDnf = new Float64Array(totalOutSkaters);
    const outRankSum = new Float64Array(totalOutSkaters);
    const outRankCnt = new Float64Array(totalOutSkaters);
    const winnerTrials = new Float64Array(numOutHeats);

    let rngState = (passSeed >>> 0) || 1;
    const placeMinusOne = smallQFromPlace - 1;

    for (let it = 0; it < passIters; it++) {
      let candCount = 0;
      if (needSmallQ) {
        for (let f = 0; f < totalFixedCands; f++) {
          candTimes[candCount] = fixedTimes[f];
          candGlobalSlot[candCount] = fixedGlobalSlots[f];
          candSortOrd[candCount] = candCount;
          candCount++;
        }
      }

      for (let h = 0; h < numPending; h++) {
        const base = pOutStart[h];
        const n = pLen[h];
        let activeCnt = 0;

        for (let i = 0; i < n; i++) {
          const slot = base + i;
          if (withIncidents) {
            const pI = pInc[slot];
            if (pI > 0) {
              rngState = (rngState + 0x6d2b79f5) | 0;
              let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
              t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
              const uInc = (((t ^ (t >>> 14)) >>> 0) + 0.5) * INV_2_32;
              if (uInc < pI) {
                if (uInc < pPen[slot]) outPen[slot] += 1;
                else outDnf[slot] += 1;
                continue;
              }
            }
          }

          rngState = (rngState + 0x6d2b79f5) | 0;
          let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          gumbels[i] = pScores[slot] + GUMBEL_LUT[((t ^ (t >>> 14)) >>> 16) & LUT_MASK];
          ord[activeCnt++] = i;
        }

        if (activeCnt === 0) continue;

        for (let i = 1; i < activeCnt; i++) {
          const keyIdx = ord[i];
          const keyVal = gumbels[keyIdx];
          let j = i - 1;
          while (j >= 0 && gumbels[ord[j]] < keyVal) {
            ord[j + 1] = ord[j];
            j--;
          }
          ord[j + 1] = keyIdx;
        }

        const winSlot = base + ord[0];
        winnerTrials[pOutHeatIdx[h]] += 1;
        outFirst[winSlot] += 1;

        const qLim = pBigQ[h] < activeCnt ? pBigQ[h] : activeCnt;
        for (let pos = 0; pos < qLim; pos++) {
          outBigQ[base + ord[pos]] += 1;
        }
        for (let pos = 0; pos < activeCnt; pos++) {
          const sl = base + ord[pos];
          outRankSum[sl] += pos + 1;
          outRankCnt[sl] += 1;
        }

        if (needSmallQ && activeCnt >= smallQFromPlace) {
          const candSlot = base + ord[placeMinusOne];
          const scoreGap = pScores[winSlot] > pScores[candSlot] ? pScores[winSlot] - pScores[candSlot] : 0;
          const gapMean = Math.max(
            0.05,
            pGapB0[h] + pGapB1[h] * placeMinusOne + pGapB2[h] * scoreGap + pSkaterScale[h] * pZPace[candSlot]
          );

          rngState = (rngState + 0x6d2b79f5) | 0;
          let t1 = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
          t1 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
          const n1 = NORM_LUT[((t1 ^ (t1 >>> 14)) >>> 16) & LUT_MASK];

          rngState = (rngState + 0x6d2b79f5) | 0;
          let t2 = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
          t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
          const n2 = NORM_LUT[((t2 ^ (t2 >>> 14)) >>> 16) & LUT_MASK];

          const gap = Math.max(0.02, gapMean + pSigmaGap[h] * n2);
          candTimes[candCount] = pTHeat[h] + pSigmaHeat[h] * n1 + gap;
          candGlobalSlot[candCount] = candSlot;
          candSortOrd[candCount] = candCount;
          candCount++;
        }
      }

      if (needSmallQ && candCount > 0) {
        for (let i = 1; i < candCount; i++) {
          const keyIdx = candSortOrd[i];
          const keyTime = candTimes[keyIdx];
          let j = i - 1;
          while (j >= 0 && candTimes[candSortOrd[j]] > keyTime) {
            candSortOrd[j + 1] = candSortOrd[j];
            j--;
          }
          candSortOrd[j + 1] = keyIdx;
        }
        const awardCnt = qActual < candCount ? qActual : candCount;
        for (let k = 0; k < awardCnt; k++) {
          outSmallQ[candGlobalSlot[candSortOrd[k]]] += 1;
        }
      }
    }

    return {
      outFirst,
      outBigQ,
      outSmallQ,
      outPen,
      outDnf,
      outRankSum,
      outRankCnt,
      winnerTrials,
    };
  }

  const mainRes = runPass(true, iterations, seed);

  // For What-If clean race: exact analytical Plackett-Luce for 1st/Big-Q/expected_place
  // plus a fast clean Small-q pass when Small-q is active.
  const cleanSmallQIters = Math.min(iterations, 2500);
  const cleanRes =
    includeWhatIfClean && needSmallQ
      ? runPass(false, cleanSmallQIters, seed ^ 0x9e3779b9)
      : null;

  const analyticalCleanByHeat = new Map();
  if (includeWhatIfClean) {
    for (const ph of pendingHeats) {
      if (ph.active.length > 0) {
        analyticalCleanByHeat.set(
          ph.outHeatIdx,
          predictHeat(
            ph.active.map((p) => p.s_score ?? 0),
            ph.bigQ
          )
        );
      }
    }
  }

  // Compare winners within the same round, including official times as heats finish.
  const roundTimes = outHeatMeta.map((meta) => meta.isCompleted
    ? meta.active.find((p) => p.rank === 1)?.time_s
    : meta.heat.heat_pace?.expectedTimeS
  ).filter((time) => Number.isFinite(time) && time > 0).sort((a, b) => a - b);
  const mid = Math.floor(roundTimes.length / 2);
  const medianTime = roundTimes.length >= 2
    ? (roundTimes[mid] + roundTimes[Math.floor((roundTimes.length - 1) / 2)]) / 2
    : null;

  const outHeats = outHeatMeta.map((meta, hIdx) => {
    const base = outStart[hIdx];
    const n = outLen[hIdx];

    if (meta.isCompleted) {
      const comp = meta.comp;
      const people = meta.active.map((p, i) => {
        const sl = base + i;
        const isFirst = p.rank === 1 ? 1.0 : 0.0;
        const isBigQ = p.qual_type === 'Q' ? 1.0 : 0.0;
        const pSmallQ = mainRes.outSmallQ[sl] / iterations;
        const pTotalAdv = p.qual_type === 'ADV' ? 1.0 : isBigQ + pSmallQ;
        return {
          athlete_id: p.athlete_id,
          p_first: isFirst,
          p_big_q: isBigQ,
          p_small_q: pSmallQ,
          p_total_advance: pTotalAdv,
          p_incident: p.is_incident ? 1.0 : 0.0,
          p_pen: p.incident_type === 'PEN' ? 1.0 : 0.0,
          p_dnf: p.status === 'DNF' ? 1.0 : 0.0,
          expected_place: p.rank ?? n,
          what_if_clean: null,
        };
      });
      return {
        id: meta.id,
        completed: true,
        adv_count: comp.advCount,
        people,
      };
    }

    const wTrials = mainRes.winnerTrials[hIdx] || iterations;
    const pace = meta.heat.heat_pace || null;
    let paceLabel = 'medium';
    if (pace && medianTime !== null && pace.sigmaHeat > 0) {
      const delta = pace.expectedTimeS - medianTime;
      if (delta < -pace.sigmaHeat / 2) paceLabel = 'fast';
      if (delta > pace.sigmaHeat / 2) paceLabel = 'slow';
    }
    const cleanPL = analyticalCleanByHeat.get(hIdx) || null;

    const people = meta.active.map((p, i) => {
      const sl = base + i;
      const pFirst = mainRes.outFirst[sl] / wTrials;
      const pBigQ = mainRes.outBigQ[sl] / iterations;
      const pSmallQ = mainRes.outSmallQ[sl] / iterations;
      const pPenVal = mainRes.outPen[sl] / iterations;
      const pDnfVal = mainRes.outDnf[sl] / iterations;
      const pIncVal = pPenVal + pDnfVal;
      const expPlace = mainRes.outRankCnt[sl] > 0 ? mainRes.outRankSum[sl] / mainRes.outRankCnt[sl] : n;

      let whatIfClean = null;
      if (cleanPL) {
        const cFirst = cleanPL.pFirst[i];
        const cBigQ = cleanPL.pBigQ[i];
        const cSmallQ = cleanRes ? cleanRes.outSmallQ[sl] / cleanSmallQIters : 0;
        whatIfClean = {
          p_first: cFirst,
          p_big_q: cBigQ,
          p_small_q: cSmallQ,
          p_total_advance: cBigQ + cSmallQ,
          expected_place: cleanPL.expectedPlace[i],
        };
      }

      return {
        athlete_id: p.athlete_id,
        p_first: pFirst,
        p_big_q: pBigQ,
        p_small_q: pSmallQ,
        p_total_advance: pBigQ + pSmallQ,
        p_incident: pIncVal,
        p_pen: pPenVal,
        p_dnf: pDnfVal,
        expected_place: expPlace,
        what_if_clean: whatIfClean,
      };
    });

    return {
      id: meta.id,
      completed: false,
      heat_pace: pace
        ? {
            expected_time_s: pace.expectedTimeS,
            pace_delta_s: pace.paceDeltaS,
            pace_label: paceLabel,
          }
        : null,
      people,
    };
  });

  return {
    iterations,
    seed,
    big_q: bigQDefault,
    small_q_planned: smallQPlanned,
    n_adv_completed: completedAdvTotal,
    q_actual: qActual,
    heats: outHeats,
  };
}
