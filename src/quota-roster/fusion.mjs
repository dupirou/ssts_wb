/**
 * Phase 3 — Module 3: Three-Pool Fusion Calibration & Dual-Eligible Pipeline.
 *
 * Strictly isolated from Senior live prediction state:
 * - Reads `data/heats/*` and `data/competitions/*` READ-ONLY (never writes to `data/heats/`).
 * - Instantiates a completely separate `DynamicRatingEngine` for the Junior ISU pool.
 *
 * Zero third-party dependencies (pure ESM).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DynamicRatingEngine,
  V15_RATING_CONFIG,
  conservativeSkill,
  disciplineKey,
  driftSigma,
  parseTimestampMs,
} from '../prediction/rating.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, '../..');

export const DEFAULT_PATHS = {
  rulesConfig: path.join(REPO_ROOT, 'config/quota_rules_2026_27.yaml'),
  chnNameMapping: path.join(REPO_ROOT, 'config/chn_name_mapping.yaml'),
  predictionState: path.join(REPO_ROOT, 'data/heats/prediction_state.json'),
  heatsDir: path.join(REPO_ROOT, 'data/heats'),
  competitionsDir: path.join(REPO_ROOT, 'data/competitions'),
  stations: path.join(REPO_ROOT, 'data/stations.json'),
  athleteNamesZh: path.join(REPO_ROOT, 'data/athlete_names_zh.json'),
  historyDir: path.join(REPO_ROOT, 'data/history'),
  juniorDir: path.join(REPO_ROOT, 'data/quota_roster/junior'),
  chnProfiles: path.join(REPO_ROOT, 'data/quota_roster/chn_athlete_profiles.json'),
  standings: path.join(REPO_ROOT, 'data/quota_roster/standings_2026_27.json'),
  domesticResults: path.join(REPO_ROOT, 'data/quota_roster/domestic_recent_results.json'),
};

const DISTANCES = [500, 1000, 1500];
const GENDERS = ['women', 'men'];
const SESSION_ORDER = { PRELIM: 0, REPECHAGE: 1, MAIN: 2 };
const MAX_VALID_TIME = { 500: 65.0, 1000: 130.0, 1500: 210.0 };
const MIN_VALID_TIME = { 500: 36.0, 1000: 74.0, 1500: 120.0 };
const MIN_TIME_SD = { 500: 0.5, 1000: 1.0, 1500: 2.0 };
const CROSS_DIST_AFFINITY = {
  500: { 1000: 0.75, 1500: 0.25 },
  1000: { 500: 0.55, 1500: 0.55 },
  1500: { 1000: 0.75, 500: 0.25 },
};

// -----------------------------------------------------------------------------
// Zero-Dependency YAML Subset Parser & Config Loaders
// -----------------------------------------------------------------------------

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquoteScalar(raw) {
  const s = raw.trim();
  if (!s || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      return inner.replace(/\\(["\\ntr])/g, (_, esc) => {
        if (esc === 'n') return '\n';
        if (esc === 't') return '\t';
        if (esc === 'r') return '\r';
        return esc;
      });
    }
    return inner.replace(/''/g, "'");
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function splitTopLevelKeyVal(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return [text.slice(0, i), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseFlowValue(str, pos = { i: 0 }) {
  const skipWs = () => {
    while (pos.i < str.length && /\s/.test(str[pos.i])) pos.i++;
  };
  skipWs();
  const ch = str[pos.i];
  if (ch === '[') {
    pos.i++;
    const arr = [];
    skipWs();
    if (str[pos.i] === ']') {
      pos.i++;
      return arr;
    }
    while (pos.i < str.length) {
      arr.push(parseFlowValue(str, pos));
      skipWs();
      if (str[pos.i] === ',') {
        pos.i++;
        continue;
      }
      if (str[pos.i] === ']') {
        pos.i++;
        break;
      }
      break;
    }
    return arr;
  }
  if (ch === '{') {
    pos.i++;
    const obj = {};
    skipWs();
    if (str[pos.i] === '}') {
      pos.i++;
      return obj;
    }
    while (pos.i < str.length) {
      skipWs();
      let rawKey = '';
      if (str[pos.i] === '"' || str[pos.i] === "'") {
        rawKey = parseFlowToken(str, pos);
      } else {
        const start = pos.i;
        while (pos.i < str.length && str[pos.i] !== ':') pos.i++;
        rawKey = str.slice(start, pos.i).trim();
      }
      const key = String(unquoteScalar(rawKey));
      skipWs();
      if (str[pos.i] === ':') pos.i++;
      const val = parseFlowValue(str, pos);
      obj[key] = val;
      skipWs();
      if (str[pos.i] === ',') {
        pos.i++;
        continue;
      }
      if (str[pos.i] === '}') {
        pos.i++;
        break;
      }
      break;
    }
    return obj;
  }
  return unquoteScalar(parseFlowToken(str, pos));
}

function parseFlowToken(str, pos) {
  while (pos.i < str.length && /\s/.test(str[pos.i])) pos.i++;
  const start = pos.i;
  const q = str[pos.i];
  if (q === '"' || q === "'") {
    pos.i++;
    while (pos.i < str.length) {
      if (str[pos.i] === '\\' && q === '"') {
        pos.i += 2;
        continue;
      }
      if (str[pos.i] === q) {
        if (q === "'" && str[pos.i + 1] === "'") {
          pos.i += 2;
          continue;
        }
        pos.i++;
        break;
      }
      pos.i++;
    }
    return str.slice(start, pos.i);
  }
  while (pos.i < str.length && !/[,\]}]/.test(str[pos.i])) pos.i++;
  return str.slice(start, pos.i).trim();
}

function parseInlineValue(valStr) {
  const t = valStr.trim();
  if (!t) return null;
  if (t.startsWith('[') || t.startsWith('{')) {
    return parseFlowValue(t, { i: 0 });
  }
  return unquoteScalar(t);
}

/**
 * Parse a clean subset of YAML (mappings, sequences, flow collections, scalars, comments).
 */
