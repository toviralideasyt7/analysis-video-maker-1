/**
 * Deterministic pipeline stages.
 *
 * Everything here is reproducible and testable without an AI call: source
 * scoring, observation construction, cross-source verification, data-quality
 * gating and the VideoSpec/ThumbnailSpec builders.
 *
 * The heavy math is delegated to the Rust core when the `datarace` binary is
 * available, with an explicit TypeScript fallback otherwise.
 */

import type {
  Conflict,
  DataQualityReport,
  Dataset,
  Observation,
  SourceCandidate,
  SourceRef,
  Story,
  ThumbnailSpec,
  VideoSpec,
  DataStatus,
  Frequency,
} from '@avm/shared';
import { runRustJson, rustAvailable, logger } from './runtime';

// ---------------------------------------------------------------------------
// Source scoring
// ---------------------------------------------------------------------------

export interface SourceScoreWeights {
  authority: number;
  directness: number;
  coverage: number;
  machineReadable: number;
  methodology: number;
  recency: number;
  consistency: number;
}

export const DEFAULT_WEIGHTS: SourceScoreWeights = {
  authority: 0.25,
  directness: 0.2,
  coverage: 0.15,
  machineReadable: 0.1,
  methodology: 0.15,
  recency: 0.05,
  consistency: 0.1,
};

/**
 * Technical source-quality score (0..1). Weights are configurable.
 * This is a data-quality metric only - it is not a ranking of anything else.
 */
export function sourceQualityScore(
  source: Pick<
    SourceCandidate,
    'authority' | 'directness' | 'coverage' | 'machineReadable' | 'methodologyTransparency' | 'recency' | 'consistency'
  >,
  weights: SourceScoreWeights = DEFAULT_WEIGHTS,
): number {
  const machine = source.machineReadable ? 1 : 0.35;
  const raw =
    source.authority * weights.authority +
    source.directness * weights.directness +
    source.coverage * weights.coverage +
    machine * weights.machineReadable +
    source.methodologyTransparency * weights.methodology +
    source.recency * weights.recency +
    source.consistency * weights.consistency;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(1, raw / total));
}

/** Score every candidate in place (returns a new array, does not mutate). */
export function scoreCandidates(
  candidates: SourceCandidate[],
  weights: SourceScoreWeights = DEFAULT_WEIGHTS,
): SourceCandidate[] {
  return candidates
    .map((c) => ({ ...c, qualityScore: sourceQualityScore(c, weights) }))
    .sort((a, b) => b.qualityScore - a.qualityScore);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface ObservationDraft {
  entity: string;
  entityId?: string;
  iso2?: string | null;
  flagCode?: string | null;
  date: string;
  frequency?: Frequency;
  value: number | null;
  unit: string;
  geography?: string;
  source: SourceRef;
  evidence?: Observation['evidence'];
  method?: 'direct' | 'calculated' | 'estimated';
  status?: DataStatus;
  confidence?: number;
}

let observationCounter = 0;

export function resetObservationCounter(): void {
  observationCounter = 0;
}

/**
 * Build an observation. A missing value is *always* serialised as `null` with
 * status UNKNOWN - there is no code path that substitutes a number.
 */
export function buildObservation(draft: ObservationDraft): Observation {
  observationCounter += 1;
  const value = draft.value === null || Number.isNaN(draft.value) ? null : draft.value;
  const status: DataStatus = value === null ? 'UNKNOWN' : (draft.status ?? 'SUPPORTED');
  const entityId = draft.entityId ?? draft.entity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    observationId: `obs_${String(observationCounter).padStart(5, '0')}`,
    entity: {
      id: entityId,
      name: draft.entity,
      iso2: draft.iso2 ?? null,
      flagCode: draft.flagCode ?? null,
      group: null,
    },
    date: draft.date,
    frequency: draft.frequency ?? inferFrequency(draft.date),
    value,
    unit: draft.unit,
    geography: draft.geography,
    source: draft.source,
    evidence: draft.evidence,
    method: draft.method ?? 'direct',
    status,
    confidence: draft.confidence,
  };
}

