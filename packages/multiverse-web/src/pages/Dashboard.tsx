import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { Link } from 'react-router-dom';

interface Service {
  id: string;
  name: string;
  type: string;
  repoProject: string;
  nodeCount?: number;
  edgeCount?: number;
  entryPointCount?: number;
  indexedAt?: string;
}

interface HealthInfo {
  status: string;
  version: string;
  uptime: number;
  [key: string]: unknown;
}

interface AnalyzeProgress {
  serviceId: string;
  jobId: string;
  steps: Array<{ step: string; status: string; detail?: string }>;
  done: boolean;
  error?: string;
}

const ago = (d?: string) => {
  if (!d) return 'Never';
  const ms = Date.now() - new Date(d).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'Just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const statusBadge = (d?: string) => {
  if (!d)
    return (
      <span className="bg-err/15 text-err inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
        ● Never
      </span>
    );
  const h = (Date.now() - new Date(d).getTime()) / 3600000;
  if (h < 24)
    return (
      <span className="bg-ok/15 text-ok inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
        ● Healthy
      </span>
    );
  if (h < 168)
    return (
      <span className="bg-warn/15 text-warn inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
        ● Warning
      </span>
    );
  return (
    <span className="bg-err/15 text-err inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
      ● Stale ({Math.floor(h / 24)}d)
    </span>
  );
};

const stepIcon = (status: string) =>
  status === 'done' ? '✅' : status === 'running' ? '⏳' : status === 'failed' ? '❌' : '⬜';