export function parseSimpleYaml(text) {
  const lines = [];
  for (const rawLine of String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')) {
    const cleaned = stripYamlComment(rawLine).replace(/\s+$/, '');
    if (!cleaned.trim()) continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, text: cleaned.trimStart() });
  }
  if (lines.length === 0) return {};

  let idx = 0;

  function parseBlock(minIndent) {
    if (idx >= lines.length) return null;
    if (lines[idx].text === '-' || lines[idx].text.startsWith('- ')) {
      return parseSequence(lines[idx].indent);
    }
    return parseMapping(minIndent);
  }

  function parseSequence(seqIndent) {
    const arr = [];
    while (idx < lines.length && lines[idx].indent === seqIndent) {
      const ln = lines[idx];
      if (ln.text !== '-' && !ln.text.startsWith('- ')) break;
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trimStart();
      idx++;
      if (!rest) {
        if (idx < lines.length && lines[idx].indent > seqIndent) {
          arr.push(parseBlock(lines[idx].indent));
        } else {
          arr.push(null);
        }
        continue;
      }
      const kv = splitTopLevelKeyVal(rest);
      if (kv && !rest.startsWith('{') && !rest.startsWith('[')) {
        const itemIndent = seqIndent + 2;
        const obj = {};
        const key = String(unquoteScalar(kv[0]));
        if (kv[1]) {
          obj[key] = parseInlineValue(kv[1]);
        } else if (idx < lines.length && lines[idx].indent > itemIndent) {
          obj[key] = parseBlock(lines[idx].indent);
        } else if (idx < lines.length && lines[idx].indent === itemIndent && (lines[idx].text === '-' || lines[idx].text.startsWith('- '))) {
          obj[key] = parseSequence(itemIndent);
        } else {
          obj[key] = null;
        }
        while (idx < lines.length && lines[idx].indent >= itemIndent) {
          if (lines[idx].indent === itemIndent && (lines[idx].text === '-' || lines[idx].text.startsWith('- '))) break;
          const nextKv = splitTopLevelKeyVal(lines[idx].text);
          if (!nextKv) break;
          const nk = String(unquoteScalar(nextKv[0]));
          const nv = nextKv[1];
          idx++;
          if (nv) {
            obj[nk] = parseInlineValue(nv);
          } else if (idx < lines.length && lines[idx].indent > itemIndent) {
            obj[nk] = parseBlock(lines[idx].indent);
          } else if (
            idx < lines.length &&
            lines[idx].indent === itemIndent &&
            (lines[idx].text === '-' || lines[idx].text.startsWith('- '))
          ) {
            obj[nk] = parseSequence(itemIndent);
          } else {
            obj[nk] = null;
          }
        }
        arr.push(obj);
      } else {
        arr.push(parseInlineValue(rest));
      }
    }
    return arr;
  }

  function parseMapping(mapIndent) {
    const obj = {};
    while (idx < lines.length && lines[idx].indent >= mapIndent) {
      const ln = lines[idx];
      if (ln.indent > mapIndent) break;
      if (ln.text === '-' || ln.text.startsWith('- ')) break;
      const kv = splitTopLevelKeyVal(ln.text);
      if (!kv) {
        idx++;
        continue;
      }
      const key = String(unquoteScalar(kv[0]));
      const valStr = kv[1];
      idx++;
      if (valStr) {
        let val = parseInlineValue(valStr);
        // Handle multi-line wrapped plain scalar (e.g., PyYAML wrapped `note:` lines)
        if (
          typeof val === 'string' &&
          !valStr.startsWith('"') &&
          !valStr.startsWith("'") &&
          !valStr.startsWith('[') &&
          !valStr.startsWith('{')
        ) {
          const extra = [];
          while (
            idx < lines.length &&
            lines[idx].indent > mapIndent &&
            lines[idx].text !== '-' &&
            !lines[idx].text.startsWith('- ') &&
            !splitTopLevelKeyVal(lines[idx].text)
          ) {
            extra.push(lines[idx].text);
            idx++;
          }
          if (extra.length > 0) {
            val = [val, ...extra].join(' ');
          }
        }
        obj[key] = val;
      } else if (idx < lines.length) {
        const next = lines[idx];
        if (next.indent > mapIndent) {
          obj[key] = parseBlock(next.indent);
        } else if (next.indent === mapIndent && (next.text === '-' || next.text.startsWith('- '))) {
          obj[key] = parseSequence(next.indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  return parseBlock(lines[0].indent) ?? {};
}

export function loadQuotaRulesConfig(yamlPath = DEFAULT_PATHS.rulesConfig) {
  const raw = fs.readFileSync(yamlPath, 'utf8');
  return parseSimpleYaml(raw);
}

export function loadChnNameMapping(yamlPath = DEFAULT_PATHS.chnNameMapping) {
  if (!yamlPath || !fs.existsSync(yamlPath)) return { athletes: [] };
  const raw = fs.readFileSync(yamlPath, 'utf8');
  return parseSimpleYaml(raw) || { athletes: [] };
}

// -----------------------------------------------------------------------------
// General Helpers (Read-Only IO, Dates, Statistics, Ridge L2, Normal Quantile)
// -----------------------------------------------------------------------------

function readJsonOptional(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function normalizeLookupKey(name, country) {
  const plain = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/['’]/g, '');
  const tokens = plain.split(/[^A-Z]+/).filter(Boolean).sort().join('-');
  return `${country}:${tokens}`;
}

export function seasonForDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  if (month >= 7) {
    return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
  }
  return `${year - 1}/${String(year % 100).padStart(2, '0')}`;
}

function maxIsoDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function robustTimeStats(values, minSd = 0.5) {
  if (!values || values.length === 0) return { median: null, sd: null, count: 0 };
  const med = median(values);
  const devs = values.map((v) => Math.abs(v - med));
  const mad = median(devs) ?? 0;
  let sd = 1.4826 * mad;
  if (!(sd > 0) && values.length > 1) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1));
  }
  return { median: med, sd: Math.max(minSd, sd || minSd), count: values.length };
}

function meanAndSd(values, fallbackSd = 1.0) {
  if (!values || values.length === 0) return { mean: 0, sd: fallbackSd };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length < 2) return { mean, sd: fallbackSd };
  const v = values.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (values.length - 1);
  return { mean, sd: Math.max(0.25, Math.sqrt(v)) };
}

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

function parseTimeSeconds(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || /^(no\s*time|pen|yc|rc|dnf|dns|dq|-)$/i.test(s)) return null;
  if (s.includes(':')) {
    const parts = s.split(':');
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    return Number.isFinite(mins) && Number.isFinite(secs) ? mins * 60 + secs : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isValidCleanTime(distanceM, timeS) {
  if (typeof timeS !== 'number' || !Number.isFinite(timeS)) return false;
  const lo = MIN_VALID_TIME[distanceM] ?? 20;
  const hi = MAX_VALID_TIME[distanceM] ?? 250;
  return timeS >= lo && timeS <= hi;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 */
export function normalQuantile(p) {
  const pc = clamp(p, 1e-6, 1 - 1e-6);
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.383577518672690e2,
    -3.066479806614716e1,
    2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838e0,
    -2.549732539343734e0,
    4.374664141464968e0,
    2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996e0,
    3.754408661907416e0,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (pc < pLow) {
    const q = Math.sqrt(-2 * Math.log(pc));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (pc <= pHigh) {
    const q = pc - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - pc));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/**
 * Fit Ridge L2 1D linear regression y = alpha * x + beta (intercept unpenalized).
 */
export function fitRidgeLinear1D(xs, ys, lambda = 1.0, fallback = { alpha: 0.8, beta: -0.65 }) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { alpha: fallback.alpha, beta: fallback.beta, usedFallback: true, n, r: null };
  }
  let xMean = 0;
  let yMean = 0;
  for (let i = 0; i < n; i++) {
    xMean += xs[i];
    yMean += ys[i];
  }
  xMean /= n;
  yMean /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  if (!(sxx > 1e-9) || !(sxy > 0)) {
    return { alpha: fallback.alpha, beta: fallback.beta, usedFallback: true, n, r };
  }

  const rawAlpha = sxy / (sxx + Math.max(0, lambda));
  const alpha = clamp(rawAlpha, 0.1, 2.5);
  const beta = yMean - alpha * xMean;
  return { alpha, beta, usedFallback: false, n, r };
}

/**
 * Fit weighted Ridge L2 1D linear regression y = alpha * x + beta,
 * optionally blending a median prior pseudo-observation (priorZ, priorMu, priorWeight)
 * while computing Pearson correlation r strictly on the real observations.
 */
export function fitWeightedRidgeLinear1D(
  xs,
  ys,
  lambda = 1.0,
  { priorZ = 0.0, priorMu = -0.35, priorWeight = 2.5, fallback = { alpha: 0.65, beta: -0.25 } } = {}
) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { alpha: fallback.alpha, beta: fallback.beta, usedFallback: true, n, r: null };
  }

  // Real-anchor correlation (excluding prior pseudo-observation)
  let rxMean = 0;
  let ryMean = 0;
  for (let i = 0; i < n; i++) {
    rxMean += xs[i];
    ryMean += ys[i];
  }
  rxMean /= n;
  ryMean /= n;
  let rsxx = 0;
  let rsyy = 0;
  let rsxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - rxMean;
    const dy = ys[i] - ryMean;
    rsxx += dx * dx;
    rsyy += dy * dy;
    rsxy += dx * dy;
  }
  const r = rsxx > 0 && rsyy > 0 ? rsxy / Math.sqrt(rsxx * rsyy) : 0;

  // Augmented weighted pairs for Ridge regression
  const ptsX = [...xs];
  const ptsY = [...ys];
  const ptsW = new Array(n).fill(1.0);
  if (priorWeight > 0 && Number.isFinite(priorZ) && Number.isFinite(priorMu)) {
    ptsX.push(priorZ);
    ptsY.push(priorMu);
    ptsW.push(priorWeight);
  }

  let sumW = 0;
  let wxMean = 0;
  let wyMean = 0;
  for (let i = 0; i < ptsX.length; i++) {
    sumW += ptsW[i];
    wxMean += ptsW[i] * ptsX[i];
    wyMean += ptsW[i] * ptsY[i];
  }
  wxMean /= sumW;
  wyMean /= sumW;

  let wsxx = 0;
  let wsxy = 0;
  for (let i = 0; i < ptsX.length; i++) {
    const dx = ptsX[i] - wxMean;
    const dy = ptsY[i] - wyMean;
    wsxx += ptsW[i] * dx * dx;
    wsxy += ptsW[i] * dx * dy;
  }

  if (!(wsxx > 1e-9) || !(wsxy > 0)) {
    return { alpha: fallback.alpha, beta: fallback.beta, usedFallback: true, n, r };
  }

  const rawAlpha = wsxy / (wsxx + Math.max(0, lambda));
  const alpha = clamp(rawAlpha, 0.1, 2.5);
  const beta = wyMean - alpha * wxMean;
  return { alpha, beta, usedFallback: false, n, r };
}

// -----------------------------------------------------------------------------
// Age Classification (CER 2026 Art. 9.2 & Comm. 2807)
// -----------------------------------------------------------------------------

export function classifyAgeGroup(birthDate, config = null) {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(birthDate).trim())) {
    return 'UNKNOWN';
  }
  const dob = String(birthDate).trim();
  const ageCfg = config?.age_eligibility || {};
  const seniorOnlyMax = ageCfg.senior_only?.dob_max || '2007-06-30';
  const dualMin = ageCfg.dual_eligible?.dob_min || '2007-07-01';
  const dualMax = ageCfg.dual_eligible?.dob_max || '2009-06-30';
  const juniorMax = ageCfg.junior_isu_events?.dob_max || '2011-06-30';

  if (dob <= seniorOnlyMax) return 'SENIOR_ONLY';
  if (dob >= dualMin && dob <= dualMax) return 'DUAL_ELIGIBLE';
  if (dob > dualMax && dob <= juniorMax) return 'JUNIOR_ONLY';
  return 'INELIGIBLE_TOO_YOUNG';
}

// -----------------------------------------------------------------------------
// Pool 1: Senior Baseline + 2026/27 WT Replay + Relay Stats + Clean Time Stats
// -----------------------------------------------------------------------------

function resolveLiveAthleteId(p, idMaps) {
  const oid = p.official_skater_id;
  return (
    idMaps.crosswalk?.[p.athlete_id] ||
    (Number.isInteger(oid) && oid > 0 ? idMaps.officialIds?.[oid] || `skr-${oid}` : null) ||
    idMaps.nameLookup?.[normalizeLookupKey(p.name_latin || p.name, p.country)] ||
    p.athlete_id
  );
}

function parseLiveRoundContext(roundLabel, roundEnum) {
  const lbl = String(roundLabel || '');
  const isRep = /^rep\./i.test(lbl) || lbl.toLowerCase().includes('repechage');
  const lower = lbl.toLowerCase();
  let rnd = roundEnum || 'heats';
  let tier = 1;
  if (lower.includes('final') && !lower.includes('quarter') && !lower.includes('semi')) {
    rnd = 'final';
    tier = 5;
  } else if (lower.includes('semifinal')) {
    rnd = 'semifinal';
    tier = 3;
  } else if (lower.includes('quarterfinal')) {
    rnd = 'quarterfinal';
    tier = 2;
  } else if (lower.includes('prelim')) {
    rnd = 'preliminaries';
    tier = 0;
  }
  const session_type = isRep
    ? 'REPECHAGE'
    : rnd === 'preliminaries' || rnd === 'heats'
      ? 'PRELIM'
      : 'MAIN';
  return { session_type, round: rnd, round_tier: tier };
}

function normalizeLiveQual(qualRaw) {
  const q = String(qualRaw || '').trim();
  if (q === 'Q' || q === 'QA') return 'Q';
  if (q === 'q' || q === 'qA') return 'q';
  if (q.toUpperCase().startsWith('ADV')) return 'ADV';
  return q ? 'OUT' : null;
}

function normalizeCompetitionHeatRows(heat, city, idMaps, season) {
  const { session_type, round, round_tier } = parseLiveRoundContext(heat.round_label, heat.round);
  const startUtc = heat.source_start || (heat.local_date ? `${heat.local_date}T00:00:00Z` : null);
  return (heat.participants || []).map((p) => {
    const cid = resolveLiveAthleteId(p, idMaps);
    const timeS = parseTimeSeconds(p.result);
    const qualType = normalizeLiveQual(p.qualification);
    let status = 'NO_TIME';
    if (p.result === 'DNS') status = 'DNS';
    else if (p.penalty?.code === 'YC') status = 'YC';
    else if (p.penalty?.code === 'RC') status = 'RC';
    else if (p.penalty || p.result === 'PEN' || p.result === 'DQ') status = 'PEN';
    else if (p.result === 'DNF') status = 'DNF';
    else if (qualType === 'ADV') status = 'ADV';
    else if (timeS != null) status = 'OK';

    return {
      athlete_id: cid,
      official_skater_id: Number.isInteger(p.official_skater_id) ? p.official_skater_id : null,
      name: p.name_latin || p.name || '',
      country: p.country || '',
      rank: Number.isInteger(p.rank) && p.rank > 0 ? p.rank : null,
      time_s: timeS,
      status,
      qual_type: qualType,
      season,
      city,
      gender: heat.gender,
      distance_m: heat.distance_m,
      session_type,
      round,
      round_tier,
      local_date: heat.local_date || (startUtc ? startUtc.slice(0, 10) : ''),
      start_time_utc: startUtc,
    };
  });
}