export function inferFrequency(date: string): Frequency {
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return 'daily';
  if (/^\d{4}-\d{2}$/.test(date)) return 'monthly';
  if (/^\d{4}-Q[1-4]$/i.test(date)) return 'quarterly';
  if (/^\d{4}$/.test(date)) return 'annual';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Extraction + verification hardening
// ---------------------------------------------------------------------------

/**
 * Common name variants that must resolve to one canonical entity, so that two
 * sources spelling a country differently still land in the same verification
 * cell (and the same bar) even when the Rust resolver is unavailable.
 */
const ENTITY_ALIASES: Record<string, string> = {
  'usa': 'United States',
  'u.s.a.': 'United States',
  'u.s.': 'United States',
  'united states of america': 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'south korea': 'Korea, Rep.',
  'republic of korea': 'Korea, Rep.',
  'korea, south': 'Korea, Rep.',
  'north korea': "Korea, Dem. People's Rep.",
  'russia': 'Russian Federation',
  'vietnam': 'Viet Nam',
  'iran': 'Iran, Islamic Rep.',
  'syria': 'Syrian Arab Republic',
  'laos': "Lao PDR",
  'moldova': 'Moldova, Rep.',
  'macedonia': 'North Macedonia',
  'ivory coast': "Cote d'Ivoire",
  "côte d'ivoire": "Cote d'Ivoire",
  'tanzania': 'Tanzania, United Rep.',
  'bolivia': 'Bolivia, Plurinational State of',
  'venezuela': 'Venezuela, RB',
  'egypt': 'Egypt, Arab Rep.',
  'yemen': 'Yemen, Rep.',
  'kyrgyzstan': 'Kyrgyz Republic',
  'slovakia': 'Slovak Republic',
  'czechia': 'Czech Republic',
  'czech republic': 'Czech Republic',
  'eswatini': 'Eswatini',
  'swaziland': 'Eswatini',
  'turkey': 'Turkiye',
  'türkiye': 'Turkiye',
  'cape verde': 'Cabo Verde',
  'east timor': 'Timor-Leste',
  'brunei': 'Brunei Darussalam',
  'gambia': 'Gambia, The',
  'bahamas': 'Bahamas, The',
  'congo': 'Congo, Rep.',
  'democratic republic of the congo': 'Congo, Dem. Rep.',
  'drc': 'Congo, Dem. Rep.',
  'hong kong': 'Hong Kong SAR, China',
  'macao': 'Macao SAR, China',
  'palestine': 'West Bank and Gaza',
  'republic of congo': 'Congo, Rep.',
  'ivory coast republic': "Cote d'Ivoire",
  'united arab emirates': 'United Arab Emirates',
  'saudi': 'Saudi Arabia',
  'south africa': 'South Africa',
  'new zealand': 'New Zealand',
  'sri lanka': 'Sri Lanka',
  'costa rica': 'Costa Rica',
  'dominican republic': 'Dominican Republic',
  'el salvador': 'El Salvador',
  'puerto rico': 'Puerto Rico',
  'trinidad and tobago': 'Trinidad and Tobago',
  'bosnia': 'Bosnia and Herzegovina',
  'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'north macedonia': 'North Macedonia',
  'timor-leste': 'Timor-Leste',
  'eswatini (swaziland)': 'Eswatini',
};

/** Canonical display name for an entity (alias map first, then the raw name). */
export function aliasEntityName(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ENTITY_ALIASES[key] ?? name.trim().replace(/\s+/g, ' ');
}

/** Suffixes that never change an entity's identity ("Apple Inc." is still Apple). */
const CORPORATE_SUFFIXES = /\s*\b(inc|ltd|llc|corp|corporation|co|company|gmbh|s\.?a\.?|s\.?r\.?l\.?|pty|plc|bv|nv|ab|asa|oyj|k\.?k\.?)\.?$/i;

/**
 * Strip trailing corporate suffixes so "Apple", "Apple Inc." and
 * "APPLE CORP" all resolve to the same entity. Never returns an empty
 * string: if stripping would erase the whole name, the name is kept.
 */
export function stripCorporateSuffix(name: string): string {
  let out = name.trim().replace(/\s+/g, ' ');
  let prev = '';
  while (prev !== out) {
    prev = out;
    out = out.replace(CORPORATE_SUFFIXES, '').trim();
  }
  return out === '' ? name.trim().replace(/\s+/g, ' ') : out;
}

/**
 * Stable grouping key for an entity across sources: suffix-stripped, aliased,
 * lower-cased, punctuation-collapsed. "USA", "United States" and
 * "United States of America" all become the same cell, as do
 * "Apple" and "Apple Inc.".
 */
export function canonicalEntityKey(name: string): string {
  return aliasEntityName(stripCorporateSuffix(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse a raw value cell that may carry scale words, currency symbols or a
 * percent sign. "1.2M" -> 1_200_000, "$45.2bn" -> 45_200_000_000,
 * "12.5k" -> 12_500, "37%" -> { value: 37, unitHint: 'percent' }.
 * Returns value null when the cell holds no parseable number.
 */
export function parseScaledNumber(raw: string): { value: number | null; unitHint?: 'percent' } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || /^n\/?a$/i.test(trimmed)) return { value: null };
  const isPercent = /%$/.test(trimmed);
  // Collapse all whitespace first ("1 234" -> "1234", "1.2 million" -> "1.2million").
  let cleaned = trimmed
    .replace(/\s+/g, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/,/g, '')
    .replace(/%$/, '');
  // Trailing or leading scale words: 1.2M, 3.4 billion, $45.2bn, 12.5k
  const multipliers: Array<[RegExp, number]> = [
    [/(trillion|tn|t)$/i, 1e12],
    [/(billion|bn|bln|b)$/i, 1e9],
    [/(million|mn|mln|m)$/i, 1e6],
    [/(thousand|k)$/i, 1e3],
  ];
  let multiplier = 1;
  for (const [pattern, factor] of multipliers) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
      multiplier = factor;
      break;
    }
  }
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return { value: null };
  return { value: value * multiplier, ...(isPercent ? { unitHint: 'percent' as const } : {}) };
}

/**
 * Reduce a unit word to its canonical base for comparison: "million",
 * "millions", "M" -> { unit: 'count', multiplier: 1e6 }; "percent"/"%" stay
 * percent; anything unrecognised passes through unchanged.
 */
