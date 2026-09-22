/**
 * Backend API (Render-free-tier friendly: stateless, resumable, no local disk
 * assumptions beyond the project store).
 *
 * This service orchestrates research. It does NOT render video.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { env, envList, limits, logger, redact, rustAvailable } from './runtime';
import { SOURCE_REGISTRY } from './connectors';
import { ProjectStore, type ProjectState } from './project';
import { researchTopic } from './research';
import { applyRevision, planRevision, ideaFromDataset, type AgentContext } from './agents';
import { createAIClient } from './providers/ai';
import { Budget, createSearchProvider } from './providers/search';
import { newRenderJob, dispatchRender } from './dispatch';
import { buildFrameTape } from './pipeline';
import { JsonlLog } from './runtime';

const store = new ProjectStore();
const app = new Hono();

app.use('*', cors({ origin: envList('ALLOWED_ORIGINS', ['http://localhost:5173']) }));

/** In-process job registry so `/research/status` can answer while a run is live. */
const jobs = new Map<string, { status: string; startedAt: string; finishedAt?: string; error?: string; summary?: unknown }>();

function agentContext(): AgentContext {
  const lim = limits();
  const budget = new Budget(lim.maxSearches, lim.maxSearches * 4, lim.maxAgentRounds * 8);
  return {
    ai: createAIClient(),
    search: createSearchProvider(budget),
    budget,
    limits: lim,
    runLog: new JsonlLog('api-agent-runs.jsonl'),
  };
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    at: new Date().toISOString(),
    rustCore: rustAvailable(),
    projects: store.list().length,
    limits: limits(),
  }),
);

app.get('/api/sources', (c) => c.json({ registry: SOURCE_REGISTRY }));

app.post('/api/projects', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { topic?: string; title?: string };
  if (!body.topic) return c.json({ error: 'topic is required' }, 400);
  const state = store.create(body.topic, limits(), body.title);
  return c.json({ project: state }, 201);
});

app.get('/api/projects', (c) =>
  c.json({
    projects: store.list().map((id) => {
      try {
        const s = store.load(id);
        return { projectId: s.projectId, title: s.title, topic: s.topic, status: s.status, updatedAt: s.updatedAt };
      } catch {
        return { projectId: id, title: id, topic: '', status: 'FAILED', updatedAt: '' };
      }
    }),
  }),
);

app.get('/api/projects/:id', (c) => {
  try {
    return c.json({ project: store.load(c.req.param('id')) });
  } catch (error) {
    return c.json({ error: redact(String(error)) }, 404);
  }
});

app.post('/api/projects/:id/research', async (c) => {
  const id = c.req.param('id');
  let state;
  try {
    state = store.load(id);
  } catch {
    return c.json({ error: `project ${id} not found` }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  jobs.set(id, { status: 'RESEARCHING', startedAt: new Date().toISOString() });
  // Fire and forget: the client polls /research/status.
  void researchTopic({
    projectId: id,
    topic: state.topic,
    owidSlug: typeof body.owidSlug === 'string' ? body.owidSlug : undefined,
    worldBankIndicator: typeof body.worldBankIndicator === 'string' ? body.worldBankIndicator : undefined,
    topN: typeof body.topN === 'number' ? body.topN : undefined,
    framesPerTransition: typeof body.framesPerTransition === 'number' ? body.framesPerTransition : undefined,
    skipAi: body.skipAi === true,
  })
    .then((result) => {
      jobs.set(id, { status: 'READY_FOR_REVIEW', startedAt: jobs.get(id)?.startedAt ?? '', finishedAt: new Date().toISOString(), summary: result.summary });
    })
    .catch((error) => {
      logger.error('research failed', { projectId: id, error: String(error) });
      jobs.set(id, { status: 'FAILED', startedAt: jobs.get(id)?.startedAt ?? '', finishedAt: new Date().toISOString(), error: redact(String(error)) });
    });
  return c.json({ accepted: true, projectId: id });
});

app.get('/api/projects/:id/research/status', (c) => {
  const id = c.req.param('id');
  const job = jobs.get(id);
  if (job) return c.json(job);
  try {
    const state = store.load(id);
    return c.json({ status: state.status, checkpoints: state.checkpoints });
  } catch {
    return c.json({ error: `project ${id} not found` }, 404);
  }
});

app.get('/api/projects/:id/sources', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ sources: state.sources });
});