export default function Dashboard() {
  const [services, setServices] = useState<Service[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeJobs, setActiveJobs] = useState<Map<string, AnalyzeProgress>>(new Map());

  const load = () => {
    setLoading(true);
    Promise.all([
      get<{ services: Service[] }>('/api/mv/services').then((r) => setServices(r.services || [])),
      get<HealthInfo>('/api/ops/health')
        .then(setHealth)
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const analyzeService = (svcId: string) => {
    post<{ jobId: string }>(`/api/mv/services/${svcId}/analyze`).then((r) => {
      if (!r.jobId) return;
      // Start SSE stream
      const es = new EventSource(`/api/mv/services/${svcId}/analyze-stream?jobId=${r.jobId}`);
      const progress: AnalyzeProgress = {
        serviceId: svcId,
        jobId: r.jobId,
        steps: [],
        done: false,
      };
      setActiveJobs((prev) => new Map(prev).set(svcId, progress));

      es.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        progress.steps = data.steps;
        setActiveJobs((prev) => new Map(prev).set(svcId, { ...progress }));
      });
      es.addEventListener('done', (e) => {
        const data = JSON.parse(e.data);
        progress.done = true;
        progress.error = data.error;
        setActiveJobs((prev) => new Map(prev).set(svcId, { ...progress }));
        es.close();
        load(); // refresh
        // Auto-remove after 10s
        setTimeout(
          () =>
            setActiveJobs((prev) => {
              const m = new Map(prev);
              m.delete(svcId);
              return m;
            }),
          10000,
        );
      });
      es.onerror = () => {
        es.close();
      };
    });
  };

  const analyzeAll = () => {
    post<{ queued: string[] }>('/api/mv/ops/analyze-all')
      .then((r) => {
        for (const svcId of r.queued || []) analyzeService(svcId);
      })
      .catch(() => {
        // Fallback: just trigger without SSE
        post('/api/mv/ops/analyze-all');
      });
  };

  const relinkAll = () => {
    post('/api/mv/ops/relink-all');
  };

  const totalNodes = services.reduce((s, v) => s + (v.nodeCount || 0), 0);
  const totalEdges = services.reduce((s, v) => s + (v.edgeCount || 0), 0);
  const totalEntryPoints = services.reduce((s, v) => s + (v.entryPointCount || 0), 0);
  const stale = services.filter(
    (s) => !s.indexedAt || Date.now() - new Date(s.indexedAt).getTime() > 7 * 86400000,
  ).length;

  return (
    <>
      <div className="border-border flex items-center justify-between border-b bg-surface px-8 py-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <button
            onClick={analyzeAll}
            className="bg-surface2 border-border rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-white"
          >
            ⟳ Analyze All
          </button>
          <button
            onClick={relinkAll}
            className="bg-surface2 border-border rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-white"
          >
            🔗 Re-link All
          </button>
        </div>
      </div>
      <div className="p-8">
        {loading ? (
          <div className="text-text2">Loading...</div>
        ) : (
          <>
            {/* Stats */}
            <div className="mb-6 grid grid-cols-5 gap-4">
              {[
                {
                  label: 'Services',
                  value: services.length,
                  sub: `${new Set(services.map((s) => s.repoProject)).size} projects`,
                  color: 'text-info',
                },
                {
                  label: 'Total Nodes',
                  value: totalNodes.toLocaleString(),
                  sub: `${totalEdges.toLocaleString()} edges`,
                  color: 'text-ok',
                },
                {
                  label: 'Entry Points',
                  value: totalEntryPoints,
                  sub: 'routes + listeners',
                  color: 'text-accent2',
                },
                {
                  label: 'Analyzed',
                  value: services.filter((s) => s.indexedAt).length,
                  sub: `of ${services.length}`,
                  color: 'text-warn',
                },
                {
                  label: 'Needs Attention',
                  value: stale,
                  sub: 'stale or never',
                  color: 'text-err',
                },
              ].map((c) => (
                <div key={c.label} className="border-border rounded-xl border bg-surface p-5">
                  <div className="text-text2 text-xs tracking-wide uppercase">{c.label}</div>
                  <div className={`mt-1 text-3xl font-bold ${c.color}`}>{c.value}</div>
                  <div className="text-text2 mt-1 text-xs">{c.sub}</div>
                </div>
              ))}
            </div>

            {/* Active analyze jobs */}
            {activeJobs.size > 0 && (
              <div className="mb-6">
                <h3 className="mb-3 font-medium">🔄 Active Analysis</h3>
                <div className="space-y-2">
                  {[...activeJobs.values()].map((job) => (
                    <div
                      key={job.serviceId}
                      className={`border-border rounded-lg border p-4 ${job.done ? (job.error ? 'border-err/30 bg-err/5' : 'border-ok/30 bg-ok/5') : 'border-accent/30 bg-accent/5'}`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-medium">{job.serviceId}</span>
                        {!job.done && (
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                        )}
                        {job.done && !job.error && (
                          <span className="text-ok text-sm">✅ Complete</span>
                        )}
                        {job.done && job.error && (
                          <span className="text-err text-sm">❌ Failed</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        {job.steps.map((s, i) => (
                          <div key={i} className="flex items-center gap-1 text-xs">
                            <span>{stepIcon(s.status)}</span>
                            <span
                              className={
                                s.status === 'running' ? 'text-accent2 font-medium' : 'text-text2'
                              }
                            >
                              {s.step}
                            </span>
                            {s.detail && s.status === 'done' && (
                              <span className="text-text2">({s.detail})</span>
                            )}
                          </div>
                        ))}
                      </div>
                      {job.error && <div className="text-err mt-1 text-xs">{job.error}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Activity */}
            <h3 className="mb-3 font-medium">Recent Activity</h3>
            <div className="border-border overflow-hidden rounded-xl border bg-surface">
              <table className="w-full">
                <thead>
                  <tr className="bg-surface2">
                    {[
                      'Service',
                      'Project',
                      'Type',
                      'Entry Points',
                      'Status',
                      'Last Analyzed',
                      '',
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-text2 border-border border-b px-4 py-3 text-left text-[11px] tracking-wide uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...services]
                    .sort((a, b) => (b.indexedAt || '').localeCompare(a.indexedAt || ''))
                    .slice(0, 15)
                    .map((s) => (
                      <tr key={s.id} className="hover:bg-accent/5">
                        <td className="border-border border-b px-4 py-3 font-medium">
                          <Link to={`/services/${s.id}`} className="hover:text-accent2">
                            {s.name || s.id}
                          </Link>
                        </td>
                        <td className="border-border border-b px-4 py-3">
                          <span className="text-accent2 rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-medium">
                            {s.repoProject}
                          </span>
                        </td>
                        <td className="border-border text-text2 border-b px-4 py-3">{s.type}</td>
                        <td className="border-border border-b px-4 py-3">
                          {s.entryPointCount ? (
                            <span className="text-accent2 text-sm font-medium">
                              {s.entryPointCount}
                            </span>
                          ) : (
                            <span className="text-text2">—</span>
                          )}
                        </td>
                        <td className="border-border border-b px-4 py-3">
                          {statusBadge(s.indexedAt)}
                        </td>
                        <td className="border-border text-text2 border-b px-4 py-3">
                          {ago(s.indexedAt)}
                        </td>
                        <td className="border-border border-b px-4 py-3">
                          {!activeJobs.has(s.id) ? (
                            <button
                              onClick={() => analyzeService(s.id)}
                              className="text-text2 hover:text-accent2 text-xs transition-colors"
                              title="Analyze"
                            >
                              ⟳
                            </button>
                          ) : (
                            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                          )}
                        </td>
                      </tr>
                    ))}
                  {services.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-text2 px-4 py-8 text-center">
                        No services registered yet. Go to Services to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
