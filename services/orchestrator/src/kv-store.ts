/**
 * KV-backed project store for Cloudflare Workers.
 * Self-contained: does not import node:* modules (unlike project.ts).
 */

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export interface WorkerLimits {
  maxSearches: number;
  maxSources: number;
  maxAgentRounds: number;
  maxTokens: number;
  maxRenderAttempts: number;
}

export interface WorkerProjectState {
  projectId: string;
  title: string;
  topic: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sources: unknown[];
  checkpoints: unknown[];
  revisions: unknown[];
  limits: WorkerLimits;
  notes: string[];
  [key: string]: unknown;
}

function newProjectId(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${slug || 'project'}-${stamp}`;
}

export class KVProjectStore {
  constructor(private readonly kv: KVNamespaceLike) {}

  private key(projectId: string): string {
    return `project:${projectId}`;
  }

  private indexKey(): string {
    return `project:index`;
  }

  async create(topic: string, limits: WorkerLimits, title?: string): Promise<WorkerProjectState> {
    const projectId = newProjectId(topic);
    const now = new Date().toISOString();
    const state: WorkerProjectState = {
      projectId,
      title: title ?? topic,
      topic,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      sources: [],
      checkpoints: [],
      revisions: [],
      limits,
      notes: [],
    };
    await this.save(state);
    return state;
  }

  async save(state: WorkerProjectState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await this.kv.put(this.key(state.projectId), JSON.stringify(state));
    const index = await this.listIds();
    if (!index.includes(state.projectId)) {
      index.push(state.projectId);
      await this.kv.put(this.indexKey(), JSON.stringify(index));
    }
  }

  async load(projectId: string): Promise<WorkerProjectState> {
    const raw = await this.kv.get(this.key(projectId));
    if (!raw) throw new Error(`project ${projectId} not found`);
    const state = JSON.parse(raw) as WorkerProjectState;
    state.checkpoints = state.checkpoints ?? [];
    state.notes = state.notes ?? [];
    return state;
  }

  async listIds(): Promise<string[]> {
    const raw = await this.kv.get(this.indexKey());
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async list(): Promise<WorkerProjectState[]> {
    const ids = await this.listIds();
    const states: WorkerProjectState[] = [];
    for (const id of ids) {
      try {
        states.push(await this.load(id));
      } catch {
        /* skip missing */
      }
    }
    return states.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async remove(projectId: string): Promise<void> {
    await this.kv.delete(this.key(projectId));
    const index = (await this.listIds()).filter((id) => id !== projectId);
    await this.kv.put(this.indexKey(), JSON.stringify(index));
  }
}
