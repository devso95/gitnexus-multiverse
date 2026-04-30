import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, del } from '../api';
import FolderExplorer from '../components/FolderExplorer';
import {
  Bot,
  Brain,
  CircleCheck,
  CircleX,
  FileText,
  FolderOpen,
  Link as LinkIcon,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  AddServiceBody,
  AddServiceResponse,
  AnalyzeDoneEvent,
  AnalyzeProgressEvent,
  AnalyzeResponse,
  HealthInfo,
  ResolveSinksResponse,
  Service,
  ServicesResponse,
  ServiceStatusResponse,
} from '../types/multiverse-api';

type SourceMode = 'git' | 'local';
type StatusFilter = 'all' | 'healthy' | 'stale' | 'never' | 'running' | 'failed';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_RE = /^[A-Za-z0-9_-]{1,20}$/;
const SLUG_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

const parseGitUrl = (url: string) => {
  const m = url.match(/\/scm\/([^/]+)\/([^/.]+)/);
  if (m) return { project: m[1].toUpperCase(), slug: m[2] };
  const m2 = url.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (m2) return { project: m2[1].toUpperCase(), slug: m2[2] };
  return null;
};

const getFreshnessHours = (indexedAt?: string) => {
  if (!indexedAt) return Infinity;
  return (Date.now() - new Date(indexedAt).getTime()) / 3600000;
};

const getFreshnessLabel = (indexedAt?: string) => {
  if (!indexedAt) return { tone: 'text-err', label: 'Never analyzed' };
  const h = getFreshnessHours(indexedAt);
  if (h < 24) return { tone: 'text-ok', label: 'Healthy' };
  if (h < 168) return { tone: 'text-warn', label: 'Stale (< 7d)' };
  return { tone: 'text-err', label: 'Stale (>= 7d)' };
};

