import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { get, post } from '../api';
import type {
  Sink,
  SinksResponse,
  ResolveSinkBody,
  ResolveSinkResponse,
  ResolveSinksResponse,
} from '../types/multiverse-api';

type Filter = 'all' | 'resolved' | 'unresolved';
type TypeFilter = 'all' | 'http' | 'kafka' | 'rabbit' | 'redis';

export default function SinkExplorer() {
  const { id } = useParams<{ id: string }>();
  const [sinks, setSinks] = useState<Sink[]>([]);
  const [total, setTotal] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Sink | null>(null);
  const [resolving, setResolving] = useState<string | null>(null); // sinkId being resolved
  const [resolvingAll, setResolvingAll] = useState(false);
  const [resolveAllResult, setResolveAllResult] = useState<{
    resolved: number;
    total: number;
  } | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    get<SinksResponse>(`/api/mv/services/${id}/sinks`).then((r) => {
      setSinks(r.sinks || []);
      setTotal(r.total || 0);
      setResolvedCount(r.resolved || 0);
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const resolveSingle = async (sink: Sink, value?: string) => {
    setResolving(sink.id);
    try {
      const body: ResolveSinkBody = { sinkId: sink.id };
      if (value) body.value = value;
      const r = await post<ResolveSinkResponse>(`/api/mv/services/${id}/resolve-sink`, body);
      if (r.resolved) {
        const resolvedValue = r.value ?? value ?? null;
        const resolvedVia = r.via || (value ? 'manual' : 'llm-auto');
        setSinks((prev) =>
          prev.map((s) =>
            s.id === sink.id
              ? {
                  ...s,
                  resolved: resolvedValue,
                  resolvedVia,
                  confidence: value ? 0.9 : 0.7,
                  status: 'resolved',
                }
              : s,
          ),
        );
        setResolvedCount((prev) => prev + 1);
        if (selected?.id === sink.id)
          setSelected({
            ...selected,
            resolved: resolvedValue,
            resolvedVia,
            confidence: value ? 0.9 : 0.7,
            status: 'resolved',
          });
      }
    } catch {
      /* ignore */
    }
    setResolving(null);
    setShowManualInput(false);
    setManualValue('');
  };

  const resolveAll = async () => {
    setResolvingAll(true);
    setResolveAllResult(null);
    try {
      const r = await post<ResolveSinksResponse>(`/api/mv/services/${id}/resolve-sinks`);
      setResolveAllResult({ resolved: r.resolved, total: r.total });
      load(); // reload
    } catch {
      /* ignore */
    }
    setResolvingAll(false);
  };

  const filtered = sinks.filter((s) => {
    if (filter === 'resolved' && s.status !== 'resolved') return false;
    if (filter === 'unresolved' && s.status !== 'unresolved') return false;
    if (typeFilter !== 'all' && s.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.callee.toLowerCase().includes(q) ||
        s.method.toLowerCase().includes(q) ||
        (s.resolved || '').toLowerCase().includes(q) ||
        s.expr.toLowerCase().includes(q) ||
        s.file.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const typeColor = (t: string) =>
    t === 'http'
      ? 'bg-blue-500/20 text-blue-400'
      : t === 'kafka'
        ? 'bg-red-500/20 text-red-400'
        : t === 'rabbit'
          ? 'bg-purple-500/20 text-purple-400'
          : 'bg-orange-500/20 text-orange-400';
  const statusIcon = (s: string) => (s === 'resolved' ? '✅' : '❌');
  const confBar = (c: number) => {
    const w = Math.round(c * 100);
    const color =
      c >= 0.9
        ? 'bg-green-500'
        : c >= 0.7
          ? 'bg-blue-500'
          : c >= 0.5
            ? 'bg-yellow-500'
            : 'bg-red-500';
    return (
      <div className="bg-bg2 h-1.5 w-16 overflow-hidden rounded-full">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${w}%` }} />
      </div>
    );
  };

  const unresolvedCount = total - resolvedCount;
  const resolveRate = total > 0 ? Math.round((resolvedCount / total) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <div className="text-text2 mb-1 flex items-center gap-2 text-xs">
        <Link to="/services" className="hover:text-text1">
          Services
        </Link>
        <span>/</span>
        <Link to={`/services/${id}`} className="hover:text-text1">
          {id}
        </Link>
        <span>/</span>
        <span className="text-text1">Sinks</span>
      </div>

      {/* Header with resolution rate */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Sink Explorer — {id}</h1>
          <div className="mt-2 flex items-center gap-4">
            {/* Resolution rate bar */}
            <div className="flex items-center gap-2">
              <div className="bg-surface2 h-3 w-48 overflow-hidden rounded-full">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${resolveRate >= 80 ? 'bg-green-500' : resolveRate >= 50 ? 'bg-blue-500' : resolveRate >= 30 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${resolveRate}%` }}
                />
              </div>
              <span className="text-sm font-medium">{resolveRate}%</span>
              <span className="text-text2 text-xs">
                ({resolvedCount}/{total} resolved)
              </span>
            </div>
            <span className="text-text2 text-xs">
              {sinks.filter((s) => s.type === 'http').length} HTTP •
              {sinks.filter((s) => s.type === 'kafka').length} Kafka •
              {sinks.filter((s) => s.type === 'rabbit').length} Rabbit
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {resolveAllResult && (
            <span className="text-ok text-xs">
              ✓ {resolveAllResult.resolved}/{resolveAllResult.total} resolved
            </span>
          )}
          <button
            onClick={resolveAll}
            disabled={resolvingAll || unresolvedCount === 0}
            className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              resolvingAll
                ? 'text-accent2 cursor-wait bg-accent/30'
                : unresolvedCount === 0
                  ? 'bg-surface2 text-text2 cursor-not-allowed'
                  : 'bg-accent text-white hover:bg-accent/80'
            }`}
          >
            {resolvingAll ? (
              <>
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />{' '}
                Resolving...
              </>
            ) : (
              <>🤖 LLM Resolve All ({unresolvedCount})</>
            )}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        <input
          className="bg-bg2 border-border focus:border-info w-64 rounded border px-3 py-1.5 text-sm outline-none"
          placeholder="Search callee, method, file, topic..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {(['all', 'resolved', 'unresolved'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-1 text-xs ${filter === f ? 'bg-info/20 text-info' : 'bg-bg2 text-text2 hover:text-text1'}`}
            >
              {f === 'all'
                ? `All (${total})`
                : f === 'resolved'
                  ? `✅ (${resolvedCount})`
                  : `❌ (${unresolvedCount})`}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['all', 'http', 'kafka', 'rabbit', 'redis'] as TypeFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`rounded px-3 py-1 text-xs ${typeFilter === t ? 'bg-info/20 text-info' : 'bg-bg2 text-text2 hover:text-text1'}`}
            >
              {t === 'all' ? 'All' : t.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-text2 ml-auto text-xs">{filtered.length} results</span>
      </div>

      <div className="flex gap-4">
        {/* Sink list */}
        <div className="flex-1 space-y-1">
          {filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => {
                setSelected(s);
                setShowManualInput(false);
              }}
              className={`cursor-pointer rounded-lg border p-3 transition-colors ${selected?.id === s.id ? 'border-info bg-info/5' : 'border-border bg-bg1 hover:border-text2'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">{statusIcon(s.status)}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${typeColor(s.type)}`}
                >
                  {s.type.toUpperCase()}
                </span>
                <code className="text-text1 text-sm font-medium">{s.callee}</code>
                {resolving === s.id && (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                )}
                <span className="text-text2 ml-auto text-xs">{s.method || '—'}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                {s.resolved ? (
                  <span className="text-ok font-mono text-xs">→ {s.resolved}</span>
                ) : s.expr ? (
                  <span className="text-warn font-mono text-xs">expr: {s.expr}</span>
                ) : (
                  <span className="text-text2 text-xs">no target expression</span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  {confBar(s.confidence)}
                  <span className="text-text2 text-[10px]">{Math.round(s.confidence * 100)}%</span>
                </span>
              </div>
              <div className="text-text2 mt-0.5 flex items-center justify-between text-[10px]">
                <span className="truncate">
                  {s.file}:{s.line}
                </span>
                {s.resolvedVia && s.resolvedVia !== 'unresolvable' && (
                  <span className="text-accent2 ml-2 shrink-0">via {s.resolvedVia}</span>
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-text2 py-8 text-center">No sinks found</div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="bg-bg1 border-border sticky top-4 w-80 shrink-0 self-start rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-text2 text-xs tracking-wide uppercase">Sink Detail</h3>
              <button onClick={() => setSelected(null)} className="text-text2 hover:text-text1">
                ✕
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-text2 text-[10px] uppercase">Callee</div>
                <code className="text-info">{selected.callee}</code>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Method</div>
                <span>{selected.method || '—'}</span>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Type</div>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${typeColor(selected.type)}`}>
                  {selected.type.toUpperCase()}
                </span>
                <span className="text-text2 ml-2 text-xs">pattern: {selected.pattern}</span>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Target Expression</div>
                <code className="text-warn text-xs break-all">{selected.expr || '(none)'}</code>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Resolved Value</div>
                {selected.resolved ? (
                  <code className="text-ok text-xs break-all">{selected.resolved}</code>
                ) : (
                  <span className="text-err text-xs">Unresolved</span>
                )}
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Resolution Chain</div>
                <div className="mt-1 space-y-0.5 text-xs">
                  <div className="text-text2">
                    1. Detected:{' '}
                    <code className="text-text1">
                      {selected.callee}({selected.expr || '...'})
                    </code>
                  </div>
                  {selected.resolvedVia && selected.resolvedVia !== 'unresolvable' && (
                    <div className="text-text2">
                      2. Via: <span className="text-info">{selected.resolvedVia}</span>
                    </div>
                  )}
                  {selected.resolved && (
                    <div className="text-text2">
                      3. Resolved: <code className="text-ok">{selected.resolved}</code>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Confidence</div>
                <div className="flex items-center gap-2">
                  {confBar(selected.confidence)}
                  <span className="text-xs">{Math.round(selected.confidence * 100)}%</span>
                </div>
              </div>
              <div>
                <div className="text-text2 text-[10px] uppercase">Location</div>
                <code className="text-text2 text-[11px] break-all">
                  {selected.file}:{selected.line}
                </code>
              </div>

              {/* Action buttons */}
              {selected.status === 'unresolved' && (
                <div className="border-border space-y-2 border-t pt-3">
                  <button
                    onClick={() => resolveSingle(selected)}
                    disabled={resolving === selected.id}
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:bg-accent/30"
                  >
                    {resolving === selected.id ? (
                      <>
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />{' '}
                        Asking LLM...
                      </>
                    ) : (
                      '🤖 Resolve with LLM'
                    )}
                  </button>
                  {!showManualInput ? (
                    <button
                      onClick={() => setShowManualInput(true)}
                      className="bg-surface2 hover:bg-surface2/80 w-full rounded px-3 py-1.5 text-xs transition-colors"
                    >
                      ✏️ Set value manually
                    </button>
                  ) : (
                    <div className="space-y-1.5">
                      <input
                        className="bg-bg2 border-border w-full rounded border px-2 py-1 text-xs outline-none focus:border-accent"
                        placeholder={
                          selected.type === 'http' ? 'https://api.example.com/path' : 'topic-name'
                        }
                        value={manualValue}
                        onChange={(e) => setManualValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && manualValue)
                            resolveSingle(selected, manualValue);
                        }}
                        autoFocus
                      />
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            if (manualValue) resolveSingle(selected, manualValue);
                          }}
                          disabled={!manualValue}
                          className="bg-ok/20 text-ok hover:bg-ok/30 flex-1 rounded px-2 py-1 text-xs disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => {
                            setShowManualInput(false);
                            setManualValue('');
                          }}
                          className="bg-surface2 flex-1 rounded px-2 py-1 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {selected.status === 'resolved' && selected.resolvedVia && (
                <div className="border-border border-t pt-2">
                  <span className="text-text2 text-[10px]">
                    {selected.resolvedVia === 'manual' || selected.resolvedVia === 'manual-cached'
                      ? '📌 Manually resolved — persisted across re-analyze'
                      : selected.resolvedVia === 'llm-auto'
                        ? '🤖 LLM resolved — auto-saved for future runs'
                        : `⚙️ Auto-resolved via ${selected.resolvedVia}`}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