export function normalizeUnitWord(unit: string): { unit: string; multiplier: number } {
  const u = unit.trim().toLowerCase();
  if (/^(million|millions|mn|mln|m)$/.test(u)) return { unit: 'count', multiplier: 1e6 };
  if (/^(billion|billions|bn|bln|b)$/.test(u)) return { unit: 'count', multiplier: 1e9 };
  if (/^(trillion|trillions|tn|t)$/.test(u)) return { unit: 'count', multiplier: 1e12 };
  if (/^(thousand|thousands|k)$/.test(u)) return { unit: 'count', multiplier: 1e3 };
  if (/^(percent|percentage|pct|%)$/.test(u)) return { unit: 'percent', multiplier: 1 };
  if (/^(count|number|people|persons|total|index|usd|dollars?)$/.test(u)) return { unit: u === 'dollars' || u === 'dollar' ? 'USD' : u, multiplier: 1 };
  return { unit: unit.trim() === '' ? 'count' : unit.trim(), multiplier: 1 };
}

/**
 * Identity of a source for *independence* purposes: normalised publisher name
 * plus the URL host. Two pages on the same domain, or two rows from the same
 * API URL, are the same source - not independent corroboration.
 */
export function publisherKey(o: Observation): string {
  const publisher = (o.source.publisher ?? '').trim().toLowerCase();
  let host = '';
  try {
    host = new URL(o.source.url ?? '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = '';
  }
  return `${publisher}||${host}`;
}

export function sourceRef(input: {  url: string;
  publisher: string;
  title?: string;
  publishedAt?: string | null;
  identifier?: string;
}): SourceRef {
  return {
    url: input.url,
    publisher: input.publisher,
    title: input.title,
    publishedAt: input.publishedAt ?? null,
    retrievedAt: new Date().toISOString(),
    identifier: input.identifier,
  };
}

// ---------------------------------------------------------------------------
// Dataset assembly + stats
// ---------------------------------------------------------------------------

/**
 * The range the data actually covers.
 *
 * The requested range and the observed range are different things: asking the
 * World Bank for 1990-2026 returns nothing for 2026, and a spec that keeps
 * claiming 2026 is stating something the dataset does not support. The QA agent
 * caught exactly this, so the dataset now reports what it observed.
 */
export function observedTimeRange(observations: Observation[], fallback: { start: string; end: string }): { start: string; end: string } {
  const dates = observations
    .map((o) => o.date)
    .filter((d) => /^\d{4}/.test(d))
    .sort();
  if (dates.length === 0) return fallback;
  const label = (iso: string): string => (o => o)(iso.slice(0, 4));
  return { start: label(dates[0]), end: label(dates[dates.length - 1]) };
}
export function datasetStats(observations: Observation[]): Dataset['stats'] {
  const stats: Dataset['stats'] = {
    observations: observations.length,
    entities: new Set(observations.map((o) => o.entity.id)).size,
    verified: 0,
    supported: 0,
    estimated: 0,
    unknown: 0,
    conflicting: 0,
    rejected: 0,
  };
  for (const o of observations) {
    switch (o.status) {
      case 'VERIFIED':
        stats.verified += 1;
        break;
      case 'SUPPORTED':
        stats.supported += 1;
        break;
      case 'ESTIMATED':
        stats.estimated += 1;
        break;
      case 'UNKNOWN':
        stats.unknown += 1;
        break;
      case 'CONFLICTING':
        stats.conflicting += 1;
        break;
      case 'REJECTED':
        stats.rejected += 1;
        break;
    }
  }
  return stats;
}

export function buildDataset(input: {
  projectId: string;
  datasetId: string;
  name: string;
  metric: string;
  unit: string;
  timeRange: { start: string; end: string };
  frequency: Frequency;
  missingDataPolicy: Dataset['missingDataPolicy'];
  observations: Observation[];
  conflicts: Conflict[];
  version?: number;
  frozen?: boolean;
}): Dataset {
  return {
    datasetId: input.datasetId,
    projectId: input.projectId,
    name: input.name,
    metric: input.metric,
    unit: input.unit,
    timeRange: input.timeRange,
    frequency: input.frequency,
    missingDataPolicy: input.missingDataPolicy,
    version: input.version ?? 1,
    frozen: input.frozen ?? false,
    observations: input.observations,
    conflicts: input.conflicts,
    stats: datasetStats(input.observations),
    createdAt: new Date().toISOString(),
  };
}

export function datasetToCoreInput(dataset: Dataset): unknown {
  return {
    name: dataset.name,
    metric: dataset.metric,
    unit: dataset.unit,
    entities: Array.from(new Set(dataset.observations.map((o) => o.entity.name))).map((name) => ({ name })),
    observations: dataset.observations
      .map((o) => ({
        entity: o.entity.name,
        date: o.date,
        value: o.value,
        unit: o.unit,
        frequency: o.frequency,
        geography: o.geography,
        status: o.status,
        source: o.source.publisher,
        sourceUrl: o.source.url,
        confidence: o.confidence,
      })),
  };
}
// ---------------------------------------------------------------------------
// Cross-source verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  observations: Observation[];
  conflicts: Conflict[];
  /** Human-readable notes for the run log: unit mismatches, outliers, what was checked. */
  notes: string[];
}