app.get('/api/projects/:id/dataset', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ dataset: state.dataset ?? null });
});

app.patch('/api/projects/:id/dataset', async (c) => {
  const state = readState(c.req.param('id'));
  if (!state || !state.dataset) return c.json({ error: 'dataset not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { allowStatuses?: string[]; topN?: number; annualOnly?: boolean };
  const updated = applyRevision(state.dataset, {
    instruction: 'manual edit',
    datasetFilters: { allowStatuses: body.allowStatuses, topN: body.topN, annualOnly: body.annualOnly },
    storyOverrides: {},
    videoOverrides: {},
    notes: ['applied by the dataset editor'],
  });
  state.dataset = updated;
  try {
    state.frameTape = await buildFrameTape(updated, { topN: state.frameTape?.topN ?? 10 });
  } catch (error) {
    logger.warn('frame tape rebuild failed after dataset edit', { error: String(error) });
  }
  const store2 = new ProjectStore();
  store2.save(state);
  return c.json({ dataset: state.dataset });
});

app.get('/api/projects/:id/frames', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ frames: state.frameTape ?? null });
});

app.get('/api/projects/:id/story', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ story: state.story ?? null });
});

app.patch('/api/projects/:id/story', async (c) => {
  const state = readState(c.req.param('id'));
  if (!state || !state.story) return c.json({ error: 'story not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; subtitle?: string; ending?: string };
  state.story = { ...state.story, ...body };
  new ProjectStore().save(state);
  return c.json({ story: state.story });
});

app.get('/api/projects/:id/video-spec', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ videoSpec: state.videoSpec ?? null, thumbnail: state.thumbnail ?? null });
});

app.get('/api/projects/:id/quality', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ quality: state.quality ?? null });
});

app.post('/api/projects/:id/revise', async (c) => {
  const state = readState(c.req.param('id'));
  if (!state || !state.dataset) return c.json({ error: 'dataset not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { instruction?: string };
  if (!body.instruction) return c.json({ error: 'instruction is required' }, 400);
  const ctx = agentContext();
  const plan = await planRevision(
    body.instruction,
    {
      entities: Array.from(new Set(state.dataset.observations.map((o) => o.entity.id))),
      statuses: ['VERIFIED', 'SUPPORTED', 'ESTIMATED', 'UNKNOWN', 'CONFLICTING', 'REJECTED'],
      topN: state.frameTape?.topN ?? 10,
    },
    ctx,
  );
  const before = state.dataset.version;
  const updated = applyRevision(state.dataset, plan);
  state.dataset = updated;
  if (plan.storyOverrides?.title) state.story = { ...(state.story as NonNullable<typeof state.story>), title: plan.storyOverrides.title };
  try {
    state.frameTape = await buildFrameTape(updated, { topN: plan.videoOverrides?.topN ?? state.frameTape?.topN ?? 10 });
  } catch (error) {
    logger.warn('frame tape rebuild failed after revision', { error: String(error) });
  }
  const store2 = new ProjectStore();
  store2.addRevision(state, {
    revisionId: `rev_${state.revisions.length + 1}`,
    at: new Date().toISOString(),
    instruction: body.instruction,
    plan,
    datasetVersionBefore: before,
    datasetVersionAfter: updated.version,
  });
  return c.json({ dataset: state.dataset, plan });
});

app.post('/api/projects/:id/approve', (c) => {
  const state = readState(c.req.param('id'));
  if (!state || !state.dataset) return c.json({ error: 'nothing to approve' }, 404);
  if (state.quality && !state.quality.passed) {
    return c.json({ error: 'data-quality gate failed', quality: state.quality }, 409);
  }
  state.dataset = { ...state.dataset, frozen: true };
  const store2 = new ProjectStore();
  store2.setStatus(state, 'APPROVED');
  store2.checkpoint(state, 'APPROVED');
  return c.json({ project: state });
});

app.post('/api/projects/:id/render', async (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  if (state.status !== 'APPROVED') return c.json({ error: 'only an APPROVED project can render' }, 409);
  if (!state.videoSpec || !state.dataset) return c.json({ error: 'video spec or dataset missing' }, 409);
  const job = newRenderJob({
    projectId: state.projectId,
    videoSpecVersion: Number(state.videoSpec.version === '1.0' ? state.dataset.version : state.dataset.version),
    datasetVersion: state.dataset.version,
  });
  const dispatch = await dispatchRender({
    projectId: state.projectId,
    videoSpecVersion: state.dataset.version,
    datasetVersion: state.dataset.version,
  });
  job.githubRunId = dispatch.runId ?? null;
  job.status = dispatch.ok ? 'running' : 'failed';
  job.notes = [dispatch.message];
  state.renderJob = job;
  const store2 = new ProjectStore();
  store2.setStatus(state, dispatch.ok ? 'RENDERING' : 'FAILED');
  return c.json({ renderJob: job, dispatch });
});

app.get('/api/projects/:id/render/status', (c) => {
  const state = readState(c.req.param('id'));
  if (!state) return c.json({ error: 'not found' }, 404);
  return c.json({ renderJob: state.renderJob ?? null, status: state.status });
});

app.post('/api/uploads', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: string; role?: 'primary' | 'cross-check' };
  if (!body.path) return c.json({ error: 'path is required' }, 400);
  const { classifyUpload, uploadedCandidate } = await import('./connectors');
  const kind = classifyUpload(body.path);
  return c.json({ upload: { path: body.path, kind, role: body.role ?? 'cross-check' }, candidate: uploadedCandidate({ path: body.path, kind, role: body.role ?? 'cross-check' }) });
});

