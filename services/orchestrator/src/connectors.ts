/**
 * Dataset connectors.
 *
 * Each connector is a thin, honest adapter over a public endpoint:
 *   - failures are surfaced, never swallowed;
 *   - provenance (endpoint, params, retrieval timestamp) is recorded;
 *   - a discovery index is never treated as the data provider.
 *
 * Connectors are functions rather than classes so new sources can be added
 * without touching the pipeline.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, logger } from './runtime';
import { directFetch, hostOf, type SearchProvider } from './providers/search';
import type { SourceCandidate, SourceDefinition } from '@avm/shared';

function nowIso(): string {
  return new Date().toISOString();
}

function candidateId(prefix: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${prefix}_${slug}`;
}

// ---------------------------------------------------------------------------
// HTTP helper with retry/backoff
// ---------------------------------------------------------------------------

export async function getText(
  url: string,
  options: { retries?: number; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ text: string; status: number; contentType?: string }> {
  const retries = options.retries ?? 2;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
      const result = await directFetch(url, { headers: options.headers, signal: controller.signal });
      if (timer) clearTimeout(timer);
      if (result.status === 429 || result.status >= 500) {
        lastError = new Error(`HTTP ${result.status} for ${url}`);
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      return { text: result.text ?? '', status: result.status, contentType: result.contentType };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function getJson<T>(
  url: string,
  options: { retries?: number; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const { text } = await getText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Source registry (specification priority order)
// ---------------------------------------------------------------------------

export const SOURCE_REGISTRY: SourceDefinition[] = [
  { name: 'Our World in Data', type: 'dataset', url: 'https://ourworldindata.org/', domains: ['demographics', 'health', 'energy', 'environment', 'economics', 'technology'], categories: ['global', 'long-timeseries'], accessMethod: 'download', priority: 1, requiresAuth: false, license: 'CC BY 4.0 (per chart; check metadata)', notes: 'Append .csv to a Grapher URL; .metadata.json returns units/timespan/citation.' },
  { name: 'World Bank Open Data', type: 'api', url: 'https://data.worldbank.org/', domains: ['economics', 'population', 'trade', 'energy', 'infrastructure'], categories: ['country', 'annual'], accessMethod: 'api', priority: 1, requiresAuth: false, license: 'CC BY 4.0', notes: 'api.worldbank.org/v2/country/{codes}/indicator/{indicator}?format=json' },
  { name: 'Data Commons', type: 'api', url: 'https://datacommons.org/', domains: ['statistics', 'demographics', 'economics'], categories: ['place', 'cross-source'], accessMethod: 'api', priority: 1, requiresAuth: false, license: 'Apache-2.0 (API); data per upstream source', notes: 'Records underlying provenance where available.' },
  { name: 'UNdata', type: 'api', url: 'https://data.un.org/', domains: ['population', 'migration', 'agriculture', 'education', 'health', 'trade', 'energy'], categories: ['country'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'UN terms of use', notes: 'Single entry point to the UN statistical system.' },
  { name: 'OECD', type: 'api', url: 'https://www.oecd.org/en/data.html', domains: ['economics', 'labour', 'education', 'productivity', 'industry'], categories: ['country'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'OECD terms', notes: 'SDMX-based REST API.' },
  { name: 'Eurostat', type: 'api', url: 'https://ec.europa.eu/eurostat/', domains: ['eu', 'population', 'economy', 'transport', 'energy', 'labour'], categories: ['country', 'region'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'Eurostat reuse policy', notes: 'statistics/1.0/data/{dataset}?format=JSON' },
  { name: 'Data.gov', type: 'api', url: 'https://data.gov/', domains: ['us-government', 'transport', 'aviation', 'environment', 'health'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 3, requiresAuth: false, license: 'US public domain (varies)', notes: 'CKAN package_search.' },
  { name: 'Kaggle Datasets', type: 'dataset', url: 'https://www.kaggle.com/datasets', domains: ['general', 'historical', 'community'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 6, requiresAuth: true, license: 'per dataset', notes: 'Requires KAGGLE_USERNAME + KAGGLE_KEY. Inspect licence/date/columns before use.' },
  { name: 'Hugging Face Datasets', type: 'dataset', url: 'https://huggingface.co/datasets', domains: ['ai', 'ml', 'text', 'vision', 'technical'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 7, requiresAuth: false, license: 'per dataset', notes: 'Not an authority for general-world statistics.' },
  { name: 'AWS Open Data Registry', type: 'dataset', url: 'https://registry.opendata.aws/', domains: ['climate', 'satellite', 'geospatial', 'scientific'], categories: ['dataset-catalogue'], accessMethod: 'web', priority: 7, requiresAuth: false, license: 'per dataset', notes: 'Inspect licensing and access instructions.' },
  { name: 'Google Dataset Search', type: 'search', url: 'https://datasetsearch.research.google.com/', domains: ['discovery'], categories: ['discovery'], accessMethod: 'web', priority: 0, requiresAuth: false, license: 'n/a (discovery only)', notes: 'Discovery only: always follow through to the real dataset owner.' },
  { name: 'Data Races', type: 'directory', url: 'https://data-races.com/en/', domains: ['inspiration', 'format'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'see site', notes: 'Inspiration and format reference only. Do not reproduce their content.' },
  { name: 'Visualization Datasets', type: 'directory', url: 'https://visdatasets.github.io/', domains: ['visualization'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'per dataset', notes: 'Discovery layer.' },
  { name: 'Feed Me Data', type: 'directory', url: 'https://feedmedata.ai/datasets', domains: ['discovery'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'n/a (directory)', notes: 'Discovery layer, follow through to the owner.' },
];

export function definitionFor(name: string): SourceDefinition | undefined {
  return SOURCE_REGISTRY.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
// ---------------------------------------------------------------------------
// Our World in Data
// ---------------------------------------------------------------------------

export interface OwidResult {
  candidate: SourceCandidate;
  csv: string;
  metadata: unknown;
  columns: string[];
  rows: string[][];
}

/** Fetch a Grapher chart as CSV plus its metadata sidecar. */
export async function owidFetch(slug: string, options: { baseUrl?: string } = {}): Promise<OwidResult> {
  const base = (options.baseUrl ?? 'https://ourworldindata.org').replace(/\/$/, '');
  const csvUrl = `${base}/grapher/${slug}.csv`;
  const metaUrl = `${base}/grapher/${slug}.metadata.json`;
  const csvResponse = await getText(csvUrl, { timeoutMs: 60_000 });
  if (csvResponse.status !== 200) throw new Error(`OWID grapher ${slug} returned ${csvResponse.status}`);
  let metadata: unknown = null;
  try {
    metadata = JSON.parse((await getText(metaUrl, { timeoutMs: 30_000 })).text);
  } catch (error) {
    logger.warn('OWID metadata unavailable', { slug, error: String(error) });
  }
  const table = parseCsv(csvResponse.text);
  const definition = definitionFor('Our World in Data');
  return {
    candidate: {
      candidateId: candidateId('owid', slug),
      sourceName: 'Our World in Data',
      publisher: 'Our World in Data',
      url: csvUrl,
      kind: 'dataset',
      accessMethod: 'download',
      title: slug,
      description: 'Our World in Data grapher export (CSV) with metadata sidecar',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'CC BY 4.0',
      machineReadable: true,
      authority: 0.85,
      directness: 0.8,
      coverage: 0.9,
      methodologyTransparency: 0.85,
      recency: 0.85,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'owid-connector',
      notes: metadata ? ['metadata sidecar retrieved'] : ['metadata sidecar unavailable'],
    },
    csv: csvResponse.text,
    metadata,
    columns: table.columns,
    rows: table.rows,
  };
}

