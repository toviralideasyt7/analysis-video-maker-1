import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_OPTIONS,
  aliasEntityName,
  buildDataset,
  buildObservation,
  buildThumbnailSpec,
  buildVideoSpec,
  canonicalEntityKey,
  datasetStats,
  deterministicStory,
  inferFrequency,
  majorityUnit,
  parseScaledNumber,
  scoreCandidates,
  sourceQualityScore,
  typescriptQualityReport,
  verifyAcrossSources,
  verificationSummary,
  type FrameTape,
} from '../src/pipeline';
import type { Observation, SourceCandidate } from '@avm/shared';

function obs(entity: string, date: string, value: number | null, url = 'https://a.test', publisher = 'A'): Observation {
  return buildObservation({
    entity,
    date,
    value,
    unit: 'count',
    source: { url, publisher, retrievedAt: '2026-09-21T00:00:00Z' },
  });
}

function tape(): FrameTape {
  return {
    fps: 30,
    width: 1280,
    height: 720,
    topN: 10,
    framesPerTransition: 5,
    durationInFrames: 15,
    periodLabels: ['2000', '2001', '2002'],
    entities: [
      { id: 'india', name: 'India', color: '#ff8c00', flagCode: 'in' },
      { id: 'china', name: 'China', color: '#dc2626', flagCode: 'cn' },
    ],
    frames: [
      { index: 0, label: '2000', fromLabel: '2000', toLabel: '2001', t: 0, isPeriodBoundary: true, maxValue: 10, bars: [
        { entityId: 'india', value: 10, rank: 1, width: 1, held: false, isMover: false },
        { entityId: 'china', value: 5, rank: 2, width: 0.5, held: false, isMover: false },
      ] },
      { index: 1, label: '2002', fromLabel: '2001', toLabel: '2002', t: 1, isPeriodBoundary: true, maxValue: 20, bars: [
        { entityId: 'china', value: 20, rank: 1, previousRank: 2, width: 1, held: false, rankDelta: 1, isMover: true },
        { entityId: 'india', value: 14, rank: 2, previousRank: 1, width: 0.7, held: false, rankDelta: -1, isMover: true },
      ] },
    ],
    notes: [],
  };
}

describe('source scoring', () => {
  it('ranks an authoritative API above an unknown web page', () => {
    const api = sourceQualityScore({ authority: 0.95, directness: 0.95, coverage: 0.85, machineReadable: true, methodologyTransparency: 0.8, recency: 0.9, consistency: 0.9 });
    const web = sourceQualityScore({ authority: 0.3, directness: 0.25, coverage: 0.3, machineReadable: false, methodologyTransparency: 0.2, recency: 0.4, consistency: 0.3 });
    expect(api).toBeGreaterThan(web);
    expect(api).toBeLessThanOrEqual(1);
    expect(web).toBeGreaterThanOrEqual(0);
  });

  it('sorts candidates by score without mutating the input', () => {
    const low = { qualityScore: 0, authority: 0.1, directness: 0.1, coverage: 0.1, machineReadable: false, methodologyTransparency: 0.1, recency: 0.1, consistency: 0.1 } as unknown as SourceCandidate;
    const high = { qualityScore: 0, authority: 1, directness: 1, coverage: 1, machineReadable: true, methodologyTransparency: 1, recency: 1, consistency: 1 } as unknown as SourceCandidate;
    const result = scoreCandidates([low, high]);
    // scoreCandidates returns copies, so the input objects are never mutated.
    expect(result[0].authority).toBe(1);
    expect(result[0].qualityScore).toBeGreaterThan(result[1].qualityScore);
    expect(low.qualityScore).toBe(0);
    expect(high.qualityScore).toBe(0);
  });
});

describe('observations', () => {
  it('never invents a value: null becomes UNKNOWN', () => {
    const o = obs('India', '2020', null);
    expect(o.value).toBeNull();
    expect(o.status).toBe('UNKNOWN');
  });

  it('infers frequency from the date shape', () => {
    expect(inferFrequency('2020')).toBe('annual');
    expect(inferFrequency('2020-05')).toBe('monthly');
    expect(inferFrequency('2020-05-03')).toBe('daily');
    expect(inferFrequency('2020-Q2')).toBe('quarterly');
  });

  it('counts statuses', () => {
    const stats = datasetStats([obs('A', '2000', 1), obs('A', '2001', null), { ...obs('B', '2000', 2), status: 'ESTIMATED' }]);
    expect(stats.observations).toBe(3);
    expect(stats.unknown).toBe(1);
    expect(stats.estimated).toBe(1);
    expect(stats.entities).toBe(2);
  });
});