function buildSeniorPool({ asOfDate, paths, seniorStateOverride }) {
  const predState = seniorStateOverride ?? readJsonOptional(paths.predictionState);
  const athletesDoc = readJsonOptional(path.join(paths.heatsDir || '', 'athletes.json'));
  const eventsIdx = readJsonOptional(path.join(paths.heatsDir || '', 'events.json'));
  const stationsDoc = readJsonOptional(paths.stations);

  const idMaps = {
    crosswalk: { ...(predState?.crosswalk || {}) },
    officialIds: { ...(predState?.official_ids || {}) },
    nameLookup: { ...(predState?.name_lookup || {}) },
    athleteCountries: { ...(predState?.athlete_countries || {}) },
  };
  if (athletesDoc?.items) {
    for (const a of athletesDoc.items) {
      const latestCountry = a.countries?.[a.countries.length - 1]?.country || '';
      if (latestCountry) idMaps.athleteCountries[a.id] = latestCountry;
      for (const oid of a.official_skater_ids || []) {
        idMaps.officialIds[oid] = a.id;
      }
      for (const c of a.countries || []) {
        idMaps.nameLookup[normalizeLookupKey(a.name, c.country)] = a.id;
        for (const alias of a.aliases || []) {
          idMaps.nameLookup[normalizeLookupKey(alias, c.country)] = a.id;
        }
      }
    }
  }
  const chnProfilesDoc = readJsonOptional(paths.chnProfiles);
  for (const p of chnProfilesDoc?.items || []) {
    if (p.official_skater_id && p.athlete_id) {
      idMaps.officialIds[p.official_skater_id] = p.athlete_id;
    }
    if (p.name_en && p.athlete_id) {
      idMaps.nameLookup[normalizeLookupKey(p.name_en, 'CHN')] = p.athlete_id;
    }
  }
  const juniorAthletesDoc = readJsonOptional(path.join(paths.juniorDir || '', 'athletes.json'));
  for (const a of juniorAthletesDoc?.items || []) {
    if (a.official_skater_id && a.id) {
      idMaps.officialIds[a.official_skater_id] = a.id;
    }
    if (a.name && a.country && a.id) {
      idMaps.nameLookup[normalizeLookupKey(a.name, a.country)] = a.id;
    }
  }

  const throughUtc = predState?.through_timestamp_utc || '';
  const throughDate = throughUtc ? throughUtc.slice(0, 10) : '';
  const replayFromScratch = Boolean(
    !seniorStateOverride && asOfDate && throughDate && asOfDate < throughDate && eventsIdx?.items?.length
  );

  let seniorEngine;
  if (predState?.rating && !replayFromScratch) {
    seniorEngine = DynamicRatingEngine.fromJSON(predState.rating, V15_RATING_CONFIG);
  } else {
    seniorEngine = new DynamicRatingEngine(V15_RATING_CONFIG);
  }

  // Collect clean Senior finish times per (gender, distance_m) and per city
  const seniorRawTimes = new Map(); // "gender:dist" -> Array<{ city, time_s }>
  const seniorRelayStats = new Map(); // athlete_id -> { starts, finalA, bySeason: Map<season, { starts, finalA }> }
  const seniorLastDate = new Map(); // athlete_id -> YYYY-MM-DD
  const seniorBestHighlight = new Map(); // athlete_id -> { date, score, text }

  const recordSeniorActivity = (athleteId, dateStr) => {
    if (!athleteId || !dateStr) return;
    const prev = seniorLastDate.get(athleteId);
    if (!prev || dateStr > prev) seniorLastDate.set(athleteId, dateStr);
  };

  const recordSeniorRelay = (athleteId, dateStr, isFinalA, seasonHint = null, countStarts = 1) => {
    if (!athleteId) return;
    const st = seniorRelayStats.get(athleteId) || { starts: 0, finalA: 0, bySeason: new Map() };
    st.starts += countStarts;
    if (isFinalA) st.finalA += 1;
    const evSeason = seasonHint || seasonForDate(dateStr) || 'unknown';
    const sb = st.bySeason.get(evSeason) || { starts: 0, finalA: 0 };
    sb.starts += countStarts;
    if (isFinalA) sb.finalA += 1;
    st.bySeason.set(evSeason, sb);
    seniorRelayStats.set(athleteId, st);
    recordSeniorActivity(athleteId, dateStr);
  };

  const recordSeniorHighlight = (athleteId, dateStr, label, rank, country) => {
    if (country !== 'CHN' || !rank || rank > 16) return;
    const recencyScore = dateStr ? Number(dateStr.replace(/-/g, '')) : 0;
    const prev = seniorBestHighlight.get(athleteId);
    // Prefer more recent season/event, breaking ties by better rank
    if (!prev || recencyScore > prev.recencyScore || (recencyScore === prev.recencyScore && rank < prev.rank)) {
      seniorBestHighlight.set(athleteId, { recencyScore, rank, text: `${label} #${rank}` });
    }
  };

  // 1a. Historical Senior events (data/heats/events/*.json) for clean times & optionally chronological replay
  const historicalHeatsToReplay = [];
  if (eventsIdx?.items && paths.heatsDir) {
    for (const meta of eventsIdx.items) {
      if (asOfDate && meta.date_start && meta.date_start > asOfDate) continue;
      const ev = readJsonOptional(path.join(paths.heatsDir, meta.file));
      if (!ev?.heats) continue;
      for (const h of ev.heats) {
        const localDate = h.local_date || ev.date_start || '';
        if (asOfDate && localDate && localDate > asOfDate) continue;
        const dk = disciplineKey(h.gender, h.distance_m);
        for (const p of h.participants || []) {
          if (p.status === 'DNS') continue;
          recordSeniorActivity(p.athlete_id, localDate);
          if (p.status === 'OK' && isValidCleanTime(h.distance_m, p.time_s)) {
            let arr = seniorRawTimes.get(dk);
            if (!arr) {
              arr = [];
              seniorRawTimes.set(dk, arr);
            }
            arr.push({ city: ev.city || '', time_s: p.time_s });
          }
          if (h.round === 'final' && h.final_group === 'A' && p.status === 'OK' && p.rank) {
            recordSeniorHighlight(p.athlete_id, localDate, `${ev.season} ${ev.city} ${h.distance_m}m`, p.rank, p.country);
          }
        }
        if (replayFromScratch) {
          historicalHeatsToReplay.push({
            ...h,
            event_id: ev.event_id,
            season: ev.season,
            city: ev.city,
            rows: (h.participants || []).map((p) => ({
              ...p,
              event_id: ev.event_id,
              season: ev.season,
              city: ev.city,
              local_date: localDate,
              start_time_utc: h.start_time_utc,
              gender: h.gender,
              distance_m: h.distance_m,
              session_type: h.session_type,
              round: h.round,
            })),
          });
        }
      }
    }
  }

  if (replayFromScratch && historicalHeatsToReplay.length > 0) {
    historicalHeatsToReplay.sort((a, b) => {
      const ta = a.start_time_utc || '';
      const tb = b.start_time_utc || '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
      const sa = SESSION_ORDER[a.session_type] ?? 9;
      const sb = SESSION_ORDER[b.session_type] ?? 9;
      if (sa !== sb) return sa - sb;
      return (a.round_tier ?? 0) - (b.round_tier ?? 0);
    });
    for (const h of historicalHeatsToReplay) {
      if (h.rows.filter((r) => r.status !== 'DNS').length >= 2) {
        seniorEngine.updateHeat(h.rows);
      }
    }
  }

  // 1b. Historical Senior CHN relay appearances from data/history/events/*.json (strictly <= asOfDate, non-2026/27)
  if (paths.historyDir && fs.existsSync(paths.historyDir)) {
    const cat = readJsonOptional(path.join(paths.historyDir, 'catalog.json'));
    const historyEventsDir = path.join(paths.historyDir, 'events');
    const seenHistoryIds = new Set();
    for (const meta of cat?.events || []) {
      if (seenHistoryIds.has(meta.id)) continue;
      seenHistoryIds.add(meta.id);
      if (meta.season === '2026/27') continue;
      if (asOfDate && meta.date_start && meta.date_start > asOfDate) continue;
      const evDoc = readJsonOptional(path.join(historyEventsDir, `${meta.id}.json`));
      if (!evDoc?.results) continue;
      for (const r of evDoc.results) {
        if (r.format !== 'relay' || r.country !== 'CHN') continue;
        if (r.gender !== 'women' && r.gender !== 'men') continue;
        const evDate = meta.date_end || meta.date_start || '';
        for (const mem of r.members || []) {
          const aid =
            (Number.isInteger(mem.official_skater_id) &&
              (idMaps.officialIds[mem.official_skater_id] || `skr-${mem.official_skater_id}`)) ||
            idMaps.nameLookup[normalizeLookupKey(mem.name, 'CHN')];
          if (!aid) continue;
          const rounds = Array.isArray(mem.rounds) && mem.rounds.length ? mem.rounds : ['QF'];
          const isFinalA = rounds.includes('FA') || r.final_group === 'A';
          recordSeniorRelay(aid, evDate, isFinalA, meta.season || seasonForDate(evDate), rounds.length);
        }
      }
    }
  }

  // 1c. 2026/27 Senior World Tour Replay from data/competitions/*.json
  const stationById = new Map();
  for (const s of stationsDoc?.stations || []) {
    stationById.set(s.id, s);
  }
  const compFiles = [];
  if (paths.competitionsDir && fs.existsSync(paths.competitionsDir)) {
    for (const f of fs.readdirSync(paths.competitionsDir).sort()) {
      if (f.endsWith('.json')) compFiles.push(path.join(paths.competitionsDir, f));
    }
  }

  const incrementalIndivHeats = [];
  const seenCompHeats = new Set();
  for (const filePath of compFiles) {
    const doc = readJsonOptional(filePath);
    const items = doc?.rounds?.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    const stationId = doc.event_id || path.basename(filePath, '.json');
    const station = stationById.get(stationId);
    const city = station?.city_en || station?.city || stationId;
    const season = stationsDoc?.season || '2026/27';

    for (const heat of items) {
      if (heat.evidence !== 'official_results') continue;
      if (heat.result_status && heat.result_status.toLowerCase() !== 'official') continue;
      const localDate = heat.local_date || (heat.source_start ? heat.source_start.slice(0, 10) : '');
      if (asOfDate && localDate && localDate > asOfDate) continue;

      if (heat.format === 'relay') {
        if (heat.gender !== 'women' && heat.gender !== 'men') continue;
        const isFinalA = heat.round === 'final' && heat.group === 'A';
        for (const team of heat.participants || []) {
          if (team.result === 'DNS') continue;
          for (const mem of team.members || []) {
            const aid = resolveLiveAthleteId(
              { ...mem, country: team.country },
              idMaps
            );
            recordSeniorRelay(aid, localDate, isFinalA, season, 1);
          }
        }
        continue;
      }

      if (heat.format !== 'individual') continue;
      if (!GENDERS.includes(heat.gender) || !DISTANCES.includes(heat.distance_m)) continue;
      if (heat.id && seenCompHeats.has(heat.id)) continue;
      if (heat.id) seenCompHeats.add(heat.id);

      const ts = heat.source_start || (localDate ? `${localDate}T00:00:00Z` : '');
      const skipBecauseAlreadyInState = Boolean(
        !replayFromScratch && throughUtc && ts && ts <= throughUtc
      );
      if (skipBecauseAlreadyInState) continue;

      const rows = normalizeCompetitionHeatRows(heat, city, idMaps, season);
      incrementalIndivHeats.push({ heat, rows, ts, localDate, city, season });
    }
  }

  incrementalIndivHeats.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return (a.heat.heat_number ?? 0) - (b.heat.heat_number ?? 0);
  });

  for (const { heat, rows, localDate, city, season } of incrementalIndivHeats) {
    const active = rows.filter((r) => r.status !== 'DNS');
    if (active.length >= 2) {
      seniorEngine.updateHeat(rows);
    }
    const dk = disciplineKey(heat.gender, heat.distance_m);
    for (const r of active) {
      recordSeniorActivity(r.athlete_id, localDate);
      if (r.status === 'OK' && isValidCleanTime(heat.distance_m, r.time_s)) {
        let arr = seniorRawTimes.get(dk);
        if (!arr) {
          arr = [];
          seniorRawTimes.set(dk, arr);
        }
        arr.push({ city, time_s: r.time_s });
      }
      if (heat.round === 'final' && heat.group === 'A' && r.status === 'OK' && r.rank) {
        recordSeniorHighlight(r.athlete_id, localDate, `${season} WT ${city} ${heat.distance_m}m`, r.rank, r.country);
      }
    }
  }

  // Seed lastSeniorDate from ratingEngine states for athletes whose heats weren't iterated above (e.g. test state override)
  for (const gender of GENDERS) {
    for (const dist of DISTANCES) {
      const dMap = seniorEngine.disciplines.get(disciplineKey(gender, dist));
      if (!dMap) continue;
      for (const [aid, st] of dMap.entries()) {
        if (st.lastTimestampMs != null) {
          const dStr = new Date(st.lastTimestampMs).toISOString().slice(0, 10);
          recordSeniorActivity(aid, dStr);
        }
      }
    }
  }

  // Compute Senior venue-adjusted clean time benchmarks and Senior mu scale per (gender, distance_m)
  const seniorPaceBenchmarks = new Map();
  for (const gender of GENDERS) {
    for (const dist of DISTANCES) {
      const dk = disciplineKey(gender, dist);
      const rawArr = seniorRawTimes.get(dk) || [];
      const rawMed = median(rawArr.map((x) => x.time_s));
      const byCity = new Map();
      for (const item of rawArr) {
        if (!item.city) continue;
        let arr = byCity.get(item.city);
        if (!arr) {
          arr = [];
          byCity.set(item.city, arr);
        }
        arr.push(item.time_s);
      }
      const venueOffsets = new Map();
      if (rawMed != null) {
        for (const [city, arr] of byCity.entries()) {
          if (arr.length >= 10) {
            venueOffsets.set(city, median(arr) - rawMed);
          }
        }
      }
      const adjTimes = rawArr.map((item) => item.time_s - (venueOffsets.get(item.city) || 0));
      const tStats = robustTimeStats(adjTimes, MIN_TIME_SD[dist] ?? 0.5);

      const dMap = seniorEngine.disciplines.get(dk);
      const mus = dMap ? [...dMap.values()].filter((s) => s.nStarts > 0).map((s) => s.mu) : [];
      const muStats = meanAndSd(mus, 1.0);

      seniorPaceBenchmarks.set(dk, {
        medianTimeS: tStats.median,
        sdTimeS: tStats.sd,
        sampleCount: tStats.count,
        muMean: muStats.mean,
        muSd: muStats.sd,
        venueOffsets,
      });
    }
  }

  return {
    engine: seniorEngine,
    idMaps,
    paceBenchmarks: seniorPaceBenchmarks,
    relayStats: seniorRelayStats,
    lastDateByAthlete: seniorLastDate,
    highlights: seniorBestHighlight,
    incrementalHeatsReplayed: incrementalIndivHeats.length,
  };
}