// ---------------------------------------------------------------------------
// World Bank
// ---------------------------------------------------------------------------

export interface WorldBankRow {
  countryIso3: string;
  countryName: string;
  indicatorId: string;
  date: string;
  value: number | null;
}

export async function worldBankFetch(
  indicator: string,
  countries: string[] | 'all' = 'all',
  options: { start?: number; end?: number; baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; rows: WorldBankRow[]; indicatorName: string }> {
  const base = (options.baseUrl ?? 'https://api.worldbank.org/v2').replace(/\/$/, '');
  const codes = countries === 'all' ? 'all' : countries.join(';');
  const start = options.start ?? 1960;
  const end = options.end ?? new Date().getFullYear();
  const url = `${base}/country/${codes}/indicator/${indicator}?format=json&per_page=20000&date=${start}:${end}`;
  // World Bank caps a page well below 20000 for wide queries, so every page
  // is followed. Reading only page 1 silently dropped most countries.
  const rows: WorldBankRow[] = [];
  let page = 1;
  let pages = 1;
  do {
    const pageUrl = `${url}&page=${page}`;
    const payload = await getJson<unknown[]>(pageUrl, { timeoutMs: 90_000 });
    if (!Array.isArray(payload) || payload.length < 2) {
      throw new Error(`World Bank returned an unexpected payload for ${indicator} (page ${page})`);
    }
    const meta = payload[0] as { total?: number; page?: number; pages?: number };
    pages = meta.pages ?? 1;
    for (const item of (payload[1] as Array<Record<string, unknown>>) ?? []) {
      const country = (item.country ?? {}) as { id?: string; value?: string };
      const indicatorNode = (item.indicator ?? {}) as { id?: string; value?: string };
      rows.push({
        countryIso3: String(country.id ?? ''),
        countryName: String(country.value ?? ''),
        indicatorId: String(indicatorNode.id ?? indicator),
        date: String(item.date ?? ''),
        value: typeof item.value === 'number' ? item.value : null,
      });
    }
    page += 1;
  } while (page <= pages);
  if (pages > 1) {
    logger.info('World Bank pagination followed', { indicator, pages, rows: rows.length });
  }
  const definition = definitionFor('World Bank Open Data');
  return {
    candidate: {
      candidateId: candidateId('wb', `${indicator}-${codes === 'all' ? 'all' : codes}`),
      sourceName: 'World Bank Open Data',
      publisher: 'World Bank',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: indicator,
      description: 'World Bank indicator series',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'CC BY 4.0',
      machineReadable: true,
      authority: 0.95,
      directness: 0.95,
      coverage: 0.85,
      methodologyTransparency: 0.8,
      recency: 0.9,
      consistency: 0.9,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'worldbank-connector',
      notes: [`endpoint params: indicator=${indicator}, date=${start}:${end}`, `rows=${rows.length}`],
    },
    rows,
    indicatorName: indicator,
  };
}
// ---------------------------------------------------------------------------
// Data Commons
// ---------------------------------------------------------------------------

export async function dataCommonsObservation(
  entityDcids: string[],
  variableDcids: string[],
  options: { date?: string; baseUrl?: string; apiKey?: string } = {},
): Promise<{ candidate: SourceCandidate; byVariable: unknown }> {
  const base = (options.baseUrl ?? 'https://api.datacommons.org/v2').replace(/\/$/, '');
  const params = new URLSearchParams();
  for (const e of entityDcids) params.append('entity.dcids', e);
  for (const v of variableDcids) params.append('variable.dcids', v);
  if (options.date) params.set('date', options.date);
  const key = options.apiKey ?? env('DATA_COMMONS_API_KEY');
  if (key) params.set('key', key);
  const url = `${base}/observation?${params.toString()}`;
  const payload = await getJson<Record<string, unknown>>(url, { timeoutMs: 60_000 });
  const definition = definitionFor('Data Commons');
  return {
    candidate: {
      candidateId: candidateId('dc', `${entityDcids.join('-')}_${variableDcids.join('-')}`),
      sourceName: 'Data Commons',
      publisher: 'Google Data Commons',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: variableDcids.join(', '),
      retrievedAt: nowIso(),
      license: definition?.license ?? 'Apache-2.0',
      machineReadable: true,
      authority: 0.8,
      directness: 0.75,
      coverage: 0.85,
      methodologyTransparency: 0.7,
      recency: 0.85,
      consistency: 0.75,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'datacommons-connector',
      notes: ['aggregates upstream sources; underlying provenance is recorded when present'],
    },
    byVariable: payload.byVariable ?? payload,
  };
}

// ---------------------------------------------------------------------------
// Kaggle
// ---------------------------------------------------------------------------

/**
 * Kaggle credentials, sent with a non-browser user agent.
 *
 * Verified 2026-09-21: kaggle.com answers a browser User-Agent with an HTML
 * reCAPTCHA challenge page (HTTP 200, so it looks like success), while a plain
 * client UA returns the documented JSON. This is why the UA is pinned here
 * instead of inheriting the browser default.
 */
function kaggleAuthHeader(): Record<string, string> {
  const user = env('KAGGLE_USERNAME');
  const key = env('KAGGLE_KEY');
  if (!user || !key) throw new Error('KAGGLE_USERNAME / KAGGLE_KEY are not configured');
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`,
    'User-Agent': 'analysis-video-maker/0.1 (kaggle-api client)',
    Accept: 'application/json',
  };
}

export interface KaggleDataset {
  ref: string;
  title: string;
  subtitle?: string;
  totalBytes?: number;
  lastUpdated?: string;
  downloadCount?: number;
  voteCount?: number;
  usabilityRating?: number;
  licenseName?: string;
  description?: string;
}

export async function kaggleSearch(
  query: string,
  options: { limit?: number; baseUrl?: string } = {},
): Promise<KaggleDataset[]> {
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const url = `${base}/datasets/list?search=${encodeURIComponent(query)}&page=1`;
  const payload = await getJson<unknown[]>(url, { headers: kaggleAuthHeader(), timeoutMs: 60_000 });
  if (!Array.isArray(payload)) return [];
  return payload.slice(0, options.limit ?? 10).map((raw) => {
    const d = raw as Record<string, unknown>;
    const ref = String(d.ref ?? '');
    return {
      ref,
      title: String(d.title ?? ref),
      subtitle: typeof d.subtitle === 'string' ? d.subtitle : undefined,
      totalBytes: typeof d.totalBytes === 'number' ? d.totalBytes : undefined,
      lastUpdated: typeof d.lastUpdated === 'string' ? d.lastUpdated : undefined,
      downloadCount: typeof d.downloadCount === 'number' ? d.downloadCount : undefined,
      voteCount: typeof d.voteCount === 'number' ? d.voteCount : undefined,
      usabilityRating: typeof d.usabilityRating === 'number' ? d.usabilityRating : undefined,
      licenseName: typeof d.licenseName === 'string' ? d.licenseName : undefined,
      description: typeof d.description === 'string' ? d.description : undefined,
    };
  });
}

export function kaggleCandidates(datasets: KaggleDataset[]): SourceCandidate[] {
  return datasets.map((d) => ({
    candidateId: candidateId('kaggle', d.ref),
    sourceName: 'Kaggle Datasets',
    publisher: `Kaggle: ${d.ref.split('/')[0] ?? 'unknown'}`,
    url: `https://www.kaggle.com/datasets/${d.ref}`,
    kind: 'dataset',
    accessMethod: 'download',
    title: d.title,
    description: d.subtitle ?? d.description?.slice(0, 300),
    publishedAt: d.lastUpdated,
    retrievedAt: nowIso(),
    license: d.licenseName ?? 'UNKNOWN',
    machineReadable: true,
    authority: 0.55,
    directness: 0.5,
    coverage: 0.6,
    methodologyTransparency: 0.4,
    recency: d.lastUpdated && Date.parse(d.lastUpdated) > Date.now() - 3.15e10 ? 0.7 : 0.4,
    consistency: 0.4,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'kaggle-connector',
    notes: ['community dataset: verify licence, update date, columns and provenance before use'],
  }));
}