describe('cross-source verification', () => {
  it('raises independent agreement to VERIFIED', () => {
    const result = verifyAcrossSources([obs('India', '2000', 100, 'https://a.test', 'A'), obs('India', '2000', 101, 'https://b.test', 'B')]);
    expect(result.conflicts).toHaveLength(0);
    const value = result.observations.find((o) => o.value !== null);
    expect(value?.status).toBe('VERIFIED');
  });

  it('flags a material disagreement as CONFLICTING instead of averaging', () => {
    const result = verifyAcrossSources([obs('India', '2000', 100, 'https://a.test', 'A'), obs('India', '2000', 140, 'https://b.test', 'B')]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].candidates).toHaveLength(2);
    const conflicting = result.observations.filter((o) => o.status === 'CONFLICTING');
    expect(conflicting).toHaveLength(2);
    const average = result.observations.find((o) => o.value === 120);
    expect(average).toBeUndefined();
  });

  it('does not call two pages on the same publisher independent corroboration', () => {
    const result = verifyAcrossSources([
      obs('India', '2000', 100, 'https://a.test/page1', 'A'),
      obs('India', '2000', 100, 'https://a.test/page2', 'A'),
    ]);
    const value = result.observations.find((o) => o.value !== null);
    expect(value?.status).not.toBe('VERIFIED');
    expect(result.conflicts).toHaveLength(0);
  });

  it('compares values across scale words and name variants', () => {
    const a = obs('USA', '2000', 1.2, 'https://a.test', 'A');
    const b = { ...obs('United States of America', '2000', 1_200_000, 'https://b.test', 'B'), unit: 'count' };
    const am = { ...a, value: 1.2, unit: 'million' };
    const result = verifyAcrossSources([am, b]);
    const value = result.observations.find((o) => o.value !== null);
    expect(value?.status).toBe('VERIFIED');
    expect(value?.entity.id).toBe('united-states');
  });

  it('flags unit mismatches instead of silently comparing them', () => {
    const a = obs('India', '2000', 100, 'https://a.test', 'A');
    const b = { ...obs('India', '2000', 10, 'https://b.test', 'B'), unit: 'percent' };
    const result = verifyAcrossSources([a, b]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.notes.some((n) => n.includes('unit mismatch'))).toBe(true);
  });

  it('flags 100x period-to-period jumps as possible extraction errors', () => {
    const result = verifyAcrossSources([obs('India', '2000', 100), obs('India', '2001', 50000)]);
    expect(result.notes.some((n) => n.includes('outlier'))).toBe(true);
    expect(result.observations).toHaveLength(2);
  });

  it('summarises the verification pass for the run log', () => {
    const result = verifyAcrossSources([obs('India', '2000', 100, 'https://a.test', 'A'), obs('India', '2000', 101, 'https://b.test', 'B')]);
    const lines = verificationSummary(result);
    expect(lines[0]).toContain('VERIFIED 1');
  });

  it('states corroboration honestly: only VERIFIED cells had 2+ publishers', () => {
    const result = verifyAcrossSources([
      obs('India', '2000', 100, 'https://a.test', 'A'),
      obs('India', '2000', 101, 'https://b.test', 'B'),
      obs('China', '2000', 200, 'https://a.test', 'A'),
    ]);
    const lines = verificationSummary(result);
    const corroboration = lines.find((l) => l.startsWith('corroboration:'));
    expect(corroboration).toContain('1 of 2 valued cells confirmed by 2+ independent publishers');
    expect(corroboration).toContain('1 rest on a single publisher');
  });

  it('compares all-negative series symmetrically instead of understating agreement', () => {
    // |max| is the value closest to zero here; the old (max-min)/|max| formula
    // called this a 5.2% disagreement, the symmetric one a 4.9% agreement.
    const result = verifyAcrossSources([
      obs('India', '2000', -100, 'https://a.test', 'A'),
      obs('India', '2000', -105.2, 'https://b.test', 'B'),
    ]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.observations.find((o) => o.value !== null)?.status).toBe('VERIFIED');
  });

  it('treats a zero-valued cell as agreement, not a division-by-zero', () => {
    const result = verifyAcrossSources([
      obs('India', '2000', 0, 'https://a.test', 'A'),
      obs('India', '2000', 0, 'https://b.test', 'B'),
    ]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.observations.find((o) => o.value !== null)?.status).toBe('VERIFIED');
  });
});

describe('dataset unit', () => {
  it('takes the majority unit of the valued observations, not a hardcoded count', () => {
    const observations = [
      { ...obs('India', '2000', 100), unit: 'USD' },
      { ...obs('China', '2000', 200), unit: 'USD' },
      { ...obs('India', '2001', 110), unit: 'count' },
    ];
    expect(majorityUnit(observations)).toBe('USD');
  });

  it('prefers a concrete unit over the count fallback on ties', () => {
    const observations = [
      { ...obs('India', '2000', 100), unit: 'percent' },
      { ...obs('China', '2000', 200), unit: 'count' },
    ];
    expect(majorityUnit(observations)).toBe('percent');
  });

  it('ignores null values and falls back to count when there is nothing', () => {
    expect(majorityUnit([obs('India', '2000', null)])).toBe('count');
    expect(majorityUnit([])).toBe('count');
  });
});