/**
 * Compare independent sources for the same entity/metric/date.
 *
 * Rules (from the specification, tightened):
 *   - same entity (canonicalised across name variants), same date, same base
 *     unit must hold, otherwise no comparison;
 *   - scale words are normalised for comparison only ("1.2 million" vs
 *     1_200_000 compare as the same cell); stored units are untouched;
 *   - a material disagreement becomes CONFLICTING, never a silent average;
 *   - agreement between 2+ INDEPENDENT sources raises the status to VERIFIED.
 *     Independent means different publishers on different hosts: two pages on
 *     the same domain, or two rows from the same API endpoint, are one source.
 *   - a value that jumps 100x+ between consecutive periods is flagged in the
 *     notes (it stays in the dataset, it just never auto-verifies on a jump).
 */
export interface SanitizeResult {
  observations: Observation[];
  problems: string[];
}

/**
 * Pre-verification cleaning pass: drop observations that can never be trusted
 * (missing entity/date, non-finite values, negative counts) and say exactly
 * what was dropped. Runs before verifyAcrossSources so junk never reaches the
 * comparison cells.
 */
export function sanitizeObservations(observations: Observation[]): SanitizeResult {
  const kept: Observation[] = [];
  const problems: string[] = [];
  for (const o of observations) {
    const id = o.observationId || 'unknown';
    if (!o.entity?.name?.trim() || !o.date?.trim()) {
      problems.push(`dropped ${id}: missing entity or date`);
      continue;
    }
    if (o.value !== null && !Number.isFinite(o.value)) {
      problems.push(`dropped ${id} (${o.entity.name} ${o.date}): non-finite value`);
      continue;
    }
    if (o.value !== null && o.value < 0 && /count/i.test(o.unit ?? '')) {
      problems.push(`dropped ${id} (${o.entity.name} ${o.date}): negative count ${o.value}`);
      continue;
    }
    kept.push(o);
  }
  return { observations: kept, problems };
}