export async function kaggleDownload(
  ref: string,
  outDir: string,
  options: { baseUrl?: string } = {},
): Promise<{ file: string; bytes: number }> {
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/datasets/download/${ref}`, { headers: kaggleAuthHeader() });
  if (!response.ok) throw new Error(`Kaggle download failed for ${ref}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${ref.replace(/[^a-z0-9]+/gi, '_')}.zip`);
  writeFileSync(file, buffer);
  return { file, bytes: buffer.byteLength };
}
// ---------------------------------------------------------------------------
// CKAN (data.gov and friends)
// ---------------------------------------------------------------------------

export interface CkanResource {
  name: string;
  url: string;
  format: string;
  datasetTitle: string;
  datasetName: string;
  license?: string;
  lastModified?: string;
}

export async function ckanSearch(
  query: string,
  options: { baseUrl?: string; rows?: number } = {},
): Promise<CkanResource[]> {
  // `catalog.data.gov/api/3/action/package_search` began returning 404
  // (checked 2026-09-21), so several catalogue bases are tried in order and the
  // failure is reported rather than silently returning an empty list.
  const bases = options.baseUrl
    ? [options.baseUrl]
    : ['https://catalog.data.gov/api/3', 'https://data.gov/api/3', 'https://api.data.gov/api/3'];
  let payload: { result?: { results?: Array<Record<string, unknown>> } } | null = null;
  const attempted: string[] = [];
  for (const base of bases) {
    const url = `${base.replace(/\/$/, '')}/action/package_search?q=${encodeURIComponent(query)}&rows=${options.rows ?? 10}`;
    attempted.push(url);
    try {
      payload = await getJson<{ result?: { results?: Array<Record<string, unknown>> } }>(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 60_000,
        retries: 0,
      });
      break;
    } catch {
      // try the next catalogue base
    }
  }
  if (!payload) {
    throw new Error(
      `CKAN package_search unavailable on all ${attempted.length} candidate bases; last tried: ${attempted[attempted.length - 1]}`,
    );
  }
  const out: CkanResource[] = [];
  for (const pkg of payload.result?.results ?? []) {
    const title = String(pkg.title ?? pkg.name ?? '');
    for (const res of (pkg.resources as Array<Record<string, unknown>>) ?? []) {
      out.push({
        name: String(res.name ?? 'resource'),
        url: String(res.url ?? ''),
        format: String(res.format ?? '').toUpperCase(),
        datasetTitle: title,
        datasetName: String(pkg.name ?? ''),
        license: typeof pkg.license_title === 'string' ? pkg.license_title : undefined,
        lastModified: typeof res.last_modified === 'string' ? res.last_modified : undefined,
      });
    }
  }
  return out;
}
export function ckanCandidates(resources: CkanResource[], sourceName = 'Data.gov'): SourceCandidate[] {
  const definition = definitionFor(sourceName);
  return resources
    .filter((r) => r.url.startsWith('http'))
    .map((r) => ({
      candidateId: candidateId('ckan', `${r.datasetName}-${r.name}`),
      sourceName,
      publisher: hostOf(r.url) || sourceName,
      url: r.url,
      kind: 'dataset' as const,
      accessMethod: (r.format === 'CSV' || r.format === 'JSON' ? 'download' : 'web') as SourceCandidate['accessMethod'],
      title: `${r.datasetTitle} - ${r.name}`,
      retrievedAt: nowIso(),
      license: r.license ?? definition?.license ?? 'UNKNOWN',
      machineReadable: r.format === 'CSV' || r.format === 'JSON' || r.format === 'XLSX',
      authority: 0.75,
      directness: 0.7,
      coverage: 0.6,
      methodologyTransparency: 0.5,
      recency: 0.5,
      consistency: 0.6,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'ckan-connector',
      notes: [`resource format: ${r.format || 'unknown'}`],
    }));
}

// ---------------------------------------------------------------------------
// Hugging Face datasets-server
// ---------------------------------------------------------------------------

export async function huggingFaceRows(
  dataset: string,
  options: { config?: string; split?: string; offset?: number; length?: number; baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; columns: string[]; rows: unknown[] }> {
  const base = (options.baseUrl ?? 'https://datasets-server.huggingface.co').replace(/\/$/, '');
  const token = env('HUGGINGFACE_TOKEN');
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const url =
    `${base}/rows?dataset=${encodeURIComponent(dataset)}` +
    `&config=${encodeURIComponent(options.config ?? 'default')}` +
    `&split=${encodeURIComponent(options.split ?? 'train')}` +
    `&offset=${options.offset ?? 0}&length=${options.length ?? 100}`;
  const payload = await getJson<{ features?: Array<{ name?: string }>; rows?: Array<{ row?: unknown }> }>(url, { headers, timeoutMs: 60_000 });
  const definition = definitionFor('Hugging Face Datasets');
  return {
    candidate: {
      candidateId: candidateId('hf', dataset),
      sourceName: 'Hugging Face Datasets',
      publisher: 'Hugging Face',
      url,
      kind: 'dataset',
      accessMethod: 'api',
      title: dataset,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'UNKNOWN',
      machineReadable: true,
      authority: 0.5,
      directness: 0.6,
      coverage: 0.5,
      methodologyTransparency: 0.35,
      recency: 0.6,
      consistency: 0.4,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'huggingface-connector',
      notes: ['inspect the dataset card: not an authority for general-world statistics'],
    },
    columns: (payload.features ?? []).map((f) => String(f.name ?? '')),
    rows: payload.rows ?? [],
  };
}

// ---------------------------------------------------------------------------
// Eurostat / OECD / UNdata (SDMX-style)
// ---------------------------------------------------------------------------

export async function eurostatData(
  datasetCode: string,
  params: Record<string, string> = {},
  options: { baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0').replace(/\/$/, '');
  const search = new URLSearchParams({ format: 'JSON', ...params });
  const url = `${base}/data/${datasetCode}?${search.toString()}`;
  const payload = await getJson<unknown>(url, { timeoutMs: 90_000 });
  const definition = definitionFor('Eurostat');
  return {
    candidate: {
      candidateId: candidateId('eurostat', datasetCode),
      sourceName: 'Eurostat',
      publisher: 'Eurostat',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: datasetCode,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'Eurostat reuse policy',
      machineReadable: true,
      authority: 0.9,
      directness: 0.9,
      coverage: 0.8,
      methodologyTransparency: 0.85,
      recency: 0.9,
      consistency: 0.9,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'eurostat-connector',
      notes: [`params: ${search.toString()}`],
    },
    payload,
  };
}

export async function oecdData(
  dataflow: string,
  key = 'all',
  options: { baseUrl?: string; startPeriod?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://sdmx.oecd.org/public/rest/v1').replace(/\/$/, '');
  const search = new URLSearchParams({ format: 'jsondata' });
  if (options.startPeriod) search.set('startPeriod', options.startPeriod);
  const url = `${base}/data/${dataflow}/${key}?${search.toString()}`;
  const payload = await getJson<unknown>(url, {
    headers: { Accept: 'application/vnd.sdmx.data+json;version=2.0.0' },
    timeoutMs: 90_000,
  });
  const definition = definitionFor('OECD');
  return {
    candidate: {
      candidateId: candidateId('oecd', dataflow),
      sourceName: 'OECD',
      publisher: 'OECD',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: dataflow,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'OECD terms',
      machineReadable: true,
      authority: 0.9,
      directness: 0.85,
      coverage: 0.8,
      methodologyTransparency: 0.8,
      recency: 0.9,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'oecd-connector',
    },
    payload,
  };
}

export async function unDataQuery(
  query: Record<string, string>,
  options: { baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://data.un.org/ws/rest').replace(/\/$/, '');
  const search = new URLSearchParams(query);
  const url = `${base}/data?${search.toString()}`;
  const payload = await getJson<unknown>(url, { timeoutMs: 90_000 });
  const definition = definitionFor('UNdata');
  return {
    candidate: {
      candidateId: candidateId('undata', search.toString()),
      sourceName: 'UNdata',
      publisher: 'United Nations Statistics Division',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: query['datasetCode'] ?? 'UNdata series',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'UN terms of use',
      machineReadable: true,
      authority: 0.9,
      directness: 0.85,
      coverage: 0.85,
      methodologyTransparency: 0.75,
      recency: 0.85,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'undata-connector',
    },
    payload,
  };
}
// ---------------------------------------------------------------------------
// AWS Open Data + discovery directories
// ---------------------------------------------------------------------------

export async function awsOpenDataSearch(query: string, options: { limit?: number } = {}): Promise<SourceCandidate[]> {
  // `https://registry.opendata.aws/index.json` returns 404 (checked 2026-09-21),
  // so the registry is read from its upstream source of truth: one YAML file per
  // dataset in awslabs/open-data-registry, exposed through the GitHub contents API.
  const listing = await getJson<Array<{ name?: string; type?: string }>>(
    'https://api.github.com/repos/awslabs/open-data-registry/contents/datasets',
    { headers: { 'User-Agent': 'analysis-video-maker', Accept: 'application/vnd.github+json' }, timeoutMs: 90_000 },
  );
  if (!Array.isArray(listing)) throw new Error('AWS Open Data registry listing was not a JSON array');
  const needle = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const hits = listing
    .filter((entry) => entry.type === 'file' && typeof entry.name === 'string')
    .map((entry) => ({ name: String(entry.name).replace(/\.yaml$/, ''), file: String(entry.name) }))
    .filter((entry) => needle.length === 0 || needle.some((word) => entry.name.replace(/-/g, ' ').includes(word)))
    .slice(0, options.limit ?? 5);
  return hits.map((entry) => ({
    candidateId: candidateId('aws', entry.name),
    sourceName: 'AWS Open Data Registry',
    publisher: 'AWS Open Data',
    url: `https://registry.opendata.aws/${entry.name}/`,
    kind: 'dataset' as const,
    accessMethod: 'web' as const,
    title: entry.name.replace(/-/g, ' '),
    description: `Registry entry ${entry.file}`,
    retrievedAt: nowIso(),
    license: 'UNKNOWN',
    machineReadable: false,
    authority: 0.7,
    directness: 0.4,
    coverage: 0.5,
    methodologyTransparency: 0.4,
    recency: 0.5,
    consistency: 0.6,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'aws-opendata-connector',
    notes: ['licence and access method must be read from the entry before use'],
  }));
}
/** Extract outbound dataset links from a discovery directory page. */
export async function directoryLinks(pageUrl: string, options: { limit?: number } = {}): Promise<Array<{ url: string; title: string }>> {
  const { text } = await getText(pageUrl, { timeoutMs: 60_000 });
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, title: title || hostOf(href) });
    if (out.length >= (options.limit ?? 60)) break;
  }
  return out;
}