app.get('/api/ideas', (c) => c.json({ ideas: [] }));

/** Local video renders gallery: list MP4s in the renders/ directory. */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

function rendersDir(): string {
  // server.ts lives in services/orchestrator/src; renders/ is at repo root.
  return join(__dirname, '..', '..', '..', 'renders');
}

app.get('/api/renders', (c) => {
  const dir = rendersDir();
  if (!existsSync(dir)) return c.json({ renders: [] });
  const renders = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((f) => {
      const full = join(dir, f);
      const stat = statSync(full);
      return {
        filename: f,
        title: basename(f, '.mp4').replace(/[-_]/g, ' '),
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        url: `/api/renders/file/${encodeURIComponent(f)}`,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json({ renders });
});

/** Stream a local render file (supports range requests for seeking). */
app.get('/api/renders/file/:filename', async (c) => {
  const filename = c.req.param('filename');
  // Prevent path traversal.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return c.json({ error: 'invalid filename' }, 400);
  }
  if (!filename.toLowerCase().endsWith('.mp4')) return c.json({ error: 'not a video' }, 400);
  const full = join(rendersDir(), filename);
  if (!existsSync(full)) return c.json({ error: 'not found' }, 404);
  const stat = statSync(full);
  const range = c.req.header('range');
  const { createReadStream } = await import('node:fs');
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    const clampedEnd = Math.min(end, stat.size - 1);
    const stream = createReadStream(full, { start, end: clampedEnd });
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(clampedEnd - start + 1),
        'Content-Range': `bytes ${start}-${clampedEnd}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  const stream = createReadStream(full);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
    },
  });
});

function readState(id: string): ProjectState | null {
  try {
    return store.load(id);
  } catch {
    return null;
  }
}

/** Turn a finished project into a reusable, scored video idea. */
export function ideasFromProject(id: string): unknown {
  const state = readState(id);
  if (!state?.dataset) return null;
  const meanSourceQuality =
    state.sources.length === 0
      ? 0
      : state.sources.reduce((sum, s) => sum + s.qualityScore, 0) / state.sources.length;
  return ideaFromDataset(state.dataset, meanSourceQuality);
}
const port = Number(env('PORT', '8787'));
if (process.argv[1]?.includes('server')) {
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info('orchestrator listening', { port: info.port, rustCore: rustAvailable() });
  });
}

export { app };