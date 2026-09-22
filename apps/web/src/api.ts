/**
 * Thin API client for the orchestrator backend.
 *
 * Base URL comes from `VITE_API_BASE` (defaults to the local dev server).
 */

import type { DataQualityReport, Dataset, Story, SourceCandidate, ThumbnailSpec, VideoSpec } from '@avm/shared';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  topic: string;
  status: string;
  updatedAt: string;
}

export interface FrameTapeEntity {
  id: string;
  name: string;
  flag?: string;
  flagCode?: string;
  color: string;
  group?: string;
}

export interface FrameTapeBar {
  entityId: string;
  value: number;
  rank: number;
  width: number;
  held: boolean;
  isMover: boolean;
  rankDelta?: number;
}

export interface FrameTapeFrame {
  index: number;
  label: string;
  bars: FrameTapeBar[];
  isPeriodBoundary: boolean;
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

export interface ProjectState {
  projectId: string;
  title: string;
  topic: string;
  status: string;
  dataPlan?: Record<string, unknown>;
  sources: SourceCandidate[];
  dataset?: Dataset;
  frameTape?: FrameTape;
  story?: Story;
  videoSpec?: VideoSpec;
  thumbnail?: ThumbnailSpec;
  quality?: DataQualityReport;
  checkpoints: Array<{ checkpoint: string; at: string }>;
  revisions: Array<{ revisionId: string; instruction: string; at: string }>;
  renderJob?: { status: string; githubRunId?: number | null; artifactUrl?: string | null; notes?: string[] };
  notes: string[];
}

export const api = {
  health: () => request<{ ok: boolean; rustCore: boolean; projects: number }>('/api/health'),
  registry: () => request<{ registry: Array<Record<string, unknown>> }>('/api/sources'),
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<{ project: ProjectState }>(`/api/projects/${id}`),
  createProject: (topic: string, title?: string) =>
    request<{ project: ProjectState }>('/api/projects', { method: 'POST', body: JSON.stringify({ topic, title }) }),
  research: (id: string, body: Record<string, unknown> = {}) =>
    request<{ accepted: boolean }>(`/api/projects/${id}/research`, { method: 'POST', body: JSON.stringify(body) }),
  researchStatus: (id: string) => request<Record<string, unknown>>(`/api/projects/${id}/research/status`),
  revise: (id: string, instruction: string) =>
    request<{ plan: unknown }>(`/api/projects/${id}/revise`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  approve: (id: string) => request<{ project: ProjectState }>(`/api/projects/${id}/approve`, { method: 'POST' }),
  render: (id: string) =>
    request<{ renderJob: unknown; dispatch: { ok: boolean; message: string; workflowRunUrl?: string } }>(`/api/projects/${id}/render`, {
      method: 'POST',
    }),
  patchDataset: (id: string, body: Record<string, unknown>) =>
    request<{ dataset: Dataset }>(`/api/projects/${id}/dataset`, { method: 'PATCH', body: JSON.stringify(body) }),
  listRenders: () =>
    request<{ renders: Array<{ filename: string; title: string; sizeBytes: number; createdAt: string; url: string }> }>('/api/renders'),
};