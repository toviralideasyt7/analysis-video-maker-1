import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Download,
  Film,
  FolderKanban,
  Home,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  ServerOff,
  Sparkles,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { api, type ProjectSummary } from './api';
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

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';

interface RenderItem {
  filename: string;
  title: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
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

function statusBadge(status: string): string {
  const s = status.toUpperCase();
  if (['READY_FOR_REVIEW', 'APPROVED', 'COMPLETED', 'DONE'].includes(s)) return 'badge-green';
  if (['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(s)) return 'badge-blue';
  if (['FAILED', 'ERROR'].includes(s)) return 'badge-red';
  if (['DRAFT', 'PENDING'].includes(s)) return 'badge-gray';
  return 'badge-amber';
}

/* ------------------------------------------------------------------ */
/* Backend status                                                      */
/* ------------------------------------------------------------------ */

type BackendState = 'checking' | 'online' | 'offline';

function useBackendStatus(): BackendState {
  const [state, setState] = useState<BackendState>('checking');
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        await api.health();
        if (!cancelled) setState('online');
      } catch {
        if (!cancelled) setState('offline');
      }
    };
    void check();
    const id = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return state;
}

function BackendPill({ state }: { state: BackendState }): React.ReactElement {
  if (state === 'checking') {
    return (
      <span className="backend-pill backend-checking" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Connecting…
      </span>
    );
  }
  if (state === 'online') {
    return (
      <span className="backend-pill backend-online" role="status">
        <Wifi size={14} aria-hidden="true" />
        Backend online
      </span>
    );
  }
  return (
    <span className="backend-pill backend-offline" role="status">
      <WifiOff size={14} aria-hidden="true" />
      Backend offline
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Skeleton({ className = '' }: { className?: string }): React.ReactElement {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }): React.ReactElement {
  return (
    <div className="card p-12 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface2 text-muted">
        {icon}
      </div>
      <div className="text-lg font-bold text-white">{title}</div>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{hint}</p>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }): React.ReactElement {
  return (
    <div className="error-banner" role="alert">
      <AlertTriangle size={18} aria-hidden="true" className="shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary !py-1.5 !px-3 !text-xs">
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Video library                                                       */
/* ------------------------------------------------------------------ */

function videoSrc(url: string): string {
  return url.startsWith('http') ? url : `${API_BASE}${url}`;
}

function VideoPlayerModal({ video, onClose }: { video: RenderItem; onClose: () => void }): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-label={`Play ${video.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="truncate text-xl font-extrabold capitalize text-white">{video.title}</h2>
            <button type="button" onClick={onClose} className="icon-btn" aria-label="Close video player">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <video
            src={videoSrc(video.url)}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="w-full rounded-xl bg-black"
            style={{ maxHeight: '62vh' }}
          />
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
            <span>{formatBytes(video.sizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(video.createdAt)}</span>
            <a
              href={videoSrc(video.url)}
              download={video.filename}
              className="btn-secondary ml-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={14} aria-hidden="true" /> Download
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function VideosGallery({ backend }: { backend: BackendState }): React.ReactElement {
  const [videos, setVideos] = useState<RenderItem[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [selected, setSelected] = useState<RenderItem | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api.listRenders();
      setVideos(res.renders);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(
    () => videos.filter((v) => v.title.toLowerCase().includes(search.toLowerCase())),
    [videos, search],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Video Library</h1>
          <p className="mt-1 text-sm text-muted">
            {state === 'ready' ? `${videos.length} rendered video${videos.length === 1 ? '' : 's'}` : 'Your rendered videos'}
          </p>
        </div>
        <div className="relative ml-auto">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search videos…"
            aria-label="Search videos"
            className="input !w-64 !pl-9"
          />
        </div>
      </div>

      {backend === 'offline' && state === 'error' ? (
        <ErrorBanner
          message="Can't reach the video backend. Check that the API worker is deployed and VITE_API_BASE points at it."
          onRetry={load}
        />
      ) : null}

      {state === 'loading' ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading videos">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card overflow-hidden">
              <Skeleton className="aspect-video w-full !rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : state === 'error' ? (
        <EmptyState
          icon={<ServerOff size={26} aria-hidden="true" />}
          title="Couldn't load videos"
          hint="The request failed. Check your connection and try again."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Clapperboard size={26} aria-hidden="true" />}
          title="No videos yet"
          hint={videos.length === 0 ? 'Render a video from a project to see it here.' : 'No videos match your search.'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((v) => (
            <button
              key={v.filename}
              type="button"
              onClick={() => setSelected(v)}
              className="card-hover overflow-hidden text-left"
              aria-label={`Play ${v.title}`}
            >
              <div className="video-thumb">
                <video src={videoSrc(v.url) + "#t=2"} preload="metadata" muted playsInline aria-hidden="true" />
                <div className="play-overlay" aria-hidden="true">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent shadow-lg">
                    <Play size={22} className="ml-0.5 text-white" fill="currentColor" />
                  </div>
                </div>
              </div>
              <div className="p-4">
                <div className="truncate font-bold capitalize text-white">{v.title}</div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <span>{formatBytes(v.sizeBytes)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDate(v.createdAt)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected ? <VideoPlayerModal video={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

function Dashboard({ projects, videos, onSelectProject, onNavigate }: {
  projects: ProjectSummary[];
  videos: RenderItem[];
  onSelectProject: (id: string) => void;
  onNavigate: (v: View) => void;
}): React.ReactElement {
  const activeProjects = projects.filter((p) =>
    ['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(p.status.toUpperCase()),
  ).length;
  const totalBytes = videos.reduce((sum, v) => sum + v.sizeBytes, 0);
  const recentProjects = projects.slice(0, 5);
  const recentVideos = videos.slice(0, 3);

  const stats = [
    { label: 'Projects', value: String(projects.length), icon: <FolderKanban size={18} aria-hidden="true" /> },
    { label: 'Videos rendered', value: String(videos.length), icon: <Film size={18} aria-hidden="true" /> },
    { label: 'In progress', value: String(activeProjects), icon: <Loader2 size={18} aria-hidden="true" /> },
    { label: 'Video storage', value: formatBytes(totalBytes), icon: <Server size={18} aria-hidden="true" /> },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-extrabold text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">Your video research studio at a glance</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="mb-2 text-accent">{s.icon}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-label="Recent projects">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-bold text-white">Recent projects</h2>
            <button type="button" className="link-btn" onClick={() => onNavigate('projects')}>
              View all <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
          {recentProjects.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No projects yet. Create one to get started.</p>
          ) : (
            <ul className="space-y-2">
              {recentProjects.map((p) => (
                <li key={p.projectId}>
                  <button
                    type="button"
                    onClick={() => onSelectProject(p.projectId)}
                    className="list-row"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-white">{p.title}</span>
                      <span className="block truncate text-xs text-muted">{formatDate(p.updatedAt)}</span>
                    </span>
                    <span className={statusBadge(p.status)}>{p.status.replace(/_/g, ' ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5" aria-label="Recent videos">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-bold text-white">Recent videos</h2>
            <button type="button" className="link-btn" onClick={() => onNavigate('videos')}>
              View all <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
          {recentVideos.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No rendered videos yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentVideos.map((v) => (
                <li key={v.filename} className="list-row-static">
                  <Play size={15} aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold capitalize text-white">{v.title}</span>
                    <span className="block text-xs text-muted">{formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card p-5" aria-label="Quick actions">
        <h2 className="mb-4 text-base font-bold text-white">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-primary" onClick={() => onNavigate('new')}>
            <Plus size={16} aria-hidden="true" /> New project
          </button>
          <button type="button" className="btn-secondary" onClick={() => onNavigate('videos')}>
            <Film size={16} aria-hidden="true" /> Browse videos
          </button>
          <button type="button" className="btn-secondary" onClick={() => onNavigate('projects')}>
            <FolderKanban size={16} aria-hidden="true" /> All projects
          </button>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function ProjectsList({ projects, state, onSelect, onRetry }: {
  projects: ProjectSummary[];
  state: 'loading' | 'error' | 'ready';
  onSelect: (id: string) => void;
  onRetry: () => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');
  const filtered = useMemo(
    () => projects.filter((p) => `${p.title} ${p.topic}`.toLowerCase().includes(search.toLowerCase())),
    [projects, search],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            {state === 'ready' ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : 'Your research projects'}
          </p>
        </div>
        <div className="relative ml-auto">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="input !w-64 !pl-9"
          />
        </div>
      </div>

      {state === 'loading' ? (
        <div className="space-y-3" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-4"><Skeleton className="h-6 w-2/3" /></div>
          ))}
        </div>
      ) : state === 'error' ? (
        <ErrorBanner message="Couldn't load projects. The backend may be offline." onRetry={onRetry} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={26} aria-hidden="true" />}
          title="No projects found"
          hint={projects.length === 0 ? 'Create your first project to start researching a topic.' : 'No projects match your search.'}
        />
      ) : (
        <ul className="space-y-3">
          {filtered.map((p) => (
            <li key={p.projectId}>
              <button type="button" onClick={() => onSelect(p.projectId)} className="card-hover w-full p-4 text-left">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-white">{p.title}</span>
                    <span className="mt-1 block truncate text-sm text-muted">{p.topic}</span>
                  </span>
                  <span className={statusBadge(p.status)}>{p.status.replace(/_/g, ' ')}</span>
                  <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (id: string) => void }): React.ReactElement {
  const [topic, setTopic] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createProject(topic.trim(), title.trim() || undefined);
      onCreated(res.project.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white">New project</h1>
        <p className="mt-1 text-sm text-muted">Describe the topic you want to turn into a data video.</p>
      </div>
      <form onSubmit={submit} className="card space-y-4 p-6">
        <div>
          <label htmlFor="np-topic" className="form-label">Topic</label>
          <input
            id="np-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. World population by country 1960–2024"
            className="input"
            required
            minLength={3}
            autoFocus
          />
          <p className="form-hint">Be specific — a clear topic gets better research.</p>
        </div>
        <div>
          <label htmlFor="np-title" className="form-label">Title <span className="text-muted">(optional)</span></label>
          <input
            id="np-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to the topic"
            className="input"
          />
        </div>
        {error ? <ErrorBanner message={error} /> : null}
        <button type="submit" className="btn-primary w-full" disabled={busy || topic.trim().length < 3}>
          {busy ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Sparkles size={16} aria-hidden="true" />}
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Project detail                                                      */
/* ------------------------------------------------------------------ */

function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }): React.ReactElement {
  const [project, setProject] = useState<any>(null);
  const [tab, setTab] = useState<ProjectTab>('Overview');
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api.getProject(projectId);
      setProject(res.project);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (state === 'loading') {
    return (
      <div className="space-y-4" aria-label="Loading project">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state === 'error' || !project) {
    return (
      <div className="space-y-4">
        <button type="button" className="btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </button>
        <ErrorBanner message="Couldn't load this project." onRetry={load} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> Projects
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-extrabold text-white">{project.title}</h1>
          <p className="truncate text-sm text-muted">{project.topic}</p>
        </div>
        <span className={`${statusBadge(project.status)} ml-auto`}>{String(project.status).replace(/_/g, ' ')}</span>
      </div>

      <div className="tab-bar" role="tablist" aria-label="Project sections">
        {PROJECT_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`tab-btn ${tab === t ? 'tab-btn-active' : ''}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'Overview' && <Overview project={project} />}
        {tab === 'Data Plan' && <DataPlanView plan={project.dataPlan} />}
        {tab === 'Sources' && <SourcesView sources={project.sources} />}
        {tab === 'Dataset' && <DatasetView dataset={project.dataset} />}
        {tab === 'Preview' && <RacePreview tape={project.frameTape} unit={project.dataset?.unit ?? ''} />}
        {tab === 'Story' && <StoryView story={project.story} />}
        {tab === 'Video Spec' && <VideoSpecView spec={project.videoSpec} />}
        {tab === 'Quality' && <QualityView quality={project.quality} />}
        {tab === 'Render' && <RenderTab project={project} onRefresh={load} />}
      </div>
    </div>
  );
}

function RenderTab({ project, onRefresh }: { project: any; onRefresh: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const trigger = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.render(project.projectId);
      setNote(res.dispatch?.message ?? 'Render dispatched. Watch the Videos tab — the video appears when the workflow finishes.');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger render');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-4 p-6">
      <h2 className="text-lg font-bold text-white">Render video</h2>
      <p className="text-sm text-muted">
        This dispatches the GitHub Actions render workflow. Rendering takes a few minutes;
        the finished video shows up in the Video Library automatically.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      {note ? (
        <div className="success-banner" role="status">
          <CheckCircle2 size={18} aria-hidden="true" className="shrink-0" />
          <span>{note}</span>
        </div>
      ) : null}
      <button type="button" className="btn-primary" onClick={trigger} disabled={busy}>
        {busy ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Clapperboard size={16} aria-hidden="true" />}
        {busy ? 'Dispatching…' : 'Render on GitHub'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const NAV: Array<{ id: View; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <Home size={18} aria-hidden="true" /> },
  { id: 'videos', label: 'Videos', icon: <Film size={18} aria-hidden="true" /> },
  { id: 'projects', label: 'Projects', icon: <FolderKanban size={18} aria-hidden="true" /> },
  { id: 'new', label: 'New project', icon: <Plus size={18} aria-hidden="true" /> },
];

export default function App(): React.ReactElement {
  const [view, setView] = useState<View>('dashboard');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsState, setProjectsState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [videos, setVideos] = useState<RenderItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const backend = useBackendStatus();

  const loadProjects = useCallback(async () => {
    setProjectsState('loading');
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
      setProjectsState('ready');
    } catch {
      setProjectsState('error');
    }
  }, []);

  const loadVideos = useCallback(async () => {
    try {
      const res = await api.listRenders();
      setVideos(res.renders);
    } catch {
      /* videos are optional for the shell; gallery shows its own error */
    }
  }, []);

  useEffect(() => {
    if (backend === 'online') {
      void loadProjects();
      void loadVideos();
    } else if (backend === 'offline') {
      setProjectsState('error');
    }
  }, [backend, loadProjects, loadVideos]);

  const navigate = (v: View) => {
    setSelectedProject(null);
    setView(v);
    window.scrollTo({ top: 0 });
  };

  const openProject = (id: string) => {
    setSelectedProject(id);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">Skip to main content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true"><Clapperboard size={20} /></span>
          <span className="brand-name">Race Video Studio</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate(item.id)}
              className={`nav-btn ${view === item.id && !selectedProject ? 'nav-btn-active' : ''}`}
              aria-current={view === item.id && !selectedProject ? 'page' : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <BackendPill state={backend} />
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <span className="topbar-title">
            {selectedProject ? 'Project' : NAV.find((n) => n.id === view)?.label}
          </span>
          <span className="topbar-status"><BackendPill state={backend} /></span>
        </header>
        <main id="main" className="main-content">
          {selectedProject ? (
            <ProjectDetail projectId={selectedProject} onBack={() => setSelectedProject(null)} />
          ) : view === 'dashboard' ? (
            <Dashboard projects={projects} videos={videos} onSelectProject={openProject} onNavigate={navigate} />
          ) : view === 'videos' ? (
            <VideosGallery backend={backend} />
          ) : view === 'projects' ? (
            <ProjectsList projects={projects} state={projectsState} onSelect={openProject} onRetry={loadProjects} />
          ) : (
            <NewProject onCreated={openProject} />
          )}
        </main>
      </div>
    </div>
  );
}