export default function Services() {
  const nav = useNavigate();
  const [services, setServices] = useState<Service[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [showExplorer, setShowExplorer] = useState(false);
  const [form, setForm] = useState({
    id: '',
    name: '',
    type: 'service',
    project: '',
    slug: '',
    branch: 'master',
  });
  const [formErr, setFormErr] = useState('');
  const [analyzeAfter, setAnalyzeAfter] = useState(true);
  const [analyzing, setAnalyzing] = useState<Record<string, string>>({});
  const [jobSteps, setJobSteps] = useState<Record<string, string>>({});
  const [wikiStatus, setWikiStatus] = useState<Record<string, string>>({});
  const [resolveStatus, setResolveStatus] = useState<Record<string, string>>({});
  const eventSources = useRef<Record<string, EventSource>>({});

  const closeEventSource = (id: string) => {
    const es = eventSources.current[id];
    if (es) {
      es.close();
      delete eventSources.current[id];
    }
  };

  const pollStatus = (id: string, maxTries = 90) => {
    let tries = 0;
    const poll = () => {
      tries += 1;
      get<ServiceStatusResponse>(`/api/mv/services/${id}/status`)
        .then((r) => {
          const s = r.analyzeStatus || 'unknown';
          setAnalyzing((p) => ({ ...p, [id]: s }));
          if (s === 'completed' || s === 'failed' || s === 'idle') {
            load();
            setTimeout(() => {
              setAnalyzing((p) => {
                const n = { ...p };
                delete n[id];
                return n;
              });
              setJobSteps((p) => {
                const n = { ...p };
                delete n[id];
                return n;
              });
            }, 3000);
            closeEventSource(id);
          } else if (tries < maxTries) {
            setTimeout(poll, 2000);
          }
        })
        .catch(() => {
          if (tries < maxTries) setTimeout(poll, 2500);
        });
    };
    setTimeout(poll, 1000);
  };

  const load = () => {
    setLoading(true);
    setLoadErr('');
    Promise.all([
      get<ServicesResponse>('/api/mv/services'),
      get<HealthInfo>('/api/ops/health').catch(() => null),
    ])
      .then(([svcResp, healthResp]) => {
        const svcs = svcResp.services || [];
        setServices(svcs);
        setHealth(healthResp);
        setAnalyzing((prev) => {
          const next = { ...prev };
          for (const s of svcs) {
            if ((s.analyzeStatus === 'analyzing' || s.analyzeStatus === 'cloning') && !next[s.id]) {
              next[s.id] = s.analyzeStatus;
              pollStatus(s.id);
            }
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        setLoadErr(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    return () => {
      Object.keys(eventSources.current).forEach(closeEventSource);
    };
  }, []);

  useEffect(() => {
    if (!gitUrl || sourceMode !== 'git') return;
    const parsed = parseGitUrl(gitUrl);
    if (parsed) {
      setForm((f) => ({
        ...f,
        id: f.id || parsed.slug,
        name: f.name || parsed.slug,
        project: parsed.project,
        slug: parsed.slug,
      }));
    }
  }, [gitUrl, sourceMode]);

  useEffect(() => {
    if (!localPath || sourceMode !== 'local') return;
    const slug = localPath.split('/').filter(Boolean).pop();
    if (slug) {
      setForm((f) => ({
        ...f,
        id: f.id || slug,
        name: f.name || slug,
        project: 'LOCAL',
        slug,
      }));
    }
  }, [localPath, sourceMode]);

  const projects = useMemo(
    () =>
      Array.from(new Set(services.map((s) => s.repoProject).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [services],
  );

  const serviceTypes = useMemo(
    () =>
      Array.from(new Set(services.map((s) => s.type).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [services],
  );

  const filtered = services.filter((s) => {
    const q = search.trim().toLowerCase();
    if (
      q &&
      !(
        s.id.toLowerCase().includes(q) ||
        (s.name || '').toLowerCase().includes(q) ||
        (s.repoProject || '').toLowerCase().includes(q)
      )
    ) {
      return false;
    }
    if (typeFilter !== 'all' && s.type !== typeFilter) return false;
    if (projectFilter !== 'all' && s.repoProject !== projectFilter) return false;

    const liveStatus = analyzing[s.id] || s.analyzeStatus || '';
    const freshness = getFreshnessHours(s.indexedAt);
    switch (statusFilter) {
      case 'running':
        return ['queued', 'cloning', 'analyzing', 'relinking'].includes(liveStatus);
      case 'failed':
        return liveStatus === 'failed';
      case 'healthy':
        return freshness < 24;
      case 'stale':
        return Number.isFinite(freshness) && freshness >= 24;
      case 'never':
        return !s.indexedAt;
      default:
        return true;
    }
  });

  const stats = useMemo(() => {
    const healthy = services.filter((s) => getFreshnessHours(s.indexedAt) < 24).length;
    const stale = services.filter(
      (s) =>
        Number.isFinite(getFreshnessHours(s.indexedAt)) && getFreshnessHours(s.indexedAt) >= 24,
    ).length;
    const never = services.filter((s) => !s.indexedAt).length;
    const running = services.filter((s) =>
      ['queued', 'cloning', 'analyzing', 'relinking'].includes(
        analyzing[s.id] || s.analyzeStatus || '',
      ),
    ).length;
    return { healthy, stale, never, running };
  }, [services, analyzing]);

  const validateForm = () => {
    if (!ID_RE.test(form.id)) return 'Service ID: alphanumeric, "_" or "-", max 64.';
    if (!PROJECT_RE.test(form.project)) return 'Project: alphanumeric, "_" or "-", max 20.';
    if (!SLUG_RE.test(form.slug)) return 'Slug: alphanumeric, ".", "_" or "-", max 64.';
    if (!form.branch.trim()) return 'Branch is required.';
    if (sourceMode === 'git' && !gitUrl.trim()) return 'Git Clone URL is required for Git mode.';
    if (sourceMode === 'local' && !localPath.trim())
      return 'Local Path is required for Local mode.';
    return '';
  };

  const attachAnalyzeStream = (id: string, jobId?: string) => {
    if (!jobId) {
      pollStatus(id);
      return;
    }
    closeEventSource(id);
    const es = new EventSource(
      `/api/mv/services/${id}/analyze-stream?jobId=${encodeURIComponent(jobId)}`,
    );
    eventSources.current[id] = es;

    es.addEventListener('progress', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as AnalyzeProgressEvent;
        if (data.status) setAnalyzing((p) => ({ ...p, [id]: data.status! }));
        if (Array.isArray(data.steps) && data.steps.length) {
          const running =
            [...data.steps].reverse().find((s) => s.status === 'running') ||
            data.steps[data.steps.length - 1];
          if (running) setJobSteps((p) => ({ ...p, [id]: running.step }));
        }
      } catch {
        pollStatus(id);
      }
    });

    es.addEventListener('done', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as AnalyzeDoneEvent;
        setAnalyzing((p) => ({ ...p, [id]: data.status || 'completed' }));
      } catch {
        setAnalyzing((p) => ({ ...p, [id]: 'completed' }));
      }
      closeEventSource(id);
      load();
      setTimeout(() => {
        setAnalyzing((p) => {
          const n = { ...p };
          delete n[id];
          return n;
        });
        setJobSteps((p) => {
          const n = { ...p };
          delete n[id];
          return n;
        });
      }, 3000);
    });

    es.onerror = () => {
      closeEventSource(id);
      pollStatus(id);
    };
  };

  const resetForm = () => {
    setForm({
      id: '',
      name: '',
      type: 'service',
      project: '',
      slug: '',
      branch: 'master',
    });
    setGitUrl('');
    setLocalPath('');
    setSourceMode('git');
    setFormErr('');
  };

  const addService = async (e: FormEvent) => {
    e.preventDefault();
    setFormErr('');
    const err = validateForm();
    if (err) {
      setFormErr(err);
      return;
    }
    try {
      const body: AddServiceBody = {
        id: form.id,
        name: form.name || form.id,
        type: form.type,
        repo: { project: form.project, slug: form.slug, branch: form.branch },
      };
      if (sourceMode === 'git') body.gitUrl = gitUrl;
      if (sourceMode === 'local') body.localPath = localPath;

      const svc = await post<AddServiceResponse>('/api/mv/services', body);
      if (analyzeAfter) {
        setAnalyzing((p) => ({ ...p, [svc.id]: 'queued' }));
        post<AnalyzeResponse>(`/api/mv/services/${svc.id}/analyze`)
          .then((r) => attachAnalyzeStream(svc.id, r.jobId))
          .catch(() => pollStatus(svc.id));
      }
      setShowAdd(false);
      resetForm();
      load();
    } catch (ex: unknown) {
      setFormErr(ex instanceof Error ? ex.message : String(ex));
    }
  };

  const analyze = (id: string) => {
    setAnalyzing((p) => ({ ...p, [id]: 'queued' }));
    post<AnalyzeResponse>(`/api/mv/services/${id}/analyze`)
      .then((r) => attachAnalyzeStream(id, r.jobId))
      .catch(() => setAnalyzing((p) => ({ ...p, [id]: 'failed' })));
  };

  const relink = (id: string) => {
    setAnalyzing((p) => ({ ...p, [id]: 'relinking' }));
    post<AnalyzeResponse>(`/api/mv/services/${id}/relink`)
      .then((r) => attachAnalyzeStream(id, r.jobId))
      .catch(() => setAnalyzing((p) => ({ ...p, [id]: 'failed' })));
  };

  const genWiki = (id: string) => {
    setWikiStatus((p) => ({ ...p, [id]: 'generating' }));
    post(`/api/mv/wiki/generate/${id}`, {})
      .then(() => {
        setWikiStatus((p) => ({ ...p, [id]: 'done' }));
        setTimeout(() => {
          setWikiStatus((p) => {
            const n = { ...p };
            delete n[id];
            return n;
          });
        }, 3000);
      })
      .catch(() => {
        setWikiStatus((p) => ({ ...p, [id]: 'failed' }));
        setTimeout(() => {
          setWikiStatus((p) => {
            const n = { ...p };
            delete n[id];
            return n;
          });
        }, 3000);
      });
  };

  const resolveSinks = (id: string) => {
    setResolveStatus((p) => ({ ...p, [id]: 'resolving' }));
    post<ResolveSinksResponse>(`/api/mv/services/${id}/resolve-sinks`)
      .then((r) => {
        setResolveStatus((p) => ({ ...p, [id]: `resolved ${r.resolved}/${r.total}` }));
        setTimeout(() => {
          setResolveStatus((p) => {
            const n = { ...p };
            delete n[id];
            return n;
          });
        }, 4000);
        if (r.resolved > 0) load();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Resolve failed';
        setResolveStatus((p) => ({ ...p, [id]: message }));
        setTimeout(() => {
          setResolveStatus((p) => {
            const n = { ...p };
            delete n[id];
            return n;
          });
        }, 4000);
      });
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete service "${id}"? This removes all indexed data.`)) return;
    await del(`/api/mv/services/${id}?confirm=true`);
    load();
  };

  const totalNodes = services.reduce((sum, s) => sum + (s.nodeCount || 0), 0);
  const totalEdges = services.reduce((sum, s) => sum + (s.edgeCount || 0), 0);
  const neo4jConnected = health?.neo4j?.connected;

  return (
    <>
      <div className="border-border flex items-center justify-between border-b bg-surface px-8 py-4">
        <div>
          <h1 className="text-xl font-semibold">Services</h1>
          <p className="text-text2 text-xs">
            Register services and operate analyze, relink, wiki, and sink actions.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="hover:bg-accent2 inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
        >
          <Plus size={16} />
          Register Service
        </button>
      </div>

      <div className="p-8">
        <div className="mb-4 grid grid-cols-5 gap-3">
          <StatCard label="Total" value={`${services.length}`} tone="text-text" />
          <StatCard label="Healthy" value={`${stats.healthy}`} tone="text-ok" />
          <StatCard label="Running" value={`${stats.running}`} tone="text-accent" />
          <StatCard
            label="Graph"
            value={`${totalNodes.toLocaleString()} N / ${totalEdges.toLocaleString()} E`}
            tone="text-text"
          />
          <StatCard
            label="Backend"
            value={neo4jConnected ? 'Neo4j connected' : 'Health unknown'}
            tone={neo4jConnected ? 'text-ok' : 'text-err'}
          />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search size={14} className="text-text2 absolute top-1/2 left-2.5 -translate-y-1/2" />
            <input
              className="bg-surface2 border-border text-text w-full rounded-lg border py-2 pr-3 pl-8 text-sm outline-none focus:border-accent"
              placeholder="Search by id, name, project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            className="bg-surface2 border-border rounded-lg border px-2.5 py-2 text-xs"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">Status: All</option>
            <option value="healthy">Healthy</option>
            <option value="stale">Stale</option>
            <option value="never">Never analyzed</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
          </select>

          <select
            className="bg-surface2 border-border rounded-lg border px-2.5 py-2 text-xs"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">Type: All</option>
            {serviceTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            className="bg-surface2 border-border rounded-lg border px-2.5 py-2 text-xs"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="all">Project: All</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <button
            className="bg-surface2 border-border rounded-lg border px-2.5 py-2 text-xs"
            onClick={load}
          >
            Refresh
          </button>
        </div>

        {loadErr && <div className="text-err mb-3 text-sm">{loadErr}</div>}

        <div className="border-border overflow-hidden rounded-xl border bg-surface">
          <table className="w-full table-fixed">
            <thead>
              <tr className="bg-surface2">
                {['Service', 'Project', 'Type', 'Graph', 'Freshness', 'Status', 'Actions'].map(
                  (h) => (
                    <th
                      key={h}
                      className="text-text2 border-border border-b px-4 py-3 text-left text-[11px] uppercase"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="text-text2 px-4 py-8 text-center">
                    Loading services...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-text2 px-4 py-8 text-center">
                    No services match current filters.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => {
                  const status = analyzing[s.id] || s.analyzeStatus || 'idle';
                  const freshness = getFreshnessLabel(s.indexedAt);
                  const isRunning = ['queued', 'cloning', 'analyzing', 'relinking'].includes(
                    status,
                  );
                  return (
                    <tr
                      key={s.id}
                      className="cursor-pointer hover:bg-accent/5"
                      onClick={() => nav(`/services/${s.id}`)}
                    >
                      <td className="border-border border-b px-4 py-3">
                        <div className="font-medium">{s.name || s.id}</div>
                        <div className="text-text2 truncate text-xs">{s.id}</div>
                      </td>
                      <td className="border-border border-b px-4 py-3">
                        <span className="text-accent2 rounded-full bg-accent/15 px-2 py-0.5 text-xs">
                          {s.repoProject}
                        </span>
                      </td>
                      <td className="text-text2 border-border border-b px-4 py-3">{s.type}</td>
                      <td className="text-text2 border-border border-b px-4 py-3 text-xs">
                        {(s.nodeCount || 0).toLocaleString()} N /{' '}
                        {(s.edgeCount || 0).toLocaleString()} E
                      </td>
                      <td className={`border-border border-b px-4 py-3 text-xs ${freshness.tone}`}>
                        {freshness.label}
                      </td>
                      <td className="border-border border-b px-4 py-3 text-xs">
                        <div
                          className={
                            status === 'failed'
                              ? 'text-err'
                              : status === 'completed'
                                ? 'text-ok'
                                : 'text-accent'
                          }
                        >
                          {isRunning ? (
                            <span className="inline-flex items-center gap-1">
                              <LoaderCircle size={12} className="animate-spin" />
                              {jobSteps[s.id] ? `${status}: ${jobSteps[s.id]}` : status}
                            </span>
                          ) : (
                            status
                          )}
                        </div>
                      </td>
                      <td
                        className="border-border border-b px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1.5">
                          <ActionButton
                            title="Analyze"
                            disabled={isRunning}
                            onClick={() => analyze(s.id)}
                            icon={<Brain size={14} />}
                          />
                          <ActionButton
                            title="Re-link"
                            disabled={isRunning}
                            onClick={() => relink(s.id)}
                            icon={<LinkIcon size={14} />}
                          />
                          <ActionButton
                            title="Generate Wiki"
                            disabled={wikiStatus[s.id] === 'generating'}
                            onClick={() => genWiki(s.id)}
                            icon={
                              wikiStatus[s.id] === 'done' ? (
                                <CircleCheck size={14} />
                              ) : wikiStatus[s.id] === 'failed' ? (
                                <CircleX size={14} />
                              ) : (
                                <FileText size={14} />
                              )
                            }
                          />
                          <ActionButton
                            title={resolveStatus[s.id] || 'Resolve unresolved sinks'}
                            disabled={!!resolveStatus[s.id]}
                            onClick={() => resolveSinks(s.id)}
                            icon={
                              resolveStatus[s.id] === 'resolving' ? (
                                <LoaderCircle size={14} className="animate-spin" />
                              ) : (
                                <Bot size={14} />
                              )
                            }
                          />
                          <ActionButton
                            title="Delete service"
                            className="hover:bg-err hover:text-white"
                            onClick={() => remove(s.id)}
                            icon={<Trash2 size={14} />}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowAdd(false)}
        >
          <form
            onSubmit={addService}
            onClick={(e) => e.stopPropagation()}
            className="border-border w-[520px] space-y-3 rounded-xl border bg-surface p-6"
          >
            <h2 className="text-lg font-semibold">Register Service</h2>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSourceMode('git')}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  sourceMode === 'git'
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-surface2'
                }`}
              >
                Git URL
              </button>
              <button
                type="button"
                onClick={() => setSourceMode('local')}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  sourceMode === 'local'
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-surface2'
                }`}
              >
                Local Path
              </button>
            </div>

            {formErr && <div className="text-err text-sm">{formErr}</div>}

            {sourceMode === 'git' ? (
              <div>
                <label className="text-text2 text-xs uppercase">Git Clone URL</label>
                <input
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  placeholder="https://host/scm/project/service.git"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  autoFocus
                />
              </div>
            ) : (
              <div>
                <label className="text-text2 text-xs uppercase">Local Path</label>
                <div className="mt-1 flex gap-2">
                  <input
                    className="bg-surface2 border-border text-text flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                    placeholder="/workspace/my-service"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowExplorer(true)}
                    className="bg-surface2 border-border rounded-lg border px-3 py-2 text-sm"
                    title="Browse folders"
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </div>
            )}

            {showExplorer && (
              <FolderExplorer
                onSelect={(p) => setLocalPath(p)}
                onClose={() => setShowExplorer(false)}
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Service ID">
                <input
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  required
                />
              </Field>
              <Field label="Type">
                <select
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  <option value="service">Service</option>
                  <option value="lib">Library</option>
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Project">
                <input
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                  value={form.project}
                  onChange={(e) => setForm({ ...form, project: e.target.value })}
                  required
                />
              </Field>
              <Field label="Slug">
                <input
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  required
                />
              </Field>
              <Field label="Branch">
                <input
                  className="bg-surface2 border-border text-text mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  required
                />
              </Field>
            </div>

            <div className="text-text2 bg-surface2 rounded-lg px-3 py-2 text-xs">
              <div className="mb-1">Preview</div>
              <div className="font-mono">
                id={form.id || '-'} project={form.project || '-'} slug={form.slug || '-'} branch=
                {form.branch || '-'}
              </div>
            </div>

            <label className="text-text2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={analyzeAfter}
                onChange={(e) => setAnalyzeAfter(e.target.checked)}
                className="border-border rounded"
              />
              Analyze immediately after register
            </label>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                className="hover:bg-accent2 flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white"
              >
                Register
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  resetForm();
                }}
                className="bg-surface2 border-border flex-1 rounded-lg border py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function ActionButton({
  title,
  icon,
  disabled,
  onClick,
  className = '',
}: {
  title: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`bg-surface2 border-border inline-flex h-7 w-7 items-center justify-center rounded border text-xs hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {icon}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-text2 text-xs uppercase">{label}</span>
      {children}
    </label>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="border-border rounded-lg border bg-surface p-3">
      <div className="text-text2 text-[11px] uppercase">{label}</div>
      <div className={`text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