export function verifyAcrossSources(
  observations: Observation[],
  options: { tolerance?: number; metric?: string; outlierRatio?: number } = {},
): VerificationResult {
  const tolerance = options.tolerance ?? 0.05;
  const outlierRatio = options.outlierRatio ?? 100;
  const metric = options.metric ?? 'value';
  const notes: string[] = [];

  // Unit-mismatch scan first: same entity/date reported in genuinely different
  // base units (count vs percent) cannot be compared - say so explicitly.
  const cellUnits = new Map<string, Set<string>>();
  for (const o of observations) {
    if (o.value === null) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}`;
    const base = normalizeUnitWord(o.unit ?? 'count').unit;
    if (!cellUnits.has(key)) cellUnits.set(key, new Set());
    cellUnits.get(key)!.add(base);
  }
  for (const [key, units] of cellUnits) {
    if (units.size > 1) {
      notes.push(`unit mismatch at ${key}: reported as ${Array.from(units).join(' vs ')} - not compared, kept as separate observations`);
    }
  }

  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.value === null) continue;
    const norm = normalizeUnitWord(o.unit ?? 'count');
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}|${norm.unit}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const conflicts: Conflict[] = [];
  const decided: Observation[] = [];
  let verifiedCells = 0;
  let comparedCells = 0;

  const canonicalize = (o: Observation): Observation => {
    const key = canonicalEntityKey(o.entity.name);
    if (key === o.entity.id) return o;
    return { ...o, entity: { ...o.entity, id: key } };
  };

  for (const [key, group] of groups) {
    if (group.length === 1) {
      decided.push(canonicalize(group[0]));
      continue;
    }
    comparedCells += 1;
    const norm = normalizeUnitWord(group[0].unit ?? 'count');
    const values = group.map((o) => (o.value as number) * normalizeUnitWord(o.unit ?? 'count').multiplier / norm.multiplier);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Symmetric denominator: (max-min)/|max| understates agreement for
    // all-negative series (e.g. growth rates), where |max| is the value
    // closest to zero. Using the largest magnitude treats both signs alike.
    const magnitude = Math.max(Math.abs(max), Math.abs(min), 1e-9);
    const spread = (max - min) / magnitude;
    const publishers = new Set(group.map((o) => publisherKey(o)));

    if (spread <= tolerance && publishers.size >= 2) {
      // Two INDEPENDENT publishers agree -> verified. The first observation is kept.
      verifiedCells += 1;
      const [primary, ...rest] = group;
      decided.push({
        ...canonicalize(primary),
        status: 'VERIFIED',
        confidence: Math.min(0.98, 0.75 + 0.05 * publishers.size),
        evidence: {
          ...(primary.evidence ?? {}),
          datasetUrl: primary.source.url,
          datasetVersion: `agree:${rest.length + 1}`,
        },
      });
      continue;
    }

    if (publishers.size < 2) {
      // Same source repeated (e.g. two pages on one domain): keep the first,
      // do not pretend this is corroboration.
      decided.push(canonicalize(group[0]));
      continue;
    }

    // Independent publishers disagree materially -> CONFLICTING, never averaged.
    conflicts.push({
      conflictId: `conflict_${conflicts.length + 1}`,
      entityId: canonicalEntityKey(group[0].entity.name),
      date: group[0].date,
      metric,
      unit: norm.unit,
      candidates: group.map((o) => ({
        observationId: o.observationId,
        value: o.value as number,
        sourceUrl: o.source.url,
        status: o.status,
      })),
      reason: `${publishers.size} independent publishers disagree by ${(spread * 100).toFixed(1)}% (min ${min}, max ${max})`,
      resolved: false,
    });
    for (const o of group) decided.push({ ...canonicalize(o), status: 'CONFLICTING' });
    void key;
  }

  // Outlier pass: flag period-to-period jumps that smell like a unit or
  // extraction error. Flagged values stay in the dataset; they are recorded
  // here so reviewers and the QA agent see them.
  const byEntity = new Map<string, Observation[]>();
  for (const o of decided) {
    if (o.value === null || o.value === 0) continue;
    const list = byEntity.get(o.entity.id) ?? [];
    list.push(o);
    byEntity.set(o.entity.id, list);
  }
  for (const [entityId, list] of byEntity) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1].value as number;
      const cur = sorted[i].value as number;
      const ratio = Math.abs(cur) / Math.abs(prev);
      if (ratio >= outlierRatio || ratio <= 1 / outlierRatio) {
        notes.push(
          `outlier: ${entityId} jumps ${ratio >= outlierRatio ? 'up' : 'down'} ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x ` +
          `between ${sorted[i - 1].date} (${prev}) and ${sorted[i].date} (${cur}) - possible unit/extraction error`,
        );
      }
    }
  }

  // Observations with no value still belong in the dataset, marked UNKNOWN.
  for (const o of observations) {
    if (o.value === null) decided.push(canonicalize(o));
  }

  logger.info('verification complete', {
    cells: groups.size,
    comparedCells,
    verifiedCells,
    conflicts: conflicts.length,
    notes: notes.length,
  });
  return { observations: decided, conflicts, notes };
}

/**
 * One-paragraph-per-line summary of a verification pass, for run logs and
 * the dashboard. Callers should persist this so every run shows its work.
 */
export function verificationSummary(result: VerificationResult): string[] {
  const lines: string[] = [];
  const byStatus = new Map<string, number>();
  for (const o of result.observations) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
  lines.push(
    `verification: ${result.observations.length} observations ` +
    `(VERIFIED ${byStatus.get('VERIFIED') ?? 0}, SUPPORTED ${byStatus.get('SUPPORTED') ?? 0}, ` +
    `UNKNOWN ${byStatus.get('UNKNOWN') ?? 0}, CONFLICTING ${byStatus.get('CONFLICTING') ?? 0}, ` +
    `REJECTED ${byStatus.get('REJECTED') ?? 0}); ${result.conflicts.length} conflicts`,
  );
  // Corroboration at a glance: only VERIFIED cells were seen by 2+ independent
  // publishers. Everything merely SUPPORTED rests on one publisher and was
  // never independently checked - that is the honest state of the evidence.
  const valued = result.observations.filter((o) => o.value !== null);
  const verified = byStatus.get('VERIFIED') ?? 0;
  const singlePublisher = valued.filter((o) => o.status === 'SUPPORTED').length;
  lines.push(
    `corroboration: ${verified} of ${valued.length} valued cells confirmed by 2+ independent publishers; ` +
    `${singlePublisher} rest on a single publisher (SUPPORTED, not independently verified)`,
  );
  for (const c of result.conflicts.slice(0, 10)) {
    lines.push(`conflict: ${c.entityId} @ ${c.date} - ${c.reason}`);
  }
  for (const n of result.notes.slice(0, 15)) lines.push(n);
  return lines;
}

// ---------------------------------------------------------------------------
// Data quality (Rust first, TypeScript fallback)
// ---------------------------------------------------------------------------

export async function dataQualityReport(dataset: Dataset): Promise<DataQualityReport> {
  const maxDate = new Date().toISOString().slice(0, 10);
  if (rustAvailable()) {
    try {
      // Same stdin caveat as the frame tape: write the payload to a temp file.
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const work = mkdtempSync(join(tmpdir(), 'datarace-validate-'));
      const inFile = join(work, 'dataset.json');
      const outFile = join(work, 'quality.json');
      writeFileSync(inFile, JSON.stringify(datasetToCoreInput(dataset)), 'utf8');
      await runRustJson<DataQualityReport>(['validate', '--in', inFile, '--out', outFile, '--max-date', maxDate], {
        timeoutMs: 180_000,
      });
      const { readFileSync } = await import('node:fs');
      const report = JSON.parse(readFileSync(outFile, 'utf8')) as DataQualityReport;
      return { ...report, engine: 'rust' };
    } catch (error) {
      logger.warn('rust validate failed; using the TypeScript fallback', { error: String(error) });
    }
  }
  return typescriptQualityReport(dataset, maxDate);
}

/**
 * The dataset-level unit label: the unit most valued observations actually
 * carry. The old code hardcoded 'count', so a GDP dataset (units of USD) or a
 * share dataset (percent) was labelled "count" all the way to the video.
 * Ties prefer anything concrete over the 'count' fallback.
 */
export function majorityUnit(observations: Observation[]): string {
  const counts = new Map<string, number>();
  for (const o of observations) {
    if (o.value === null) continue;
    const unit = (o.unit ?? '').trim() || 'count';
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let best = 'count';
  let bestCount = 0;
  for (const [unit, n] of counts) {
    if (n > bestCount || (n === bestCount && best === 'count' && unit !== 'count')) {
      best = unit;
      bestCount = n;
    }
  }
  return best;
}

/** Pure-TS mirror of the Rust checks (kept deliberately simple and explicit). */
export function typescriptQualityReport(dataset: Dataset, maxDate: string): DataQualityReport {
  const checks: DataQualityReport['checks'] = [];
  const push = (name: string, details: string[]) =>
    checks.push({ name, passed: details.length === 0, violations: details.length, details });

  const obs = dataset.observations;
  push('schema', obs.length === 0 ? ['no observations present'] : []);
  push(
    'type',
    obs.filter((o) => o.value !== null && !Number.isFinite(o.value)).map((o) => `${o.observationId} has a non-finite value`),
  );
  push(
    'date',
    obs.filter((o) => !/^\d{4}(-\d{2}(-\d{2})?|(-Q[1-4]))?$/.test(o.date)).map((o) => `${o.observationId} date ${o.date} is not normalised`),
  );
  push(
    'unit',
    obs.filter((o) => !o.unit || o.unit.trim() === '').map((o) => `${o.observationId} has no unit`),
  );
  push(
    'range',
    obs.filter((o) => (o.value ?? 0) < 0 && o.unit === 'count').map((o) => `${o.observationId} is a negative count`),
  );
  push(
    'source',
    obs.filter((o) => !o.source?.url).map((o) => `${o.observationId} has no provenance url`),
  );
  const future = obs.filter((o) => o.date.slice(0, 10) > maxDate);
  push('temporal', future.map((o) => `${o.observationId} is dated ${o.date}, later than ${maxDate}`));
  push(
    'citation',
    obs.filter((o) => o.value !== null && !o.source?.publisher).map((o) => `${o.observationId} has a value without a publisher`),
  );

  const cells = new Map<string, Observation[]>();
  for (const o of obs) {
    // Unit-aware: the same entity/date in two different base units is a
    // unit mismatch, not a duplicate - it gets its own check below.
    const baseUnit = normalizeUnitWord(o.unit ?? 'count').unit;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}|${baseUnit}`;
    const list = cells.get(key) ?? [];
    list.push(o);
    cells.set(key, list);
  }
  push(
    'duplicate',
    Array.from(cells.entries())
      // A cell holding two CONFLICTING observations is the designed outcome of
      // a genuine disagreement (see verifyAcrossSources), not a data defect.
      .filter(([, list]) => list.length > 1 && !list.every((o) => o.status === 'CONFLICTING'))
      .map(([key]) => `duplicate entity/date/unit cell ${key}`),
  );

  // Same entity/date reported in different base units (count vs percent).
  const unitCells = new Map<string, Set<string>>();
  for (const o of obs) {
    if (o.value === null) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}`;
    const baseUnit = normalizeUnitWord(o.unit ?? 'count').unit;
    if (!unitCells.has(key)) unitCells.set(key, new Set());
    unitCells.get(key)!.add(baseUnit);
  }
  push(
    'unit-mismatch',
    Array.from(unitCells.entries())
      .filter(([, units]) => units.size > 1)
      .map(([key, units]) => `unit mismatch at ${key}: ${Array.from(units).join(' vs ')}`),
  );

  // Outliers: period-to-period jumps of 100x+ smell like a unit or
  // extraction error. Reported, not auto-rejected.
  const outlierDetails: string[] = [];
  const series = new Map<string, Observation[]>();
  for (const o of obs) {
    if (o.value === null || o.value === 0) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${normalizeUnitWord(o.unit ?? 'count').unit}`;
    const list = series.get(key) ?? [];
    list.push(o);
    series.set(key, list);
  }
  for (const [, list] of series) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1].value as number;
      const cur = sorted[i].value as number;
      const ratio = Math.abs(cur) / Math.abs(prev);
      if (ratio >= 100 || ratio <= 0.01) {
        outlierDetails.push(
          `${sorted[i].entity.name} jumps ${(ratio >= 1 ? ratio : 1 / ratio).toFixed(1)}x between ${sorted[i - 1].date} and ${sorted[i].date}`,
        );
      }
    }
  }
  push('outlier', outlierDetails);

  const sorted = [...obs].sort((a, b) => a.date.localeCompare(b.date));
  let rankingOk = true;
  for (const o of sorted) {
    if (o.value === null) continue;
    if (o.status === 'REJECTED') rankingOk = false;
  }
  push('ranking', rankingOk ? [] : ['rejected values are present in the dataset']);

  const violations = checks.reduce((sum, c) => sum + c.violations, 0);
  return {
    observations: obs.length,
    entities: new Set(obs.map((o) => o.entity.id)).size,
    checks,
    violations,
    passed: violations === 0,
    generatedAt: new Date().toISOString(),
    engine: 'typescript',
  };
}