describe('verification helpers', () => {
  it('canonicalises common country name variants', () => {
    expect(canonicalEntityKey('USA')).toBe(canonicalEntityKey('United States of America'));
    expect(canonicalEntityKey('UK')).toBe(canonicalEntityKey('United Kingdom'));
    expect(aliasEntityName('  u.s.a. ')).toBe('United States');
  });

  it('parses scaled numbers without silently dividing values', () => {
    expect(parseScaledNumber('1.2M').value).toBe(1_200_000);
    expect(parseScaledNumber('$45.2bn').value).toBe(45_200_000_000);
    expect(parseScaledNumber('12.5k').value).toBe(12_500);
    expect(parseScaledNumber('1 234').value).toBe(1234);
    const pct = parseScaledNumber('37%');
    expect(pct.value).toBe(37);
    expect(pct.unitHint).toBe('percent');
    expect(parseScaledNumber('n/a').value).toBeNull();
    expect(parseScaledNumber('').value).toBeNull();
  });
});

describe('data quality', () => {
  it('reports zero violations for a clean dataset', () => {
    const dataset = buildDataset({
      projectId: 'p', datasetId: 'd', name: 'x', metric: 'm', unit: 'count',
      timeRange: { start: '2000', end: '2001' }, frequency: 'annual', missingDataPolicy: 'STRICT',
      observations: [obs('India', '2000-01-01', 1), obs('India', '2001-01-01', 2)], conflicts: [],
    });
    const report = typescriptQualityReport(dataset, '2026-09-21');
    expect(report.violations).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('flags a value without provenance', () => {
    const bare = { ...obs('India', '2000-01-01', 1) };
    bare.source = { url: '', publisher: '', retrievedAt: '' };
    const dataset = buildDataset({
      projectId: 'p', datasetId: 'd', name: 'x', metric: 'm', unit: 'count',
      timeRange: { start: '2000', end: '2001' }, frequency: 'annual', missingDataPolicy: 'STRICT',
      observations: [bare], conflicts: [],
    });
    const report = typescriptQualityReport(dataset, '2026-09-21');
    expect(report.violations).toBeGreaterThan(0);
  });

  it('does not treat a CONFLICTING cell as a duplicate', () => {
    // Two observations for the same cell is the designed outcome of a genuine
    // disagreement (verifyAcrossSources), not a data defect: the quality gate
    // must not fail on it.
    const result = verifyAcrossSources([
      obs('India', '2000', 100, 'https://a.test', 'A'),
      obs('India', '2000', 140, 'https://b.test', 'B'),
    ]);
    expect(result.conflicts).toHaveLength(1);
    const dataset = buildDataset({
      projectId: 'p', datasetId: 'd', name: 'x', metric: 'm', unit: 'count',
      timeRange: { start: '2000', end: '2000' }, frequency: 'annual', missingDataPolicy: 'STRICT',
      observations: result.observations, conflicts: result.conflicts,
    });
    const report = typescriptQualityReport(dataset, '2026-09-21');
    const duplicate = report.checks.find((c) => c.name === 'duplicate');
    expect(duplicate?.violations).toBe(0);
    expect(report.violations).toBe(0);
    expect(report.passed).toBe(true);
  });
});

describe('video spec', () => {
  it('derives durations from content and matches the declared total', () => {
    const dataset = buildDataset({
      projectId: 'p', datasetId: 'd1', name: 'India vs China', metric: 'population', unit: 'count',
      timeRange: { start: '2000', end: '2002' }, frequency: 'annual', missingDataPolicy: 'STRICT',
      observations: [obs('India', '2000-01-01', 10), obs('China', '2000-01-01', 5)], conflicts: [],
    });
    const t = tape();
    const story = deterministicStory(dataset, t);
    const spec = buildVideoSpec({ dataset, story, tape: t });
    const summed = spec.scenes.reduce((sum, s) => sum + s.duration, 0);
    expect(Math.abs(summed - spec.metadata.durationSeconds)).toBeLessThan(0.05);
    expect(spec.scenes.map((s) => s.type)).toEqual(['title', 'intro', 'bar_race', 'ending', 'source_card']);
    expect(spec.canvas.width).toBe(1280);
    expect(spec.metadata.language).toBe('en');
  });

  it('builds a thumbnail from the final ranking', () => {
    const dataset = buildDataset({
      projectId: 'p', datasetId: 'd1', name: 'Most Popular Cell Phone Brands', metric: 'share', unit: 'percent',
      timeRange: { start: '2000', end: '2002' }, frequency: 'annual', missingDataPolicy: 'STRICT',
      observations: [obs('India', '2000-01-01', 10)], conflicts: [],
    });
    const t = tape();
    const thumb = buildThumbnailSpec({ dataset, story: deterministicStory(dataset, t), tape: t });
    expect(thumb.title.length).toBeGreaterThan(0);
    expect(thumb.entities.length).toBeGreaterThan(0);
    expect(thumb.layout).toBe('ranking');
  });

  it('exposes sane default frame options', () => {
    expect(DEFAULT_FRAME_OPTIONS.width).toBe(1280);
    expect(DEFAULT_FRAME_OPTIONS.fps).toBe(30);
    expect(DEFAULT_FRAME_OPTIONS.policy).toBe('carryForward');
  });
});