/** Google Dataset Search is discovery only: the real provider is followed through. */
export async function googleDatasetSearch(
  query: string,
  search: SearchProvider,
  options: { limit?: number } = {},
): Promise<SourceCandidate[]> {
  const results = await search.search(`${query} dataset csv`, { limit: options.limit ?? 8 });
  return results.map((r) => ({
    candidateId: candidateId('gds', r.url),
    sourceName: 'Google Dataset Search',
    publisher: hostOf(r.url) || 'discovery',
    url: r.url,
    kind: 'dataset' as const,
    accessMethod: 'web' as const,
    title: r.title,
    description: r.snippet,
    retrievedAt: nowIso(),
    license: 'UNKNOWN',
    machineReadable: false,
    authority: 0.3,
    directness: 0.2,
    coverage: 0.3,
    methodologyTransparency: 0.2,
    recency: 0.4,
    consistency: 0.3,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'google-dataset-search',
    notes: ['discovery index only: follow through to the dataset owner before trusting any value'],
  }));
}

// ---------------------------------------------------------------------------
// User uploads
// ---------------------------------------------------------------------------

export interface UploadedFile {
  path: string;
  kind: 'csv' | 'xlsx' | 'json' | 'pdf' | 'image' | 'txt' | 'unknown';
  role: 'primary' | 'cross-check';
}