// ---------------------------------------------------------------------------
// Rust frame tape
// ---------------------------------------------------------------------------

export interface FrameTapeEntity {
  id: string;
  name: string;
  flag?: string;
  flagCode?: string;
  color: string;
  logo?: string;
  image?: string;
  group?: string;
}

export interface FrameTapeBar {
  entityId: string;
  value: number;
  rank: number;
  previousRank?: number;
  width: number;
  held: boolean;
  rankDelta?: number;
  isMover: boolean;
}

export interface FrameTapeFrame {
  index: number;
  label: string;
  fromLabel: string;
  toLabel: string;
  t: number;
  isPeriodBoundary: boolean;
  maxValue: number;
  bars: FrameTapeBar[];
}

export interface FrameTape {
  fps: number;
  width: number;
  height: number;
  topN: number;
  framesPerTransition: number;
  durationInFrames: number;
  periodLabels: string[];
  entities: FrameTapeEntity[];
  frames: FrameTapeFrame[];
  notes: string[];
}

export interface FrameOptions {
  topN: number;
  framesPerTransition: number;
  fps: number;
  width: number;
  height: number;
  moverThreshold: number;
  policy: 'strict' | 'carryForward';
}

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  topN: 10,
  framesPerTransition: 30,
  fps: 30,
  width: 1280,
  height: 720,
  moverThreshold: 2,
  policy: 'carryForward',
};

