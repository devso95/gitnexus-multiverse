import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { get, post } from '../api';
import type {
  EntryPoint,
  TraceResult,
  ServiceSummary,
  BusinessGroup,
  LinkTarget,
  IncomingCall,
  BusinessGroupResponse,
  OutgoingResponse,
  IncomingResponse,
  NodeDetailResponse,
  MatchEndpointResponse,
} from '../types/multiverse-api';
import {
  getEntryPointDisplayName,
  getEntryPointKind,
  getEntryPointKindMeta,
  getMethodToneClass,
} from '../lib/entrypoints';

type Tab = 'entrypoints' | 'outgoing' | 'incoming';

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [svc, setSvc] = useState<ServiceSummary | null>(null);
  const [tab, setTab] = useState<Tab>('entrypoints');
  const [groups, setGroups] = useState<BusinessGroup[]>([]);
  const [outgoing, setOutgoing] = useState<LinkTarget[]>([]);
  const [incoming, setIncoming] = useState<IncomingCall[]>([]);
  const [selectedEp, setSelectedEp] = useState<EntryPoint | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [genStatus, setGenStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');

  useEffect(() => {
    if (!id) return;
    get<ServiceSummary>(`/api/mv/services/${id}`).then(setSvc);
    post<BusinessGroupResponse>('/api/mv/tools/business-group', { service: id })
      .then((r) => setGroups(r.groups || []))
      .catch(() => {});
    post<OutgoingResponse>('/api/mv/tools/what-do-i-call', { service: id })
      .then((r) => setOutgoing(r.targets || r.results || []))
      .catch(() => {});
    post<IncomingResponse>('/api/mv/tools/who-calls-me', { service: id })
      .then((r) => setIncoming(r.callers || r.results || []))
      .catch(() => {});
  }, [id]);

  const traceEntry = async (epId: string) => {
    setTraceLoading(true);
    setSelectedEp({ id: epId });
    try {
      const r = await post<TraceResult>('/api/mv/tools/trace-flow', {
        entryPointId: epId,
        depth: 8,
      });
      setTrace(r);
      // Also get node detail
      if (id) {
        const detail = await get<NodeDetailResponse>(
          `/api/mv/graph/${id}/node/${encodeURIComponent(epId)}`,
        );
        setSelectedEp((prev) => ({ ...prev!, ...detail.node?.props, neighbors: detail.neighbors }));
      }
    } catch {
      setTrace(null);
    }
    setTraceLoading(false);
  };

  if (!svc) return <div className="text-text2 p-8">Loading...</div>;

  const totalEps = groups.reduce(
    (s: number, g) => s + (g.entrypoints?.length || g.entryPointIds?.length || 0),
    0,
  );
  const tabs: { key: Tab; label: string }[] = [
    { key: 'entrypoints', label: `Entry Points (${totalEps})` },
    { key: 'outgoing', label: `Outgoing (${outgoing.length})` },
    { key: 'incoming', label: `Incoming (${incoming.length})` },
  ];

  return (
    <>
      <div className="border-border border-b bg-surface px-8 py-4">
        <div className="text-text2 mb-1 text-sm">
          <Link to="/services" className="hover:text-accent2">
            Services
          </Link>{' '}
          / {svc.name || id}
        </div>
        <h1 className="text-xl font-semibold">{svc.name || id}</h1>
        <div className="text-text2 mt-2 flex gap-4 text-sm">
          <span>
            Project:{' '}
            <span className="text-accent2 rounded-full bg-accent/15 px-2 py-0.5 text-xs">
              {svc.repoProject}
            </span>
          </span>
          <span>Type: {svc.type}</span>
          <span>Nodes: {svc.nodeCount ?? '—'}</span>
          <span>Edges: {svc.edgeCount ?? '—'}</span>
          <span>Entry Points: {totalEps}</span>
          <span>
            Analyzed: {svc.indexedAt ? new Date(svc.indexedAt).toLocaleString() : 'Never'}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          <Link
            to={`/services/${id}/sinks`}
            className="rounded bg-red-500/10 px-3 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/20"
          >
            🔍 Sinks
          </Link>
          <Link
            to={`/services/${id}/config`}
            className="rounded bg-green-500/10 px-3 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/20"
          >
            ⚙️ Config
          </Link>
          <Link
            to={`/map?service=${id}`}
            className="rounded bg-purple-500/10 px-3 py-1 text-xs text-purple-400 transition-colors hover:bg-purple-500/20"
          >
            🗺️ Graph
          </Link>
          <Link
            to={`/wiki?service=${id}`}
            className="rounded bg-blue-500/10 px-3 py-1 text-xs text-blue-400 transition-colors hover:bg-blue-500/20"
          >
            📖 Wiki
          </Link>
          <button
            onClick={async () => {
              setGenStatus('generating');
              try {
                await post(`/api/mv/wiki/generate/${id}`, {});
                setGenStatus('done');
                setTimeout(() => setGenStatus('idle'), 3000);
              } catch {
                setGenStatus('error');
                setTimeout(() => setGenStatus('idle'), 3000);
              }
            }}
            disabled={genStatus === 'generating'}
            className="rounded bg-amber-500/10 px-3 py-1 text-xs text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
          >
            {genStatus === 'generating'
              ? '⏳ Generating...'
              : genStatus === 'done'
                ? '✅ Done!'
                : genStatus === 'error'
                  ? '❌ Failed'
                  : '📝 Gen Wiki'}
          </button>
        </div>
      </div>

      <div className="border-border flex border-b bg-surface px-8">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setSelectedEp(null);
              setTrace(null);
            }}
            className={`border-b-2 px-4 py-3 text-sm transition-colors ${tab === t.key ? 'text-accent2 border-accent' : 'text-text2 hover:text-text border-transparent'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 160px)' }}>
        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-8">
          {tab === 'entrypoints' && (
            <div className="space-y-4">
              {groups.length === 0 && (
                <div className="text-text2">No entry points found. Analyze the service first.</div>
              )}
              {groups.map((g, i: number) => (
                <div key={i} className="border-border overflow-hidden rounded-xl border bg-surface">
                  <div className="bg-surface2 flex items-center gap-2 px-4 py-3 text-sm font-medium">
                    📋 {g.name || 'Uncategorized'}
                    <span className="text-text2 text-xs">
                      ({g.entrypoints?.length || g.entryPointCount || 0})
                    </span>
                  </div>
                  <div className="divide-border divide-y">
                    {(g.entrypoints || []).map((ep) => {
                      const isSelected = selectedEp?.id === ep.id;
                      const method = ep.method || '';
                      const display = getEntryPointDisplayName(ep);
                      const kind = getEntryPointKind(ep);
                      const kindMeta = getEntryPointKindMeta(kind);
                      return (
                        <button
                          key={ep.id}
                          onClick={() => traceEntry(ep.id)}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/5 ${isSelected ? 'border-l-2 border-accent bg-accent/10' : ''}`}
                        >
                          {method && (
                            <span
                              className={`w-12 font-mono text-xs font-bold ${getMethodToneClass(method)}`}
                            >
                              {method}
                            </span>
                          )}
                          <span className="text-xs">{kindMeta.icon}</span>
                          <span className="text-text font-mono">{display}</span>
                          <span className="text-text2 ml-auto text-[10px] uppercase">
                            {ep.kindLabel || kindMeta.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'outgoing' && (
            <Table
              headers={['Source Method', 'Topic / URL', 'Target Service', 'Type', 'Confidence', '']}
              rows={outgoing}
              renderRow={(r: any) => [
                r.sourceName || r.source || r.from || '—',
                <span className="text-info font-mono">
                  {r.topic || r.url || r.targetEndpoint || '—'}
                </span>,
                <span className="font-medium">{r.targetService || r.service || '—'}</span>,
                <TypeBadge type={r.type} />,
                <ConfBadge value={r.confidence} />,
                r.transportId ? (
                  <button
                    className="bg-info/20 text-info hover:bg-info/30 rounded px-2 py-0.5 text-[10px]"
                    onClick={async () => {
                      try {
                        const result = await post<MatchEndpointResponse>(
                          `/api/mv/services/${id}/match-endpoint`,
                          {
                            transportId: r.transportId,
                          },
                        );
                        console.log('[match-endpoint]', JSON.stringify(result, null, 2));
                        if (result.matched) {
                          post<OutgoingResponse>('/api/mv/tools/what-do-i-call', { service: id })
                            .then((res) => setOutgoing(res.targets || res.results || []))
                            .catch(() => {});
                        } else {
                          alert('No match found. Check console (F12) for debug phases.');
                        }
                      } catch (err) {
                        console.error('[match-endpoint] error:', err);
                      }
                    }}
                  >
                    Match
                  </button>
                ) : (
                  '—'
                ),
              ]}
              empty="No outgoing calls found."
            />
          )}

          {tab === 'incoming' && (
            <Table
              headers={['Caller Service', 'Method', 'Endpoint', 'Type', 'Confidence']}
              rows={incoming}
              renderRow={(r: any) => [
                <span className="font-medium">{r.callerService || r.service || '—'}</span>,
                r.callerMethod || r.name || r.method || '—',
                <span className="text-info font-mono text-xs">
                  {r.url || r.topic || r.targetEndpoint || r.endpoint || '—'}
                </span>,
                <TypeBadge type={r.type} />,
                <ConfBadge value={r.confidence} />,
              ]}
              empty="No incoming calls found."
            />
          )}
        </div>

        {/* Right panel: entry point detail */}
        {tab === 'entrypoints' && selectedEp && (
          <div className="border-border w-96 shrink-0 overflow-y-auto border-l bg-surface">
            <div className="border-border border-b p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-text2 text-xs tracking-wide uppercase">
                  Entry Point Detail
                </span>
                <button
                  onClick={() => {
                    setSelectedEp(null);
                    setTrace(null);
                  }}
                  className="text-text2 hover:text-text text-xs"
                >
                  ✕
                </button>
              </div>
              <h3 className="text-sm font-semibold break-all">
                {getEntryPointDisplayName(selectedEp)}
              </h3>
              {(() => {
                const kind = getEntryPointKind(selectedEp);
                if (kind === 'OTHER') return null;
                const meta = getEntryPointKindMeta(kind);
                return (
                  <div className="text-text2 mt-1 text-xs">
                    {meta.icon} {selectedEp.kindLabel || meta.label}
                  </div>
                );
              })()}
              {selectedEp.description && (
                <div className="text-text2 mt-2 text-xs">{selectedEp.description}</div>
              )}
              {selectedEp.filePath && (
                <div className="text-text2 mt-1 font-mono text-[10px] break-all">
                  {selectedEp.filePath}
                  {selectedEp.startLine ? `:${selectedEp.startLine}` : ''}
                </div>
              )}
            </div>

            {traceLoading && <div className="text-text2 p-4 text-sm">Loading trace...</div>}

            {trace && (
              <>
                {/* Internal flow */}
                <div className="border-border border-b p-4">
                  <h4 className="text-text2 mb-2 text-xs tracking-wide uppercase">
                    Internal Flow ({trace.internalFlow.length})
                  </h4>
                  {trace.internalFlow.length === 0 && (
                    <div className="text-text2 text-xs">No internal calls traced.</div>
                  )}
                  <div className="space-y-1">
                    {trace.internalFlow.slice(0, 20).map((n, i: number) => (
                      <div key={i} className="flex items-center gap-1.5 py-0.5 text-xs">
                        <span className="text-text2">{i === 0 ? '●' : '→'}</span>
                        <span className="text-text">{n.name}</span>
                        {n.file && (
                          <span className="text-text2 ml-auto max-w-[120px] truncate text-[9px]">
                            {n.file.split('/').pop()}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Cross-service calls */}
                {trace.crossServiceCalls.length > 0 && (
                  <div className="border-border border-b p-4">
                    <h4 className="text-text2 mb-2 text-xs tracking-wide uppercase">
                      Cross-Service ({trace.crossServiceCalls.length})
                    </h4>
                    {trace.crossServiceCalls.map((c, i: number) => (
                      <div key={i} className="border-border/50 border-b py-1 text-xs last:border-0">
                        <div className="flex items-center gap-1">
                          <span className="text-info">→</span>
                          <span className="font-medium">
                            {c.targetService || c.targetName || '?'}
                          </span>
                          <TypeBadge type={c.type} />
                        </div>
                        {c.url && <div className="text-text2 ml-4 font-mono">{c.url}</div>}
                        {c.topic && <div className="text-text2 ml-4 font-mono">{c.topic}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Neighbors from graph */}
            {selectedEp.neighbors?.length! > 0 && (
              <div className="p-4">
                <h4 className="text-text2 mb-2 text-xs tracking-wide uppercase">
                  Graph Connections ({selectedEp.neighbors!.length})
                </h4>
                <div className="space-y-0.5">
                  {selectedEp.neighbors!.map((n, i: number) => (
                    <div key={i} className="flex items-center gap-1 py-0.5 text-[11px]">
                      <span className={n.direction === 'outgoing' ? 'text-info' : 'text-warn'}>
                        {n.direction === 'outgoing' ? '→' : '←'}
                      </span>
                      <span className="truncate">{n.name}</span>
                      <span className="text-text2 ml-auto text-[9px]">{n.relType}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// Reusable components
function TypeBadge({ type }: { type?: string }) {
  const t = type || 'http';
  const colors: Record<string, string> = {
    kafka: 'bg-kafka/15 text-kafka',
    rabbit: 'bg-purple-500/15 text-purple-400',
    redis: 'bg-red-500/15 text-red-400',
    activemq: 'bg-orange-500/15 text-orange-400',
    http: 'bg-info/15 text-info',
    soap: 'bg-amber-500/15 text-amber-400',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${colors[t] || colors.http}`}>{t}</span>
  );
}

function ConfBadge({ value }: { value?: number }) {
  if (value == null) return <span className="text-text2">—</span>;
  const c =
    value >= 0.9 ? 'text-ok' : value >= 0.7 ? 'text-info' : value >= 0.5 ? 'text-warn' : 'text-err';
  return <span className={`font-medium ${c}`}>{Math.round(value * 100)}%</span>;
}

function Table({
  headers,
  rows,
  renderRow,
  empty,
}: {
  headers: string[];
  rows: any[];
  renderRow: (r: any) => any[];
  empty: string;
}) {
  return (
    <div className="border-border overflow-hidden rounded-xl border bg-surface">
      <table className="w-full">
        <thead>
          <tr className="bg-surface2">
            {headers.map((h) => (
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
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-accent/5">
              {renderRow(r).map((cell: any, j: number) => (
                <td key={j} className="border-border border-b px-4 py-3 text-sm">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={headers.length} className="text-text2 px-4 py-8 text-center">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