// -----------------------------------------------------------------------------
// Pool 2: Junior ISU Dual-Path Calibration (Isolated DynamicRatingEngine)
// -----------------------------------------------------------------------------

function loadJuniorEventDocs(juniorDir, juniorEventsOverride) {
  if (Array.isArray(juniorEventsOverride)) {
    return juniorEventsOverride;
  }
  if (!juniorDir || !fs.existsSync(juniorDir)) return [];
  const idx = readJsonOptional(path.join(juniorDir, 'events.json'));
  const docs = [];
  if (idx?.items?.length) {
    for (const meta of idx.items) {
      const doc = readJsonOptional(path.join(juniorDir, meta.file));
      if (doc) docs.push(doc);
    }
    return docs;
  }
  const eventsDir = path.join(juniorDir, 'events');
  if (fs.existsSync(eventsDir)) {
    for (const f of fs.readdirSync(eventsDir).sort()) {
      if (f.endsWith('.json')) {
        const doc = readJsonOptional(path.join(eventsDir, f));
        if (doc) docs.push(doc);
      }
    }
  }
  return docs;
}

function buildJuniorPool({ asOfDate, config, paths, seniorPool, juniorEventsOverride }) {
  const juniorEngine = new DynamicRatingEngine(V15_RATING_CONFIG);
  const docs = loadJuniorEventDocs(paths.juniorDir, juniorEventsOverride);

  const juniorHeats = [];
  const juniorRelayStats = new Map(); // athlete_id -> { starts, finalA }
  const juniorLastDate = new Map();
  const juniorHighlights = new Map();
  const juniorAthletesMeta = new Map();
  const juniorCleanTimesByDisc = new Map(); // "gender:dist" -> Array<{ athlete_id, city, time_s }>

  const recordJuniorActivity = (athleteId, dateStr) => {
    if (!athleteId || !dateStr) return;
    const prev = juniorLastDate.get(athleteId);
    if (!prev || dateStr > prev) juniorLastDate.set(athleteId, dateStr);
  };

  for (const ev of docs) {
    if (asOfDate && ev.date_start && ev.date_start > asOfDate) continue;

    for (const cls of ev.classifications || []) {
      const evDate = ev.date_end || ev.date_start || '';
      if (asOfDate && evDate && evDate > asOfDate) continue;
      if (cls.country === 'CHN' && cls.athlete_id) {
        juniorAthletesMeta.set(cls.athlete_id, {
          athlete_id: cls.athlete_id,
          official_skater_id: cls.official_skater_id ?? null,
          name_en: cls.athlete_name || '',
          gender: cls.gender,
          country: 'CHN',
        });
        if (cls.final_classification && cls.final_classification <= 8) {
          const recencyScore = evDate ? Number(evDate.replace(/-/g, '')) : 0;
          const prev = juniorHighlights.get(cls.athlete_id);
          if (
            !prev ||
            recencyScore > prev.recencyScore ||
            (recencyScore === prev.recencyScore && cls.final_classification < prev.rank)
          ) {
            const evTag = ev.kind === 'junior_worlds' ? `WJC ${ev.city}` : `JWC${ev.stop_number || ''} ${ev.city}`;
            juniorHighlights.set(cls.athlete_id, {
              recencyScore,
              rank: cls.final_classification,
              text: `${ev.season} ${evTag} ${cls.distance_m}m #${cls.final_classification}`,
            });
          }
        }
      }
    }

    for (const rel of ev.relays || []) {
      const evDate = ev.date_end || ev.date_start || '';
      if (asOfDate && evDate && evDate > asOfDate) continue;
      if (rel.gender !== 'women' && rel.gender !== 'men') continue;
      for (const mem of rel.members || []) {
        const aid = mem.athlete_id;
        if (!aid) continue;
        const rounds = Array.isArray(mem.rounds) && mem.rounds.length ? mem.rounds : ['heat'];
        const st = juniorRelayStats.get(aid) || { starts: 0, finalA: 0 };
        st.starts += rounds.length;
        if (rounds.includes('final_a') || (rounds.includes('final') && rel.final_classification <= 4)) {
          st.finalA += 1;
        }
        juniorRelayStats.set(aid, st);
        recordJuniorActivity(aid, evDate);
      }
    }

    for (const h of ev.heats || []) {
      const localDate = h.local_date || ev.date_start || '';
      if (asOfDate && localDate && localDate > asOfDate) continue;
      if (!GENDERS.includes(h.gender) || !DISTANCES.includes(h.distance_m)) continue;

      const rows = (h.participants || []).map((p) => {
        if (p.country === 'CHN' && p.athlete_id && !juniorAthletesMeta.has(p.athlete_id)) {
          juniorAthletesMeta.set(p.athlete_id, {
            athlete_id: p.athlete_id,
            official_skater_id: p.official_skater_id ?? null,
            name_en: p.name || '',
            gender: h.gender,
            country: 'CHN',
          });
        }
        return {
          athlete_id: p.athlete_id,
          official_skater_id: p.official_skater_id ?? null,
          name: p.name || '',
          country: p.country || '',
          rank: Number.isInteger(p.rank) && p.rank > 0 ? p.rank : null,
          time_s: p.finish_time_s ?? p.time_s ?? null,
          status: p.status || 'NO_TIME',
          qual_type: p.qualification_code || p.qual_type || null,
          season: h.season || ev.season || null,
          city: h.city || ev.city || '',
          gender: h.gender,
          distance_m: h.distance_m,
          session_type: h.session_type || 'MAIN',
          round: h.round || 'heats',
          round_tier: h.round_tier ?? 1,
          local_date: localDate,
          start_time_utc: h.start_time_utc || `${localDate}T12:00:00Z`,
        };
      });

      juniorHeats.push({
        id: h.id || '',
        start_time_utc: h.start_time_utc || `${localDate}T12:00:00Z`,
        local_date: localDate,
        session_type: h.session_type || 'MAIN',
        round_tier: h.round_tier ?? 1,
        heat_name: h.heat_name || '',
        gender: h.gender,
        distance_m: h.distance_m,
        city: h.city || ev.city || '',
        rows,
      });
    }
  }

  juniorHeats.sort((a, b) => {
    if (a.start_time_utc !== b.start_time_utc) return a.start_time_utc < b.start_time_utc ? -1 : 1;
    if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
    const sa = SESSION_ORDER[a.session_type] ?? 9;
    const sb = SESSION_ORDER[b.session_type] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.round_tier !== b.round_tier) return a.round_tier - b.round_tier;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const h of juniorHeats) {
    const active = h.rows.filter((r) => r.status !== 'DNS');
    if (active.length >= 2) {
      juniorEngine.updateHeat(h.rows);
    }
    const dk = disciplineKey(h.gender, h.distance_m);
    for (const r of active) {
      recordJuniorActivity(r.athlete_id, h.local_date);
      if (r.status === 'OK' && isValidCleanTime(h.distance_m, r.time_s)) {
        let arr = juniorCleanTimesByDisc.get(dk);
        if (!arr) {
          arr = [];
          juniorCleanTimesByDisc.set(dk, arr);
        }
        arr.push({ athlete_id: r.athlete_id, city: h.city, time_s: r.time_s });
      }
    }
  }

  const calCfg = config?.roster_model?.calibration || {};
  const ridgeLambda = Number(calCfg.junior_rank_ridge_l2 ?? 1.0);
  const paceWeights = calCfg.junior_pace_weight_by_distance || { '500': 0.45, '1000': 0.35, '1500': 0.2 };
  const sigmaJuniorAdapt = Number(calCfg.sigma_junior_adapt ?? 1.15);

  const asOfMs = asOfDate ? Date.parse(`${asOfDate}T23:59:59Z`) : null;
  const asOfSeason = seasonForDate(asOfDate);

  // Calibrated ratings map: "gender:dist" -> Map<athlete_id, { mu, sigma, mu_rank, mu_pace, mu_jun, sigma_jun, nStarts }>
  const calibrated = new Map();
  const diagnostics = {};

  for (const gender of GENDERS) {
    for (const dist of DISTANCES) {
      const dk = disciplineKey(gender, dist);
      const junMap = juniorEngine.disciplines.get(dk) || new Map();
      const senMap = seniorPool.engine.disciplines.get(dk) || new Map();

      // Path A: Cross-tier Ridge L2 regression (all nationalities!)
      const xs = [];
      const ys = [];
      for (const [aid, jSt] of junMap.entries()) {
        if (!(jSt.nStarts > 0)) continue;
        const sSt = senMap.get(aid);
        if (!sSt || !(sSt.nStarts > 0)) continue;
        xs.push(jSt.mu);
        ys.push(sSt.mu);
      }

      const fit =
        xs.length >= 4
          ? fitRidgeLinear1D(xs, ys, ridgeLambda, { alpha: 0.8, beta: -0.65 })
          : { alpha: 0.8, beta: -0.65, usedFallback: true, n: xs.length, r: null };

      // Path B: Venue-adjusted Junior clean finish times -> Senior pace-equivalent rating
      const rawTimes = juniorCleanTimesByDisc.get(dk) || [];
      const globalJunMed = median(rawTimes.map((x) => x.time_s));
      const junByCity = new Map();
      for (const item of rawTimes) {
        if (!item.city) continue;
        let arr = junByCity.get(item.city);
        if (!arr) {
          arr = [];
          junByCity.set(item.city, arr);
        }
        arr.push(item.time_s);
      }
      const junVenueOffsets = new Map();
      if (globalJunMed != null) {
        for (const [city, arr] of junByCity.entries()) {
          if (arr.length >= 8) {
            junVenueOffsets.set(city, median(arr) - globalJunMed);
          }
        }
      }

      const junTimesByAthlete = new Map();
      for (const item of rawTimes) {
        const adj = item.time_s - (junVenueOffsets.get(item.city) || 0);
        let arr = junTimesByAthlete.get(item.athlete_id);
        if (!arr) {
          arr = [];
          junTimesByAthlete.set(item.athlete_id, arr);
        }
        arr.push(adj);
      }

      const senBench = seniorPool.paceBenchmarks.get(dk);
      const wPace = Number(paceWeights[String(dist)] ?? paceWeights[dist] ?? 0.3);
      const discCfg = V15_RATING_CONFIG.distConfigs?.[dist]
        ? { ...V15_RATING_CONFIG, ...V15_RATING_CONFIG.distConfigs[dist] }
        : V15_RATING_CONFIG;

      const calMap = new Map();
      for (const [aid, jSt] of junMap.entries()) {
        if (!(jSt.nStarts > 0)) continue;
        const sigmaJunDrifted = driftSigma(
          jSt.sigma,
          jSt.lastTimestampMs,
          jSt.lastSeason,
          asOfMs,
          asOfSeason,
          discCfg
        );
        const muRank = fit.alpha * jSt.mu + fit.beta;

        let muPace = null;
        const athleteTimes = junTimesByAthlete.get(aid);
        if (athleteTimes?.length && senBench?.medianTimeS != null && senBench?.sdTimeS > 0) {
          const tSkaterAdj = median(athleteTimes);
          const zPace = clamp((senBench.medianTimeS - tSkaterAdj) / senBench.sdTimeS, -3.5, 3.5);
          muPace = senBench.muMean + zPace * senBench.muSd;
        }

        const muCal = muPace != null ? (1 - wPace) * muRank + wPace * muPace : muRank;
        const sigmaCal = Math.sqrt(
          Math.pow(fit.alpha * sigmaJunDrifted, 2) + sigmaJuniorAdapt * sigmaJuniorAdapt
        );

        const junLastSeason =
          jSt.lastSeason ||
          (jSt.lastTimestampMs != null
            ? seasonForDate(new Date(jSt.lastTimestampMs).toISOString().slice(0, 10))
            : null);
        calMap.set(aid, {
          mu: muCal,
          sigma: sigmaCal,
          mu_rank: muRank,
          mu_pace: muPace,
          mu_jun: jSt.mu,
          sigma_jun: sigmaJunDrifted,
          nStarts: jSt.nStarts,
          recentDelta: jSt.recentDelta,
          lastSeason: junLastSeason,
        });
      }

      calibrated.set(dk, calMap);
      diagnostics[dk] = {
        crossTierPairs: fit.n,
        usedFallback: fit.usedFallback,
        alpha: Number(fit.alpha.toFixed(4)),
        beta: Number(fit.beta.toFixed(4)),
        correlationR: fit.r != null ? Number(fit.r.toFixed(4)) : null,
        paceWeight: wPace,
        juniorSkatersCalibrated: calMap.size,
        juniorMedianTimeS: globalJunMed != null ? Number(globalJunMed.toFixed(3)) : null,
      };
    }
  }

  return {
    engine: juniorEngine,
    calibrated,
    diagnostics,
    relayStats: juniorRelayStats,
    lastDateByAthlete: juniorLastDate,
    highlights: juniorHighlights,
    chnMeta: juniorAthletesMeta,
    eventCount: docs.length,
    heatCount: juniorHeats.length,
  };
}