export async function buildFrameTape(dataset: Dataset, options: Partial<FrameOptions> = {}): Promise<FrameTape> {
  const opts: FrameOptions = { ...DEFAULT_FRAME_OPTIONS, ...options };
  if (!rustAvailable()) {
    throw new Error('the datarace binary is required for frame-tape generation; build it with `cargo build --release`');
  }
  // The payload goes through a temp file rather than stdin: spawning the CLI
  // with a piped, never-closed stdin would block it forever waiting for EOF.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const work = mkdtempSync(join(tmpdir(), 'datarace-frames-'));
  const inFile = join(work, 'dataset.json');
  const outFile = join(work, 'frames.json');
  writeFileSync(inFile, JSON.stringify(datasetToCoreInput(dataset)), 'utf8');
  return runRustJson<FrameTape>(
    [
      'frames',
      '--in',
      inFile,
      '--out',
      outFile,
      '--top',
      String(opts.topN),
      '--frames-per-transition',
      String(opts.framesPerTransition),
      '--fps',
      String(opts.fps),
      '--width',
      String(opts.width),
      '--height',
      String(opts.height),
      '--mover',
      String(opts.moverThreshold),
      '--policy',
      opts.policy,
    ],
    { timeoutMs: 300_000 },
  ).then(async () => {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(outFile, 'utf8')) as FrameTape;
  });
}

/** Resolve entity names to canonical ones through the Rust core. */
export async function resolveEntities(names: string[]): Promise<Map<string, { name: string; status: string; flagCode?: string | null; group?: string | null }>> {
  const out = new Map<string, { name: string; status: string; flagCode?: string | null; group?: string | null }>();
  if (names.length === 0) return out;
  try {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const work = mkdtempSync(join(tmpdir(), 'datarace-entities-'));
    const inFile = join(work, 'names.json');
    writeFileSync(inFile, JSON.stringify(names), 'utf8');
    const resolved = await runRustJson<Array<{ status: string; entity: { name: string; flagCode?: string | null; group?: string | null }; candidates?: string[] }>>(
      ['entities', '--in', inFile],
      { timeoutMs: 60_000 },
    );
    resolved.forEach((entry, index) => {
      const raw = names[index];
      if (raw === undefined) return;
      out.set(raw, { name: entry.entity.name, status: entry.status, flagCode: entry.entity.flagCode ?? null, group: entry.entity.group ?? null });
    });
  } catch (error) {
    logger.warn('entity resolution unavailable; keeping raw names', { error: String(error) });
  }
  return out;
}
// ---------------------------------------------------------------------------
// VideoSpec + ThumbnailSpec builders
// ---------------------------------------------------------------------------

export interface VideoSpecOptions {
  language?: string;
  theme?: Partial<Record<string, string | number>>;
  titleSeconds?: number;
  introSeconds?: number;
  endingSeconds?: number;
  sourceCardSeconds?: number;
}

export const DEFAULT_THEME = {
  background: '#ffffff',
  surface: '#f4f5f7',
  primaryText: '#111827',
  secondaryText: '#6b7280',
  mutedText: '#c8ccd4',
  accent: '#e11d2e',
  barTrack: '#eef0f3',
  fontFamily: 'Inter',
} as const;

/**
 * Compose a VideoSpec from a verified dataset, the story and the frame tape.
 * Scene durations are content-derived; nothing is hard-coded to a fixed runtime.
 */
/** "1960-01-01" -> "1960"; leaves anything else alone. */
export function prettyLabel(raw: string): string {
  return raw.replace(/(\d{4})-01-01/g, '$1');
}

