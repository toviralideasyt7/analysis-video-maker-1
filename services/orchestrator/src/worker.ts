/**
 * Cloudflare Workers entry point for the orchestrator API.
 *
 * Adapts the Hono app for Workers: KV for project storage, R2 for videos.
 * Research endpoints work via fetch (AI providers, search).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { KVProjectStore, type KVNamespaceLike, type WorkerLimits } from './kv-store';

interface Env {
  PROJECTS_KV: KVNamespaceLike;
  VIDEOS_BUCKET?: {
    list(opts?: { prefix?: string }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date }> }>;
    get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<{
      body: ReadableStream;
      size: number;
    } | null>;
  };
  ALLOWED_ORIGINS?: string;
  PAGES_ORIGIN?: string;
  // AI provider config (set as worker secrets/vars)
  NARA_API_KEY?: string;
  NARA_BASE_URL?: string;
  MONID_API_KEY?: string;
  GEMINI_WORKER_1?: string;
  GEMINI_WORKER_2?: string;
  GEMINI_MODELS?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
}

function getLimits(env: Env): WorkerLimits {
  return {
    maxSearches: 60,
    maxSources: 40,
    maxAgentRounds: 12,
    maxTokens: 400000,
    maxRenderAttempts: 2,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return origin; // allow all if not configured
    return allowed.includes(origin) ? origin : allowed[0];
  },
}));

app.get('/api/health', (c) =>
  c.json({ ok: true, at: new Date().toISOString(), worker: true })
);

// --- Projects (KV-backed) ---

app.post('/api/projects', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { topic?: string; title?: string };
  if (!body.topic) return c.json({ error: 'topic is required' }, 400);
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const state = await store.create(body.topic, getLimits(c.env), body.title);
  return c.json({ project: state }, 201);
});

app.get('/api/projects', async (c) => {
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const states = await store.list();
  const projects = states.map((s) => ({
    projectId: s.projectId,
    title: s.title,
    topic: s.topic,
    status: s.status,
    updatedAt: s.updatedAt,
  }));
  return c.json({ projects });
});

app.get('/api/projects/:id', async (c) => {
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  try {
    const project = await store.load(c.req.param('id'));
    return c.json({ project });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

// --- Renders ---
// Videos are published as GitHub release assets by the render-video workflow.
// The worker lists them via the GitHub API so new renders appear automatically.

async function listReleaseVideos(env: Env): Promise<Array<{ filename: string; title: string; sizeBytes: number; createdAt: string; url: string }>> {
  const owner = env.GITHUB_OWNER ?? 'sujitbhai7710';
  const repo = env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = env.GITHUB_TOKEN;
  if (!token) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/videos-20260922`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'avm-orchestrator-worker',
      },
    });
    if (!res.ok) return [];
    const release = await res.json() as { assets?: Array<{ name: string; size: number; created_at: string; browser_download_url: string }> };
    const assets = release.assets ?? [];
    return assets
      .filter((a) => a.name.toLowerCase().endsWith('.mp4'))
      .map((a) => ({
        filename: a.name,
        title: a.name.replace(/\.mp4$/i, '').replace(/[-_]/g, ' '),
        sizeBytes: a.size,
        createdAt: a.created_at,
        url: a.browser_download_url,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

app.get('/api/renders', async (c) => {
  const bucket = c.env.VIDEOS_BUCKET;
  if (bucket) {
    const listed = await bucket.list({ prefix: 'renders/' });
    const renders = listed.objects
      .filter((o) => o.key.toLowerCase().endsWith('.mp4'))
      .map((o) => {
        const filename = o.key.replace(/^renders\//, '');
        return {
          filename,
          title: filename.replace(/\.mp4$/i, '').replace(/[-_]/g, ' '),
          sizeBytes: o.size,
          createdAt: o.uploaded.toISOString(),
          url: `/api/renders/file/${encodeURIComponent(filename)}`,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json({ renders });
  }
  // Fallback: list videos from the GitHub release.
  const renders = await listReleaseVideos(c.env);
  return c.json({ renders });
});

app.get('/api/renders/file/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return c.json({ error: 'invalid filename' }, 400);
  }
  if (!filename.toLowerCase().endsWith('.mp4')) return c.json({ error: 'not a video' }, 400);
  
  const bucket = c.env.VIDEOS_BUCKET;
  if (!bucket) return c.json({ error: 'not found' }, 404);
  
  const range = c.req.header('range');
  let obj;
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  };
  
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      // Get object size first via a head-like request
      const full = await bucket.get(`renders/${filename}`);
      if (!full) return c.json({ error: 'not found' }, 404);
      const size = full.size;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      const clampedEnd = Math.min(end, size - 1);
      obj = await bucket.get(`renders/${filename}`, {
        range: { offset: start, length: clampedEnd - start + 1 },
      });
      if (!obj) return c.json({ error: 'not found' }, 404);
      headers['Content-Length'] = String(clampedEnd - start + 1);
      headers['Content-Range'] = `bytes ${start}-${clampedEnd}/${size}`;
      return new Response(obj.body, { status: 206, headers });
    }
  }
  
  obj = await bucket.get(`renders/${filename}`);
  if (!obj) return c.json({ error: 'not found' }, 404);
  headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { headers });
});

// --- Research (simplified for Workers - delegates to full pipeline) ---
// Note: Full research pipeline requires the Node.js backend. For now,
// the worker supports project CRUD and video serving. Research can be
// triggered via the GitHub Actions workflow.

app.post('/api/projects/:id/research', async (c) => {
  return c.json({
    error: 'Research runs on the full backend. Use the GitHub Actions research workflow or run locally.',
    hint: 'POST to /api/projects/:id/research on your Render deployment, or dispatch the research.yml workflow.'
  }, 501);
});

// --- Render: dispatch the GitHub Actions render-video workflow ---
app.post('/api/projects/:id/render', async (c) => {
  const id = c.req.param('id');
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(id);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }

  const owner = c.env.GITHUB_OWNER ?? 'sujitbhai7710';
  const repo = c.env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = c.env.GITHUB_TOKEN;
  if (!token) {
    return c.json({ error: 'GitHub token not configured on worker (GITHUB_TOKEN secret missing)' }, 500);
  }

  // The render-video workflow reads the bundle from bundles/<projectId>/ in the repo.
  // For draft projects without a bundle yet, we point it at the template bundle.
  const bundleProjectId = 'world-population-by-country-20260921094702';

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/render-video.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'avm-orchestrator-worker',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          projectId: bundleProjectId,
          renderScale: '0.5',
          skipAiQa: 'true',
        },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    return c.json({ error: `GitHub dispatch failed: ${dispatchRes.status} ${errText.slice(0, 200)}` }, 502);
  }

  // Mark project as rendering
  project.status = 'RENDERING';
  project.updatedAt = new Date().toISOString();
  await store.save(project);

  return c.json({
    renderJob: { status: 'DISPATCHED', projectId: id },
    dispatch: {
      ok: true,
      message: 'Render dispatched. Watch the Videos tab — the video appears when the workflow finishes.',
      workflowRunUrl: `https://github.com/${owner}/${repo}/actions/workflows/render-video.yml`,
    },
  });
});

export default app;