// -----------------------------------------------------------------------------
// Pool 3: Domestic 甲组 Anchor-Athlete Bridge
// -----------------------------------------------------------------------------

export function computeRankNormalScores(records) {
  if (!Array.isArray(records) || records.length === 0) return [];
  // Group by competition table (source_file or report_date + venue + gender + distance_m)
  const tables = new Map();
  for (const rec of records) {
    const tKey =
      rec.source_file ||
      `${rec.report_date || 'undated'}|${rec.venue || 'unknown'}|${rec.gender}|${rec.distance_m}`;
    let arr = tables.get(tKey);
    if (!arr) {
      arr = [];
      tables.set(tKey, arr);
    }
    arr.push(rec);
  }

  const scored = [];
  for (const group of tables.values()) {
    const valid = group
      .filter((r) => Number.isInteger(r.rank) && r.rank > 0)
      .sort((a, b) => a.rank - b.rank);
    const n = valid.length;
    if (n === 0) continue;

    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && valid[j + 1].rank === valid[i].rank) {
        j++;
      }
      // 1-based average rank position across tied skaters
      const avgPos = (i + 1 + (j + 1)) / 2;
      // Blom normal score quantile (rank 1 -> highest positive z)
      const p = 1 - (avgPos - 0.375) / (n + 0.25);
      const z = normalQuantile(p);
      for (let k = i; k <= j; k++) {
        scored.push({
          ...valid[k],
          avg_rank: avgPos,
          table_size: n,
          z_score: z,
        });
      }
      i = j + 1;
    }
  }
  return scored;
}