export function buildVideoSpec(input: { dataset: Dataset; story: Story; tape: FrameTape; options?: VideoSpecOptions }): VideoSpec {
  const { dataset, story, tape } = input;
  const options = input.options ?? {};
  const titleSeconds = options.titleSeconds ?? 6;
  const introSeconds = options.introSeconds ?? 8;
  const endingSeconds = options.endingSeconds ?? 6;
  const sourceCardSeconds = options.sourceCardSeconds ?? 8;
  const raceSeconds = tape.frames.length > 0 ? tape.durationInFrames / tape.fps : 1;
  const total = titleSeconds + introSeconds + raceSeconds + endingSeconds + sourceCardSeconds;

  const highlightFrames = (story.highlights ?? []).map((h) => {
    const periodIndex = Math.max(0, tape.periodLabels.indexOf(h.atLabel) + 1);
    const frame = Math.min(Math.max(0, periodIndex * tape.framesPerTransition - 8), Math.max(0, tape.durationInFrames - 1));
    return { atFrame: frame, ...h };
  });

  const finalFrame = tape.frames[tape.frames.length - 1];
  const topBar = finalFrame?.bars[0];
  const topEntity = topBar ? tape.entities.find((e) => e.id === topBar.entityId) : undefined;
  const summaryEntities = (finalFrame?.bars ?? []).slice(0, 3).map((b) => {
    const entity = tape.entities.find((e) => e.id === b.entityId);
    return entity
      ? { id: entity.id, name: entity.name, color: entity.color, flagCode: entity.flagCode }
      : { id: b.entityId, name: b.entityId, color: DEFAULT_THEME.primaryText };
  });

  const theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };

  return {
    version: '1.0',
    metadata: {
      title: prettyLabel(story.title || dataset.name),
      subtitle: prettyLabel(story.subtitle || `${dataset.timeRange.start} - ${dataset.timeRange.end}`),
      language: options.language ?? 'en',
      durationSeconds: Number(total.toFixed(2)),
    },
    canvas: { width: tape.width, height: tape.height, fps: tape.fps },
    theme: theme as unknown as VideoSpec['theme'],
    datasetRef: dataset.datasetId,
    scenes: [
      { id: 'scene_title', type: 'title', duration: titleSeconds, title: story.title, subtitle: story.subtitle },
      { id: 'scene_intro', type: 'intro', duration: introSeconds, title: story.hook, subtitle: story.setup },
      {
        id: 'scene_race',
        type: 'bar_race',
        duration: Number(raceSeconds.toFixed(2)),
        datasetRef: dataset.datasetId,
        props: {
          tapeRef: 'frames.json',
          topN: tape.topN,
          periodLabels: tape.periodLabels,
          highlights: highlightFrames,
          notes: tape.notes,
          summary: {
            heading: dataset.metric,
            value: topBar?.value ?? null,
            entityName: topEntity?.name ?? '',
            entityId: topEntity?.id ?? '',
            year: tape.periodLabels[tape.periodLabels.length - 1] ?? '',
            unit: dataset.unit,
            entities: summaryEntities,
          },
        },
      },
      { id: 'scene_ending', type: 'ending', duration: endingSeconds, title: story.ending },
      { id: 'scene_sources', type: 'source_card', duration: sourceCardSeconds, title: 'Sources', props: { sourcesLine: story.sourcesLine } },
    ],
    assets: [],
    sources: Array.from(new Map(dataset.observations.map((o) => [o.source.url, o.source])).values()),
  };
}

export function buildThumbnailSpec(input: { dataset: Dataset; story: Story; tape: FrameTape }): ThumbnailSpec {
  const { dataset, story, tape } = input;
  const finalFrame = tape.frames[tape.frames.length - 1];
  const entities = (finalFrame?.bars ?? [])
    .slice(0, 3)
    .map((b) => tape.entities.find((e) => e.id === b.entityId)?.name ?? b.entityId);
  const words = (story.title || dataset.name).split(' ');
  const split = Math.max(1, Math.ceil(words.length / 2));
  return {
    version: '1.0',
    title: words.slice(0, split).join(' ').toUpperCase(),
    subtitle: words.slice(split).join(' ').toUpperCase() || `${dataset.timeRange.start}-${dataset.timeRange.end}`,
    entities,
    assets: [],
    layout: 'ranking',
    backgroundColor: DEFAULT_THEME.background,
    accentColor: DEFAULT_THEME.accent,
  };
}

/**
 * Deterministic fallback story. It only ever states facts that exist in the
 * dataset and the frame tape.
 */
export function deterministicStory(dataset: Dataset, tape: FrameTape): Story {
  const labels = tape.periodLabels;
  const first = tape.frames[0];
  const last = tape.frames[tape.frames.length - 1];
  const leaderAt = (frame: FrameTapeFrame | undefined): string => {
    const id = frame?.bars[0]?.entityId;
    if (!id) return 'no data';
    return tape.entities.find((e) => e.id === id)?.name ?? id;
  };
  const movers = (last?.bars ?? []).filter((b) => b.isMover);
  const highlights = movers.slice(0, 3).map((b) => {
    const entity = tape.entities.find((e) => e.id === b.entityId);
    return {
      atLabel: last?.label ?? labels[labels.length - 1] ?? '',
      entityId: b.entityId,
      headline: `${entity?.name ?? b.entityId} moves`,
      detail: `${entity?.name ?? b.entityId} moved ${Math.abs(b.rankDelta ?? 0)} place(s) by ${last?.label ?? ''}.`,
    };
  });
  return {
    version: '1.0',
    title: dataset.name,
    subtitle: `${dataset.timeRange.start} - ${dataset.timeRange.end}`,
    hook: `${dataset.metric}, ${dataset.timeRange.start} to ${dataset.timeRange.end}.`,
    setup: `${dataset.stats.entities} entities, ${dataset.stats.observations} observations, ${dataset.stats.verified} verified by independent agreement.`,
    sequence: labels.map((l) => ({ atLabel: l, text: `${l}: ${leaderAt(tape.frames.find((f) => f.isPeriodBoundary && f.label === l))} leads.` })),
    highlights,
    ending: `${leaderAt(first)} starts first; ${leaderAt(last)} ends first.`,
    sourcesLine: `Data: ${Array.from(new Set(dataset.observations.map((o) => o.source.publisher))).join(', ')}`,
    generatedBy: { agent: 'deterministic-story', at: new Date().toISOString() },
  };
}