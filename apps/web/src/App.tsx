import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProjectState, type ProjectSummary } from './api';
import {
  DataPlanView,
  DatasetView,
  Overview,
  QualityView,
  RacePreview,
  SourcesView,
  StoryView,
  VideoSpecView,
} from './views';

type View = 'dashboard' | 'videos' | 'projects' | 'new';
type ProjectTab = 'Overview' | 'Data Plan' | 'Sources' | 'Dataset' | 'Preview' | 'Story' | 'Video Spec' | 'Quality' | 'Render';

const PROJECT_TABS: ProjectTab[] = ['Overview', 'Data Plan', 'Sources', 'Dataset', 'Preview', 'Story', 'Video Spec', 'Quality', 'Render'];

interface RenderItem {
  filename: string;
  title: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

function statusBadge(status: string): string {
  const s = status.toUpperCase();
  if (['READY_FOR_REVIEW', 'APPROVED', 'COMPLETED', 'DONE'].includes(s)) return 'badge-green';
  if (['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(s)) return 'badge-blue';
  if (['FAILED', 'ERROR'].includes(s)) return 'badge-red';
  if (['DRAFT', 'PENDING'].includes(s)) return 'badge-gray';
  return 'badge-amber';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function VideoPlayerModal({ video, onClose }: { video: RenderItem; onClose: () => void }): React.ReactElement {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-extrabold text-white capitalize">{video.title}</h2>
            <button onClick={onClose} className="btn-secondary !px-3 !py-1.5">✕</button>
          </div>
          <video
            src={`${base}${video.url}`}
            controls
            autoPlay
            className="w-full rounded-xl bg-black"
            style={{ maxHeight: '60vh' }}
          />
          <div className="flex items-center gap-4 mt-4 text-sm text-muted">
            <span>{formatBytes(video.sizeBytes)}</span>
            <span>·</span>
            <span>{formatDate(video.createdAt)}</span>
            <a
              href={`${base}${video.url}`}
              download={video.filename}
              className="btn-secondary !py-1.5 !px-3 !text-xs ml-auto"
              onClick={(e) => e.stopPropagation()}
            >
              ⬇ Download
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function VideosGallery(): React.ReactElement {
  const [videos, setVideos] = useState<RenderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RenderItem | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listRenders();
        setVideos(res.renders);
      } catch {
        setVideos([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(
    () => videos.filter((v) => v.title.toLowerCase().includes(search.toLowerCase())),
    [videos, search],
  );

  if (loading) {
    return <div className="card p-10 text-center text-muted">Loading videos…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Video Library</h1>
          <p className="text-sm text-muted mt-1">{videos.length} rendered video{videos.length === 1 ? '' : 's'}</p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search videos…"
          className="input !w-64 ml-auto"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🎬</div>
          <div className="text-lg font-bold text-white">No videos yet</div>
          <p className="text-sm text-muted mt-2">
            {videos.length === 0
              ? 'Render a video from a project to see it here.'
              : 'No videos match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((v) => (
            <div key={v.filename} className="card-hover overflow-hidden" onClick={() => setSelected(v)}>
              <div className="video-thumb">
                <video src={`${(import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787'}${v.url}#t=2`} preload="metadata" muted />
                <div className="play-overlay">
                  <div className="w-14 h-14 rounded-full bg-accent flex items-center justify-center shadow-lg">
                    <span className="text-white text-xl ml-1">▶</span>
                  </div>
                </div>
              </div>
              <div className="p-4">
                <div className="font-bold text-white capitalize truncate">{v.title}</div>
                <div className="flex items-center gap-2 mt-2 text-xs text-muted">
                  <span>{formatBytes(v.sizeBytes)}</span>
                  <span>·</span>
                  <span>{formatDate(v.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected ? <VideoPlayerModal video={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function Dashboard({ projects, onSelectProject, onNavigate }: {
  projects: ProjectSummary[];
  onSelectProject: (id: string) => void;
  onNavigate: (v: View) => void;
}): React.ReactElement {
  const [videos, setVideos] = useState<RenderItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listRenders();
        setVideos(res.renders);
      } catch {
        setVideos([]);
      }
    })();
  }, []);

  const activeProjects = projects.filter((p) =>
    ['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(p.status.toUpperCase()),
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white">Dashboard</h1>
        <p className="text-sm text-muted mt-1">Your video research studio at a glance</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card">
          <div className="stat-value">{projects.length}</div>
          <div className="stat-label">Projects</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{videos.length}</div>
          <div className="stat-label">Videos Rendered</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{activeProjects}</div>
          <div className="stat-label">In Progress</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {videos.reduce((sum, v) => sum + v.sizeBytes, 0) > 0
              ? formatBytes(videos.reduce((sum, v) => sum + v.sizeBytes, 0))
              : '0 B'}
          </div>
          <div className="stat-label">Video Storage</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-white">Recent Projects</h2>
            <button onClick={() => onNavigate('projects')} className="text-xs text-accent font-semibold hover:underline">
              View all →
            </button>
          </div>
          <div className="space-y-2">
            {projects.slice(0, 5).map((p) => (
              <div
                key={p.projectId}
                onClick={() => onSelectProject(p.projectId)}
                className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white truncate">{p.title}</div>
                  <div className="text-xs text-muted">{formatDate(p.updatedAt)}</div>
                </div>
                <span className={statusBadge(p.status)}>{p.status}</span>
              </div>
            ))}
            {projects.length === 0 ? <div className="text-sm text-muted text-center py-6">No projects yet. Create one to get started.</div> : null}
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-white">Latest Videos</h2>
            <button onClick={() => onNavigate('videos')} className="text-xs text-accent font-semibold hover:underline">
              View all →
            </button>
          </div>
          <div className="space-y-2">
            {videos.slice(0, 5).map((v) => (
              <div
                key={v.filename}
                onClick={() => onNavigate('videos')}
                className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition"
              >
                <div className="w-10 h-10 rounded-lg bg-accent/15 flex items-center justify-center text-accent">▶</div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white capitalize truncate">{v.title}</div>
                  <div className="text-xs text-muted">{formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}</div>
                </div>
              </div>
            ))}
            {videos.length === 0 ? <div className="text-sm text-muted text-center py-6">No videos rendered yet.</div> : null}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="font-bold text-white mb-3">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <button onClick={() => onNavigate('new')} className="btn-primary">+ New Project</button>
          <button onClick={() => onNavigate('videos')} className="btn-secondary">🎬 Browse Videos</button>
          <button onClick={() => onNavigate('projects')} className="btn-secondary">📁 All Projects</button>
        </div>
      </div>
    </div>
  );
}

function ProjectsList({ projects, onSelect, selectedId }: {
  projects: ProjectSummary[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}): React.ReactElement {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const statuses = useMemo(() => ['all', ...Array.from(new Set(projects.map((p) => p.status)))], [projects]);

  const filtered = useMemo(
    () =>
      projects.filter((p) => {
        const matchesSearch = p.title.toLowerCase().includes(search.toLowerCase()) || p.topic.toLowerCase().includes(search.toLowerCase());
        const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [projects, search, statusFilter],
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold text-white">Projects</h1>
        <p className="text-sm text-muted mt-1">{filtered.length} of {projects.length} projects</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects…"
          className="input !w-64"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input !w-auto">
          {statuses.map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">📁</div>
          <div className="text-lg font-bold text-white">No projects found</div>
          <p className="text-sm text-muted mt-2">Try a different search or create a new project.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <div
              key={p.projectId}
              onClick={() => onSelect(p.projectId)}
              className={`card-hover p-5 ${selectedId === p.projectId ? '!border-accent/40' : ''}`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className={statusBadge(p.status)}>{p.status}</span>
                <span className="text-xs text-muted">{formatDate(p.updatedAt)}</span>
              </div>
              <div className="font-bold text-white truncate">{p.title}</div>
              <div className="text-xs text-muted mt-1 line-clamp-2">{p.topic}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App(): React.ReactElement {
  const [health, setHealth] = useState<{ ok: boolean; rustCore: boolean } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [topic, setTopic] = useState('World Population by Country 1960-2024');
  const [indicator, setIndicator] = useState('SP.POP.TOTL');
  const [tab, setTab] = useState<ProjectTab>('Overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('Keep only the top 10 and drop unverified values.');
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const result = await api.listProjects();
      setProjects(result.projects);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const loadProject = useCallback(async (id: string) => {
    try {
      const result = await api.getProject(id);
      setProject(result.project);
      setView('projects');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const h = await api.health();
        setHealth(h);
      } catch {
        setHealth({ ok: false, rustCore: false });
      }
      await refreshProjects();
    })();
  }, [refreshProjects]);

  useEffect(() => {
    if (!project) return;
    if (!['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(project.status)) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await api.getProject(project.projectId);
          setProject(result.project);
        } catch { /* ignore */ }
      })();
    }, 2500);
    return () => clearInterval(timer);
  }, [project]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const navItems: Array<{ id: View; label: string; icon: string }> = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'videos', label: 'Videos', icon: '🎬' },
    { id: 'projects', label: 'Projects', icon: '📁' },
    { id: 'new', label: 'New Project', icon: '➕' },
  ];

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-white/5 bg-[#0d0d13] p-4 flex flex-col gap-1 sticky top-0 h-screen">
        <div className="flex items-center gap-3 px-2 py-4 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-end justify-center gap-[3px] pb-[9px]" style={{ background: 'linear-gradient(135deg, #e11d2e 0%, #8f0f1c 100%)', boxShadow: '0 4px 16px rgba(225,29,46,0.4)' }}>
            <span className="w-[3px] h-3 bg-white rounded" />
            <span className="w-[3px] h-5 bg-white rounded" />
            <span className="w-[3px] h-4 bg-white rounded" />
          </div>
          <div>
            <div className="font-extrabold text-white text-sm leading-tight">Video Maker</div>
            <div className="text-[11px] text-muted">research studio</div>
          </div>
        </div>

        {navItems.map((item) => (
          <div
            key={item.id}
            onClick={() => setView(item.id)}
            className={`nav-item ${view === item.id || (item.id === 'projects' && project && view === 'projects') ? 'nav-item-active' : ''}`}
          >
            <span className="text-lg">{item.icon}</span>
            {item.label}
          </div>
        ))}

        <div className="mt-auto px-2 py-3 space-y-2">
          <div className={`text-xs font-semibold px-2 py-1.5 rounded-lg ${health?.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            ● backend {health?.ok ? 'online' : 'offline'}
          </div>
          <div className={`text-xs font-semibold px-2 py-1.5 rounded-lg ${health?.rustCore ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
            ● rust core {health?.rustCore ? 'ready' : 'missing'}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 p-6 lg:p-8 max-w-[1400px]">
        {error ? (
          <div className="card p-4 mb-6 border-l-4 !border-l-accent text-sm text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-muted hover:text-white">✕</button>
          </div>
        ) : null}

        {view === 'dashboard' ? (
          <Dashboard projects={projects} onSelectProject={loadProject} onNavigate={setView} />
        ) : null}

        {view === 'videos' ? <VideosGallery /> : null}

        {view === 'projects' && !project ? (
          <ProjectsList projects={projects} onSelect={loadProject} selectedId={null} />
        ) : null}

        {view === 'new' ? (
          <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-extrabold text-white mb-1">New Project</h1>
            <p className="text-sm text-muted mb-6">Describe what you want to visualize. The AI will research, verify, and build it.</p>
            <div className="card p-6 space-y-4">
              <div>
                <label className="text-sm font-semibold text-white mb-2 block">Topic</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  rows={3}
                  placeholder="e.g. World Population by Country 1960-2024"
                  className="input"
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-white mb-2 block">World Bank Indicator <span className="text-muted font-normal">(optional)</span></label>
                <input
                  value={indicator}
                  onChange={(e) => setIndicator(e.target.value)}
                  placeholder="e.g. SP.POP.TOTL"
                  className="input"
                />
              </div>
              <button
                disabled={busy !== null}
                onClick={() =>
                  void run('create+research', async () => {
                    const created = await api.createProject(topic);
                    await api.research(created.project.projectId, { worldBankIndicator: indicator || undefined });
                    setProject(created.project);
                    setView('projects');
                    await refreshProjects();
                  })
                }
                className="btn-primary w-full !py-3"
              >
                {busy === 'create+research' ? 'Starting research…' : '🔍 Start Research'}
              </button>
              <p className="text-xs text-muted leading-relaxed">
                The backend plans a measurable metric, discovers sources, extracts observations with provenance,
                verifies them across independent publishers, and builds the VideoSpec. Rendering happens on GitHub
                Actions after you approve — or locally via CLI for instant previews.
              </p>
            </div>
          </div>
        ) : null}

        {view === 'projects' && project ? (
          <div className="space-y-5">
            <button onClick={() => setProject(null)} className="text-sm text-muted hover:text-white transition">
              ← Back to projects
            </button>

            <div className="card p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-extrabold text-white truncate">{project.title}</div>
                  <div className="text-xs text-muted mt-1 flex items-center gap-2">
                    <span className="font-mono">{project.projectId.slice(0, 8)}…</span>
                    <span className={statusBadge(project.status)}>{project.status}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    disabled={busy !== null}
                    onClick={() =>
                      void run('research', async () => {
                        await api.research(project.projectId, { worldBankIndicator: indicator || undefined });
                        await loadProject(project.projectId);
                      })
                    }
                    className="btn-secondary !py-2"
                  >
                    🔄 Re-run
                  </button>
                  <button
                    disabled={busy !== null || project.status !== 'READY_FOR_REVIEW'}
                    onClick={() =>
                      void run('approve', async () => {
                        await api.approve(project.projectId);
                        await loadProject(project.projectId);
                      })
                    }
                    className="btn-secondary !py-2"
                  >
                    ✓ Approve
                  </button>
                  <button
                    disabled={busy !== null || project.status !== 'APPROVED'}
                    onClick={() =>
                      void run('render', async () => {
                        const result = await api.render(project.projectId);
                        setDispatchNote(result.dispatch.message + (result.dispatch.workflowRunUrl ? ` · ${result.dispatch.workflowRunUrl}` : ''));
                        await loadProject(project.projectId);
                      })
                    }
                    className="btn-primary !py-2"
                  >
                    🎬 Render on GitHub
                  </button>
                </div>
              </div>
              {dispatchNote ? <div className="mt-3 text-xs text-muted bg-white/5 rounded-lg p-3">dispatch: {dispatchNote}</div> : null}
            </div>

            <div className="flex flex-wrap gap-1 bg-[#121218] border border-white/5 rounded-2xl p-1.5 w-fit">
              {PROJECT_TABS.map((t) => (
                <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>

            <div className="[&_*.panel]:!bg-[#121218] [&_*.panel]:!border-white/5 [&_.text-ink]:!text-white [&_.text-muted]:!text-[#8a8a98]">
              {tab === 'Overview' ? <Overview project={project} /> : null}
              {tab === 'Data Plan' ? <DataPlanView plan={project.dataPlan} /> : null}
              {tab === 'Sources' ? <SourcesView sources={project.sources} /> : null}
              {tab === 'Dataset' ? (
                <DatasetView
                  dataset={project.dataset}
                  onTopN={(topN) =>
                    void run('dataset-edit', async () => {
                      await api.patchDataset(project.projectId, { topN });
                      await loadProject(project.projectId);
                    })
                  }
                />
              ) : null}
              {tab === 'Preview' ? <RacePreview tape={project.frameTape} unit={project.dataset?.unit ?? 'count'} /> : null}
              {tab === 'Story' ? (
                <div className="space-y-4">
                  <StoryView story={project.story} />
                  <div className="card p-5 space-y-3">
                    <div className="text-sm font-bold text-white">✨ Revise in natural language</div>
                    <textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={2}
                      className="input"
                    />
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void run('revise', async () => {
                          await api.revise(project.projectId, instruction);
                          await loadProject(project.projectId);
                        })
                      }
                      className="btn-primary"
                    >
                      {busy === 'revise' ? 'Revising…' : 'Apply revision'}
                    </button>
                    {project.revisions.length > 0 ? (
                      <ul className="text-xs text-muted space-y-1 list-disc pl-4">
                        {project.revisions.map((r) => (
                          <li key={r.revisionId}>{r.revisionId}: {r.instruction}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {tab === 'Video Spec' ? <VideoSpecView spec={project.videoSpec} /> : null}
              {tab === 'Quality' ? <QualityView quality={project.quality} /> : null}
              {tab === 'Render' ? (
                <div className="card p-5 space-y-3 text-sm">
                  <div className="font-bold text-white text-base">Render job</div>
                  {project.renderJob ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-muted">status:</span>
                        <span className={statusBadge(project.renderJob.status)}>{project.renderJob.status}</span>
                      </div>
                      <div className="text-muted">github run: <span className="text-white font-mono">{project.renderJob.githubRunId ?? 'not dispatched'}</span></div>
                      {(project.renderJob.notes ?? []).map((n, i) => (
                        <div key={i} className="text-xs text-muted bg-white/5 rounded-lg p-2">{n}</div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-muted">Nothing dispatched yet. Approve the project, then press "🎬 Render on GitHub".<br />Local CLI renders appear in the <button onClick={() => setView('videos')} className="text-accent font-semibold hover:underline">Video Library</button>.</div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