function fallbackQuantileToMu(zDom, bestRank, fbCfg) {
  const top1 = Number(fbCfg?.top_1 ?? 0.8);
  const top3 = Number(fbCfg?.top_3 ?? 0.45);
  const top8 = Number(fbCfg?.top_8 ?? 0.05);
  const med = Number(fbCfg?.median ?? -0.5);
  const tail = Number(fbCfg?.tail ?? -1.15);

  const anchors = [
    [-1.25, tail],
    [0.0, med],
    [0.5, top8],
    [1.15, top3],
    [1.95, top1],
  ];
  if (bestRank === 1 && zDom >= 1.5) return top1;
  if (zDom <= anchors[0][0]) return tail;
  if (zDom >= anchors[anchors.length - 1][0]) return top1;
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (zDom >= x0 && zDom <= x1) {
      const t = (zDom - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return med;
}

function buildDomesticPool({ asOfDate, config, paths, seniorPool, juniorPool, domesticOverrideRecords }) {
  let rawRecords = [];
  if (Array.isArray(domesticOverrideRecords)) {
    rawRecords = domesticOverrideRecords;
  } else {
    const doc = readJsonOptional(paths.domesticResults);
    if (Array.isArray(doc?.records)) rawRecords = doc.records;
    else if (Array.isArray(doc)) rawRecords = doc;
  }

  const allowedDivs = new Set(config?.roster_model?.domestic_default_divisions || ['甲组']);
  const venuesByAthlete = new Map();
  const observedVenues = new Set();
  for (const r of rawRecords) {
    if (!r || !r.athlete_id) continue;
    if (r.division && !allowedDivs.has(r.division)) continue;
    if (asOfDate && r.report_date && r.report_date > asOfDate) continue;
    const hasValidRank = Number.isInteger(r.rank) && r.rank > 0;
    const hasValidPoints =
      r.points !== null &&
      r.points !== undefined &&
      r.points !== '' &&
      Number.isFinite(Number(r.points)) &&
      Number(r.points) > 0;
    if (!hasValidRank && !hasValidPoints) continue;
    if (r.venue) {
      observedVenues.add(r.venue);
      let s = venuesByAthlete.get(r.athlete_id);
      if (!s) {
        s = new Set();
        venuesByAthlete.set(r.athlete_id, s);
      }
      s.add(r.venue);
    }
  }
  const filtered = rawRecords.filter((r) => {
    if (!r || !r.athlete_id) return false;
    if (r.division && !allowedDivs.has(r.division)) return false;
    if (!GENDERS.includes(r.gender) || !DISTANCES.includes(Number(r.distance_m))) return false;
    if (asOfDate && r.report_date && r.report_date > asOfDate) return false;
    return Number.isInteger(r.rank) && r.rank > 0;
  });

  if (filtered.length === 0) {
    return {
      calibrated: new Map(),
      diagnostics: {},
      lastDateByAthlete: new Map(),
      relayMemberSet: new Set(),
      highlights: new Map(),
      athletesMeta: new Map(),
      venuesByAthlete,
      observedVenues,
      recordCount: 0,
    };
  }

  const scored = computeRankNormalScores(
    filtered.map((r) => ({ ...r, distance_m: Number(r.distance_m) }))
  );

  const halfLifeDays = Number(config?.roster_model?.domestic_half_life_days ?? 180);
  const asOfMs = asOfDate ? Date.parse(`${asOfDate}T00:00:00Z`) : null;
  const calCfg = config?.roster_model?.calibration || {};
  const anchorMinCount = Number(calCfg.domestic_anchor_min_count ?? 3);
  const minAnchorR = Number(calCfg.domestic_anchor_min_r ?? 0.25);
  const ridgeLambda = Number(calCfg.domestic_anchor_ridge_l2 ?? 1.0);
  const priorZ = Number(calCfg.domestic_anchor_prior_z ?? 0.0);
  const priorMu = Number(calCfg.domestic_anchor_prior_mu ?? -0.35);
  const priorWeight = Number(calCfg.domestic_anchor_prior_weight ?? 2.5);
  const sigmaDomAdapt = Number(calCfg.sigma_domestic_adapt ?? 1.55);
  const sigmaDomFallback = Number(calCfg.sigma_domestic_fallback ?? 1.75);
  const fallbackQuantileCfg = calCfg.domestic_fallback_quantile_mu || {};

  // Aggregate per (gender:dist, athlete_id)
  const aggByDisc = new Map();
  const lastDateByAthlete = new Map();
  const relayMemberSet = new Set();
  const highlights = new Map();
  const athletesMeta = new Map();

  for (const r of scored) {
    const aid = r.athlete_id;
    if (!athletesMeta.has(aid)) {
      athletesMeta.set(aid, {
        athlete_id: aid,
        name_zh: r.name_zh || null,
        name_en: r.name_en || null,
        birth_date: r.birth_date || null,
        gender: r.gender,
        team: r.team || null,
      });
    } else {
      const m = athletesMeta.get(aid);
      if (!m.name_zh && r.name_zh) m.name_zh = r.name_zh;
      if (!m.name_en && r.name_en) m.name_en = r.name_en;
      if (!m.birth_date && r.birth_date) m.birth_date = r.birth_date;
    }

    if (r.is_relay_member) relayMemberSet.add(aid);
    if (r.report_date) {
      const prev = lastDateByAthlete.get(aid);
      if (!prev || r.report_date > prev) lastDateByAthlete.set(aid, r.report_date);
    }

    const recencyScore = r.report_date ? Number(r.report_date.replace(/-/g, '')) : 0;
    const prevHl = highlights.get(aid);
    if (
      r.rank <= 8 &&
      (!prevHl || recencyScore > prevHl.recencyScore || (recencyScore === prevHl.recencyScore && r.rank < prevHl.rank))
    ) {
      const divTag = r.division || '甲组';
      const venueTag = r.venue ? `${r.venue} ` : '';
      highlights.set(aid, {
        recencyScore,
        rank: r.rank,
        text: `国内${divTag} ${venueTag}${r.distance_m}m #${r.rank}`,
      });
    }

    let timeWeight = 1.0;
    if (asOfMs != null && r.report_date) {
      const recMs = Date.parse(`${r.report_date}T00:00:00Z`);
      if (Number.isFinite(recMs) && asOfMs > recMs) {
        const ageDays = (asOfMs - recMs) / 86400000;
        timeWeight = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
      }
    }
    const stabilityBoost = r.is_cumulative ? 1.25 : 1.0;
    const w = timeWeight * stabilityBoost;

    const dk = disciplineKey(r.gender, r.distance_m);
    let dAgg = aggByDisc.get(dk);
    if (!dAgg) {
      dAgg = new Map();
      aggByDisc.set(dk, dAgg);
    }
    const cur = dAgg.get(aid) || {
      sumWZ: 0,
      sumW: 0,
      bestRank: Infinity,
      hasCumulative: false,
      count: 0,
    };
    cur.sumWZ += w * r.z_score;
    cur.sumW += w;
    cur.bestRank = Math.min(cur.bestRank, r.rank);
    if (r.is_cumulative) cur.hasCumulative = true;
    cur.count += 1;
    dAgg.set(aid, cur);
  }

  const calibrated = new Map();
  const diagnostics = {};

  for (const gender of GENDERS) {
    for (const dist of DISTANCES) {
      const dk = disciplineKey(gender, dist);
      const dAgg = aggByDisc.get(dk);
      if (!dAgg || dAgg.size === 0) continue;

      const senMap = seniorPool.engine.disciplines.get(dk) || new Map();
      const junCalMap = juniorPool.calibrated.get(dk) || new Map();

      const xs = [];
      const ys = [];
      for (const [aid, st] of dAgg.entries()) {
        if (!(st.sumW > 0)) continue;
        const zDom = st.sumWZ / st.sumW;
        const sSt = senMap.get(aid);
        const jSt = junCalMap.get(aid);
        if (sSt && sSt.nStarts > 0) {
          xs.push(zDom);
          ys.push(sSt.mu);
        } else if (jSt) {
          xs.push(zDom);
          ys.push(jSt.mu);
        }
      }

      const hasEnoughAnchors = xs.length >= anchorMinCount;
      let fit = hasEnoughAnchors
        ? fitWeightedRidgeLinear1D(xs, ys, ridgeLambda, {
            priorZ,
            priorMu,
            priorWeight,
            fallback: { alpha: 0.65, beta: -0.25 },
          })
        : { alpha: null, beta: null, usedFallback: true, n: xs.length, r: null };
      if (!fit.usedFallback && !(fit.r != null && fit.r >= minAnchorR)) {
        fit = { alpha: null, beta: null, usedFallback: true, n: fit.n, r: fit.r };
      }

      const calMap = new Map();
      for (const [aid, st] of dAgg.entries()) {
        if (!(st.sumW > 0)) continue;
        const zDom = st.sumWZ / st.sumW;
        let muDom;
        let sigmaDom;
        if (!fit.usedFallback) {
          muDom = fit.alpha * zDom + fit.beta;
          // Cumulative multi-stop rankings get a slight stability bonus (smaller variance)
          const effFactor = clamp(0.75 + 0.25 * st.sumW, 0.7, 1.35);
          sigmaDom = sigmaDomAdapt / Math.sqrt(effFactor);
        } else {
          muDom = fallbackQuantileToMu(zDom, st.bestRank, fallbackQuantileCfg);
          sigmaDom = st.hasCumulative ? sigmaDomFallback * 0.94 : sigmaDomFallback;
        }
        calMap.set(aid, {
          mu: muDom,
          sigma: sigmaDom,
          z_dom: zDom,
          best_rank: st.bestRank,
          has_cumulative: st.hasCumulative,
          weight_sum: st.sumW,
          count: st.count,
        });
      }

      calibrated.set(dk, calMap);
      diagnostics[dk] = {
        anchorCount: fit.n,
        usedFallback: fit.usedFallback,
        alpha: fit.alpha != null ? Number(fit.alpha.toFixed(4)) : null,
        beta: fit.beta != null ? Number(fit.beta.toFixed(4)) : null,
        correlationR: fit.r != null ? Number(fit.r.toFixed(4)) : null,
        domesticSkatersCalibrated: calMap.size,
      };
    }
  }

  return {
    calibrated,
    diagnostics,
    lastDateByAthlete,
    relayMemberSet,
    highlights,
    athletesMeta,
    venuesByAthlete,
    observedVenues,
    recordCount: scored.length,
  };
}

// -----------------------------------------------------------------------------
// Inverse-Variance Weighting (IVW) Fusion & Candidate Assembly
// -----------------------------------------------------------------------------

export function fusePoolsIVW(poolEntries) {
  const valid = (poolEntries || []).filter(
    (p) => p && Number.isFinite(p.mu) && Number.isFinite(p.sigma) && p.sigma > 0
  );
  if (valid.length === 0) return null;
  let sumInvVar = 0;
  let sumMuInvVar = 0;
  for (const p of valid) {
    const iv = 1 / (p.sigma * p.sigma);
    sumInvVar += iv;
    sumMuInvVar += p.mu * iv;
  }
  return {
    mu: sumMuInvVar / sumInvVar,
    sigma: Math.sqrt(1 / sumInvVar),
  };
}

function crossDistanceColdStart(knownDistances, targetDist) {
  const aff = CROSS_DIST_AFFINITY[targetDist] || {};
  let sumW = 0;
  let sumWMu = 0;
  for (const [dStr, wAff] of Object.entries(aff)) {
    const d = Number(dStr);
    const known = knownDistances[d];
    if (!known) continue;
    sumW += wAff;
    sumWMu += wAff * known.mu;
  }
  const crossMu = sumW > 0 ? (sumWMu / sumW) * (sumW / (sumW + 0.5)) : 0;
  const mu = clamp(V15_RATING_CONFIG.crossDistWeight * crossMu, -1.6, 1.6);
  const sigma = sumW > 0.3 ? Math.max(1.15, V15_RATING_CONFIG.sigma0 - 0.2 * Math.min(1, sumW)) : V15_RATING_CONFIG.sigma0;
  return { mu, sigma, pools: {} };
}

function collectChnCandidates({ paths, seniorPool, juniorPool, domesticPool }) {
  const candidates = new Map(); // athlete_id -> metadata

  const ensureCandidate = (aid, patch = {}) => {
    if (!aid) return null;
    const cur = candidates.get(aid) || {
      athlete_id: aid,
      official_skater_id: null,
      name_en: null,
      name_zh: null,
      gender: null,
      birth_date: null,
      country: 'CHN',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null && v !== '') {
        if (!cur[k]) cur[k] = v;
      }
    }
    candidates.set(aid, cur);
    return cur;
  };

  // 1. Load official CHN profiles & chn_name_mapping.yaml (highest-priority DOB & name_zh sources)
  const chnProfilesDoc = readJsonOptional(paths.chnProfiles);
  for (const p of chnProfilesDoc?.items || []) {
    ensureCandidate(p.athlete_id, {
      official_skater_id: p.official_skater_id,
      name_en: p.name_en,
      name_zh: p.name_zh,
      gender: p.gender,
      birth_date: p.birth_date,
    });
  }

  const mappingDoc = loadChnNameMapping(paths.chnNameMapping);
  for (const m of mappingDoc?.athletes || []) {
    const cur = ensureCandidate(m.athlete_id, {
      official_skater_id: m.official_skater_id,
      name_en: m.name_en,
      name_zh: m.name_zh,
      gender: m.gender,
      birth_date: m.birth_date,
    });
    // Prefer explicit manual mapping overrides for birth_date and name_zh
    if (cur && m.birth_date) cur.birth_date = m.birth_date;
    if (cur && m.name_zh) cur.name_zh = m.name_zh;
  }

  // 2. Load data/heats/athletes.json + data/athlete_names_zh.json
  const zhDoc = readJsonOptional(paths.athleteNamesZh);
  const zhNorm = new Map();
  for (const [en, zh] of Object.entries(zhDoc?.names || {})) {
    zhNorm.set(normalizeLookupKey(en, 'CHN'), zh);
  }

  const athletesDoc = readJsonOptional(path.join(paths.heatsDir || '', 'athletes.json'));
  for (const a of athletesDoc?.items || []) {
    const latestCountry = a.countries?.[a.countries.length - 1]?.country || '';
    if (latestCountry !== 'CHN') continue;
    ensureCandidate(a.id, {
      official_skater_id: a.official_skater_ids?.[0] ?? null,
      name_en: a.name,
      name_zh: a.name_zh || zhNorm.get(normalizeLookupKey(a.name, 'CHN')) || null,
      gender: a.gender,
    });
  }

  // 3. Standings 2026/27 (if any newly debuted CHN skater)
  const standingsDoc = readJsonOptional(paths.standings);
  for (const tbl of [...(standingsDoc?.world_rankings_individual || []), ...(standingsDoc?.junior_world_cup_individual || [])]) {
    for (const row of tbl.items || []) {
      if (row.country !== 'CHN' || !row.athlete_id) continue;
      ensureCandidate(row.athlete_id, {
        official_skater_id: row.official_skater_id,
        name_en: row.name,
        name_zh: zhNorm.get(normalizeLookupKey(row.name, 'CHN')) || null,
        gender: tbl.gender,
      });
    }
  }

  // 4. Junior CHN athletes
  const juniorAthletesDoc = readJsonOptional(path.join(paths.juniorDir || '', 'athletes.json'));
  for (const a of juniorAthletesDoc?.items || []) {
    if (a.country !== 'CHN') continue;
    const cur = ensureCandidate(a.id, {
      official_skater_id: a.official_skater_id,
      name_en: a.name,
      name_zh: zhNorm.get(normalizeLookupKey(a.name, 'CHN')) || null,
      gender: a.gender,
      birth_date: a.birth_date,
    });
    if (cur && a.birth_date && !cur.birth_date) cur.birth_date = a.birth_date;
  }
  for (const [aid, meta] of juniorPool.chnMeta.entries()) {
    ensureCandidate(aid, meta);
  }

  // 5. Domestic CHN athletes (mapped or dom-tmp-*)
  for (const [aid, meta] of domesticPool.athletesMeta.entries()) {
    ensureCandidate(aid, meta);
  }

  // 6. Any CHN athlete discovered directly inside seniorPool (e.g., synthetic fixtures)
  for (const [aid, country] of Object.entries(seniorPool.idMaps.athleteCountries || {})) {
    if (country !== 'CHN') continue;
    let inferredGender = null;
    for (const g of GENDERS) {
      for (const d of DISTANCES) {
        if (seniorPool.engine.disciplines.get(disciplineKey(g, d))?.has(aid)) {
          inferredGender = g;
          break;
        }
      }
      if (inferredGender) break;
    }
    if (inferredGender) {
      ensureCandidate(aid, { gender: inferredGender });
    }
  }

  return candidates;
}

/**
 * Main Phase 3 entry point: build fused three-pool candidate pool for Women & Men.
 *
 * @param {object} [options]
 * @param {string} [options.asOfDate] - ISO YYYY-MM-DD evaluation date
 * @param {object} [options.config] - Parsed quota_rules_2026_27 config (auto-loaded if omitted)
 * @param {object} [options.paths] - Optional path overrides
 * @param {Array} [options.domesticOverrideRecords] - Optional synthetic/override domestic records
 * @param {Array} [options.juniorEventsOverride] - Optional synthetic/override junior event documents
 * @param {object} [options.seniorStateOverride] - Optional synthetic/override prediction_state.json
 */
export function buildFusedCandidatePool({
  asOfDate = new Date().toISOString().slice(0, 10),
  config = null,
  paths = {},
  domesticOverrideRecords = null,
  juniorEventsOverride = null,
  seniorStateOverride = null,
} = {}) {
  const mergedPaths = { ...DEFAULT_PATHS, ...paths };
  const cfg = config || loadQuotaRulesConfig(mergedPaths.rulesConfig);

  const seniorPool = buildSeniorPool({
    asOfDate,
    paths: mergedPaths,
    seniorStateOverride,
  });
  const juniorPool = buildJuniorPool({
    asOfDate,
    config: cfg,
    paths: mergedPaths,
    seniorPool,
    juniorEventsOverride,
  });
  const domesticPool = buildDomesticPool({
    asOfDate,
    config: cfg,
    paths: mergedPaths,
    seniorPool,
    juniorPool,
    domesticOverrideRecords,
  });

  const rawCandidates = collectChnCandidates({
    paths: mergedPaths,
    seniorPool,
    juniorPool,
    domesticPool,
  });

  const asOfMs = Date.parse(`${asOfDate}T23:59:59Z`);
  const asOfSeason = seasonForDate(asOfDate);
  const calCfg = cfg?.roster_model?.calibration || {};
  const ignoreOldJunior = calCfg.junior_ignore_old_if_active_senior !== false;
  const senGraceDays = Number(calCfg.senior_inactivity_grace_days ?? 150);
  const senMuDecayDays = Number(calCfg.senior_inactivity_mu_decay_days ?? 480);
  const relayDecayCfg = calCfg.relay_season_decay_weights || {};
  const relayWCur = Number(relayDecayCfg.current_season ?? 1.0);
  const relayWPrev1 = Number(relayDecayCfg.prev_1_season ?? 0.5);
  const relayWPrev2 = Number(relayDecayCfg.prev_2_season ?? 0.2);
  const relayWOlder = Number(relayDecayCfg.older_season ?? 0.08);
  const momWeights = calCfg.momentum_pool_weights || {};
  const wMomSen = Number(momWeights.senior ?? 1.0);
  const wMomJun = Number(momWeights.junior ?? 0.35);
  const wMomDom = Number(momWeights.domestic ?? 0.25);

  const seasonStartYear = (s) => {
    const m = /^(\d{4})/.exec(String(s || ''));
    return m ? Number(m[1]) : null;
  };
  const asOfYear = seasonStartYear(asOfSeason);

  const womenEligible = [];
  const womenExcluded = [];
  const womenExcludedQual = [];
  const menEligible = [];
  const menExcluded = [];
  const menExcludedQual = [];

  const unavailableSet = new Set(cfg?.roster_model?.injured_or_unavailable_athlete_ids || []);
  const reqVenueCfg = cfg?.roster_model?.senior_required_domestic_venues || {};
  const reqVenues = Array.isArray(reqVenueCfg.venues) ? reqVenueCfg.venues : [];
  const reqAgeGroups = new Set(reqVenueCfg.applies_to_age_groups || ['SENIOR_ONLY', 'UNKNOWN']);
  const enforceReqVenues = Boolean(
    reqVenueCfg.enabled &&
      reqVenues.length > 0 &&
      reqVenues.some((v) => domesticPool.observedVenues?.has(v))
  );

  for (const meta of rawCandidates.values()) {
    const gender = meta.gender;
    if (!GENDERS.includes(gender)) continue;
    const aid = meta.athlete_id;

    // Check presence across the three pools
    const hasSeniorDisc = DISTANCES.some(
      (d) => (seniorPool.engine.disciplines.get(disciplineKey(gender, d))?.get(aid)?.nStarts || 0) > 0
    );
    const senRelay = seniorPool.relayStats.get(aid) || { starts: 0, finalA: 0 };
    const hasSenior = hasSeniorDisc || senRelay.starts > 0;

    const hasJuniorDisc = DISTANCES.some(
      (d) => juniorPool.calibrated.get(disciplineKey(gender, d))?.has(aid)
    );
    const junRelay = juniorPool.relayStats.get(aid) || { starts: 0, finalA: 0 };
    const hasJunior = hasJuniorDisc || junRelay.starts > 0;

    const hasDomestic = DISTANCES.some(
      (d) => domesticPool.calibrated.get(disciplineKey(gender, d))?.has(aid)
    );

    if (!hasSenior && !hasJunior && !hasDomestic) continue;

    const ageGroup = classifyAgeGroup(meta.birth_date, cfg);
    const isDualEligible = ageGroup === 'DUAL_ELIGIBLE';

    const lastSeniorDate = seniorPool.lastDateByAthlete.get(aid) || null;
    const lastJuniorDate = juniorPool.lastDateByAthlete.get(aid) || null;
    const lastDomesticDate = domesticPool.lastDateByAthlete.get(aid) || null;
    const lastActiveDate = maxIsoDate(lastSeniorDate, maxIsoDate(lastJuniorDate, lastDomesticDate));

    const dataSources = [];
    if (hasSenior) dataSources.push('Senior');
    if (hasJunior) dataSources.push('JWC');
    if (hasDomestic) dataSources.push('Domestic');

    // Age gate: strictly exclude JUNIOR_ONLY & INELIGIBLE_TOO_YOUNG (and junior-only UNKNOWN DOB)
    if (
      ageGroup === 'JUNIOR_ONLY' ||
      ageGroup === 'INELIGIBLE_TOO_YOUNG' ||
      (ageGroup === 'UNKNOWN' && hasJunior && !hasSenior && !hasDomestic)
    ) {
      const excludedEntry = {
        athlete_id: aid,
        official_skater_id: meta.official_skater_id ?? null,
        name_en: meta.name_en || meta.name_zh || aid,
        name_zh: meta.name_zh || null,
        gender,
        birth_date: meta.birth_date || null,
        age_group: ageGroup,
        data_sources: dataSources,
        last_active_date: lastActiveDate,
        reason:
          ageGroup === 'UNKNOWN' ? 'unknown_dob_junior_only' : 'age_ineligible_for_senior',
      };
      if (gender === 'women') womenExcluded.push(excludedEntry);
      else menExcluded.push(excludedEntry);
      continue;
    }

    // Domestic qualification & retired/unavailable gate (e.g. must have raced Hengshui for Senior_ONLY)
    const isUnavailable = unavailableSet.has(aid);
    const athVenues = domesticPool.venuesByAthlete?.get(aid);
    const missingRequiredVenue =
      enforceReqVenues &&
      reqAgeGroups.has(ageGroup) &&
      !reqVenues.some((v) => athVenues && athVenues.has(v));
    if (isUnavailable || missingRequiredVenue) {
      const exclEntry = {
        athlete_id: aid,
        official_skater_id: meta.official_skater_id ?? null,
        name_en: meta.name_en || meta.name_zh || aid,
        name_zh: meta.name_zh || null,
        gender,
        birth_date: meta.birth_date || null,
        age_group: ageGroup,
        data_sources: dataSources,
        last_active_date: lastActiveDate,
        reason: isUnavailable ? 'retired_or_unavailable' : 'missing_required_domestic_venue',
      };
      if (gender === 'women') womenExcludedQual.push(exclEntry);
      else menExcludedQual.push(exclEntry);
      continue;
    }

    // Schedule-Aware Activity Protection for DUAL_ELIGIBLE skaters
    const protectDualActivity = Boolean(
      isDualEligible && lastActiveDate && (!lastSeniorDate || lastActiveDate > lastSeniorDate)
    );
    const activeProtectMs = protectDualActivity ? Date.parse(`${lastActiveDate}T00:00:00Z`) : null;
    const activeProtectSeason = protectDualActivity ? seasonForDate(lastActiveDate) : null;

    const observedDistances = {};
    const momentumSamples = [];

    for (const dist of DISTANCES) {
      const dk = disciplineKey(gender, dist);
      const discCfg = V15_RATING_CONFIG.distConfigs?.[dist]
        ? { ...V15_RATING_CONFIG, ...V15_RATING_CONFIG.distConfigs[dist] }
        : V15_RATING_CONFIG;

      const poolsObj = {};
      const entriesForIvw = [];

      // Pool 1: Senior
      const senSt = seniorPool.engine.disciplines.get(dk)?.get(aid);
      if (senSt && senSt.nStarts > 0) {
        const effLastMs =
          protectDualActivity && activeProtectMs != null
            ? Math.max(senSt.lastTimestampMs ?? 0, activeProtectMs)
            : senSt.lastTimestampMs;
        const effLastSeason =
          protectDualActivity && activeProtectSeason ? activeProtectSeason : senSt.lastSeason;
        const sigmaSenDrifted = driftSigma(
          senSt.sigma,
          effLastMs,
          effLastSeason,
          asOfMs,
          asOfSeason,
          discCfg
        );
        let muSenEff = senSt.mu;
        if (
          !protectDualActivity &&
          senSt.lastTimestampMs != null &&
          Number.isFinite(asOfMs) &&
          asOfMs > senSt.lastTimestampMs
        ) {
          const inactiveDays = (asOfMs - senSt.lastTimestampMs) / 86400000;
          if (inactiveDays > senGraceDays) {
            muSenEff =
              senSt.mu * Math.exp(-(inactiveDays - senGraceDays) / Math.max(1, senMuDecayDays));
          }
        }
        const senEntry = {
          mu: muSenEff,
          mu_raw: senSt.mu,
          sigma: sigmaSenDrifted,
          nStarts: senSt.nStarts,
          activity_protected: protectDualActivity,
        };
        poolsObj.sen = senEntry;
        entriesForIvw.push(senEntry);
        momentumSamples.push({ delta: senSt.recentDelta || 0, weight: wMomSen });
      }

      // Pool 2: Calibrated Junior (ignore historical Junior if active in current-season Senior)
      const junCal = juniorPool.calibrated.get(dk)?.get(aid);
      if (junCal) {
        const junEntry = {
          mu: junCal.mu,
          sigma: junCal.sigma,
          mu_rank: junCal.mu_rank,
          mu_pace: junCal.mu_pace,
          nStarts: junCal.nStarts,
          lastSeason: junCal.lastSeason || null,
        };
        const activeCurrentSenior = Boolean(
          senSt && senSt.nStarts >= 2 && asOfSeason && senSt.lastSeason === asOfSeason
        );
        const junIsOld = Boolean(
          !junCal.lastSeason || (asOfSeason && junCal.lastSeason < asOfSeason)
        );
        if (ignoreOldJunior && activeCurrentSenior && junIsOld) {
          poolsObj.jun_ignored = junEntry;
        } else {
          poolsObj.jun = junEntry;
          entriesForIvw.push(junEntry);
          momentumSamples.push({ delta: junCal.recentDelta || 0, weight: wMomJun });
        }
      }

      // Pool 3: Calibrated Domestic 甲组
      const domCal = domesticPool.calibrated.get(dk)?.get(aid);
      if (domCal) {
        const domEntry = {
          mu: domCal.mu,
          sigma: domCal.sigma,
          z_dom: domCal.z_dom,
          best_rank: domCal.best_rank,
          has_cumulative: domCal.has_cumulative,
        };
        poolsObj.dom = domEntry;
        entriesForIvw.push(domEntry);
        if (!senSt && !poolsObj.jun) {
          momentumSamples.push({ delta: 0.08 * Math.tanh(domCal.z_dom), weight: wMomDom });
        }
      }

      const fused = fusePoolsIVW(entriesForIvw);
      if (fused) {
        observedDistances[dist] = {
          mu: fused.mu,
          sigma: fused.sigma,
          pools: poolsObj,
        };
      }
    }

    // Fill any missing distance among {500, 1000, 1500} using cross-distance affinity prior
    const distances = {};
    for (const dist of DISTANCES) {
      distances[dist] = observedDistances[dist] || crossDistanceColdStart(observedDistances, dist);
    }

    // Scalar form momentum M_i in [-1, +1], gently decayed by inactivity since lastActiveDate
    let rawMomentum = 0;
    let totalMomW = 0;
    for (const s of momentumSamples) {
      rawMomentum += s.delta * s.weight;
      totalMomW += s.weight;
    }
    let formMomentum = totalMomW > 0 ? Math.tanh(rawMomentum / totalMomW / 0.35) : 0;
    if (lastActiveDate) {
      const inactiveDays = Math.max(0, (asOfMs - Date.parse(`${lastActiveDate}T00:00:00Z`)) / 86400000);
      formMomentum *= Math.exp(-inactiveDays / 365);
    }
    formMomentum = clamp(formMomentum, -1, 1);

    // Compute season-decayed Senior relay metrics alongside raw counts
    let seniorWeightedStarts = 0;
    let seniorWeightedFinalA = 0;
    if (senRelay.bySeason && senRelay.bySeason.size > 0) {
      for (const [evSeason, counts] of senRelay.bySeason.entries()) {
        const evYear = seasonStartYear(evSeason);
        const gap = asOfYear != null && evYear != null ? Math.max(0, asOfYear - evYear) : 3;
        const w =
          gap === 0 ? relayWCur : gap === 1 ? relayWPrev1 : gap === 2 ? relayWPrev2 : relayWOlder;
        seniorWeightedStarts += counts.starts * w;
        seniorWeightedFinalA += counts.finalA * w;
      }
    } else {
      seniorWeightedStarts = senRelay.starts;
      seniorWeightedFinalA = senRelay.finalA;
    }

    // Pick most recent/notable highlight across pools
    const hlChoices = [
      seniorPool.highlights.get(aid),
      juniorPool.highlights.get(aid),
      domesticPool.highlights.get(aid),
    ].filter(Boolean);
    hlChoices.sort((a, b) => b.recencyScore - a.recencyScore || a.rank - b.rank);
    const recentHighlight = hlChoices[0]?.text || null;

    const candidateObj = {
      athlete_id: aid,
      official_skater_id: meta.official_skater_id ?? null,
      name_en: meta.name_en || meta.name_zh || aid,
      name_zh: meta.name_zh || null,
      gender,
      birth_date: meta.birth_date || null,
      age_group: ageGroup,
      is_dual_eligible: isDualEligible,
      data_sources: dataSources,
      last_active_date: lastActiveDate,
      recent_highlight: recentHighlight,
      distances,
      form_momentum: Number(formMomentum.toFixed(6)),
      relay_stats: {
        senior_starts: senRelay.starts,
        senior_final_a: senRelay.finalA,
        senior_weighted_starts: Number(seniorWeightedStarts.toFixed(4)),
        senior_weighted_final_a: Number(seniorWeightedFinalA.toFixed(4)),
        junior_starts: junRelay.starts,
        junior_final_a: junRelay.finalA,
        domestic_relay_member: domesticPool.relayMemberSet.has(aid),
      },
    };

    if (gender === 'women') womenEligible.push(candidateObj);
    else menEligible.push(candidateObj);
  }

  // Deterministic sort by conservative peak skill descending
  const sortCandidates = (arr) =>
    arr.sort((a, b) => {
      const peakA = Math.max(
        ...DISTANCES.map((d) => conservativeSkill(a.distances[d].mu, a.distances[d].sigma))
      );
      const peakB = Math.max(
        ...DISTANCES.map((d) => conservativeSkill(b.distances[d].mu, b.distances[d].sigma))
      );
      if (peakB !== peakA) return peakB - peakA;
      return String(a.athlete_id).localeCompare(String(b.athlete_id));
    });

  sortCandidates(womenEligible);
  sortCandidates(menEligible);
  womenExcluded.sort((a, b) => String(a.athlete_id).localeCompare(String(b.athlete_id)));
  menExcluded.sort((a, b) => String(a.athlete_id).localeCompare(String(b.athlete_id)));

  return {
    asOfDate,
    calibrationDiagnostics: {
      senior: {
        incrementalHeatsReplayed: seniorPool.incrementalHeatsReplayed,
      },
      junior: {
        eventsLoaded: juniorPool.eventCount,
        heatsReplayed: juniorPool.heatCount,
        byDiscipline: juniorPool.diagnostics,
      },
      domestic: {
        recordsLoaded: domesticPool.recordCount,
        byDiscipline: domesticPool.diagnostics,
      },
    },
    women: {
      eligible: womenEligible,
      excludedByAge: womenExcluded,
      excludedByQualification: womenExcludedQual,
    },
    men: {
      eligible: menEligible,
      excludedByAge: menExcluded,
      excludedByQualification: menExcludedQual,
    },
  };
}