export function classifyUpload(path: string): UploadedFile['kind'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods')) return 'xlsx';
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'json';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return 'image';
  if (lower.endsWith('.txt')) return 'txt';
  return 'unknown';
}

export function uploadedCandidate(file: UploadedFile): SourceCandidate {
  return {
    candidateId: candidateId('upload', file.path),
    sourceName: 'User upload',
    publisher: 'user-provided',
    url: `upload:${file.path}`,
    kind: 'upload',
    accessMethod: 'manual',
    title: file.path.split(/[\\/]/).pop() ?? file.path,
    retrievedAt: nowIso(),
    license: 'user-provided',
    machineReadable: file.kind === 'csv' || file.kind === 'xlsx' || file.kind === 'json',
    authority: 1,
    directness: 1,
    coverage: 0.6,
    methodologyTransparency: file.kind === 'pdf' ? 0.4 : 0.6,
    recency: 0.8,
    consistency: 0.6,
    qualityScore: 0,
    accepts: null,
    primary: file.role === 'primary',
    discoveredBy: 'upload',
    notes: [
      file.role === 'primary'
        ? 'user instruction: use as the primary dataset'
        : 'user instruction: cross-check only; web research is primary',
      file.kind === 'pdf' || file.kind === 'image'
        ? 'PDF/image extraction is a later-phase connector (currently a documented TODO)'
        : `machine readable: ${file.kind}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// CSV helper (for connectors that return delimited text)
// ---------------------------------------------------------------------------

export function parseCsv(text: string, delimiter = ','): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = rows.shift() ?? [];
  return { columns, rows: rows.filter((r) => r.some((c) => c.trim() !== '')) };
}