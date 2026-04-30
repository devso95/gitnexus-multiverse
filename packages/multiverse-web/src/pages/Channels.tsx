import { useEffect, useState } from 'react';
import { post } from '../api';

interface Channel {
  name: string;
  type: string;
  producers: { service: string; method: string }[];
  consumers: { service: string; listener: string }[];
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  api: { label: 'API', cls: 'bg-blue-500/20 text-blue-400' },
  kafka: { label: 'KAFKA', cls: 'bg-red-500/20 text-red-400' },
  rabbit: { label: 'RABBIT', cls: 'bg-purple-500/20 text-purple-400' },
  redis: { label: 'REDIS', cls: 'bg-orange-500/20 text-orange-400' },
};

export default function Channels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  useEffect(() => {
    post('/api/mv/tools/channels', {})
      .then((r) => setChannels(r.channels || []))
      .catch(() => {});
  }, []);

  const types = [...new Set(channels.map((c) => c.type))].sort();

  const filtered = channels.filter((ch) => {
    if (typeFilter !== 'all' && ch.type !== typeFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      ch.name.toLowerCase().includes(q) ||
      ch.producers.some((p) => p.service.toLowerCase().includes(q)) ||
      ch.consumers.some((c) => c.service.toLowerCase().includes(q))
    );
  });

  return (
    <>
      <div className="border-border border-b bg-surface px-8 py-4">
        <h1 className="text-xl font-semibold">Channels</h1>
        <div className="mt-2 flex items-center gap-3">
          <input
            className="bg-surface2 border-border text-text max-w-sm flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none focus:border-accent"
            placeholder="Search channels or services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-1">
            {[
              { v: 'all', l: 'All' },
              ...types.map((t) => ({ v: t, l: TYPE_BADGE[t]?.label || t.toUpperCase() })),
            ].map((o) => (
              <button
                key={o.v}
                onClick={() => setTypeFilter(o.v)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${typeFilter === o.v ? 'border-accent bg-accent text-white' : 'bg-surface2 border-border text-text2 hover:text-text'}`}
              >
                {o.l}
              </button>
            ))}
          </div>
          <span className="text-text2 text-sm">
            {filtered.length} of {channels.length}
          </span>
        </div>
      </div>
      <div className="space-y-3 p-8">
        {filtered.map((ch) => {
          const badge = TYPE_BADGE[ch.type] || {
            label: ch.type.toUpperCase(),
            cls: 'bg-gray-500/20 text-gray-400',
          };
          return (
            <div
              key={`${ch.type}:${ch.name}`}
              className="border-border rounded-lg border bg-surface p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                  {badge.label}
                </span>
                <code className="text-text1 text-sm font-medium">{ch.name}</code>
                <span className="text-text2 ml-auto text-xs">
                  {ch.producers.length} producers • {ch.consumers.length} consumers
                </span>
              </div>
              <div className="flex gap-8 text-xs">
                <div>
                  <div className="text-text2 mb-1 text-[10px] uppercase">Producers →</div>
                  {ch.producers.length ? (
                    ch.producers.map((p, i) => (
                      <div key={i} className="text-green-400">
                        {p.service} <span className="text-text2">({p.method})</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-text2">none detected</span>
                  )}
                </div>
                <div>
                  <div className="text-text2 mb-1 text-[10px] uppercase">→ Consumers</div>
                  {ch.consumers.length ? (
                    ch.consumers.map((c, i) => (
                      <div key={i} className="text-blue-400">
                        {c.service} <span className="text-text2">({c.listener})</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-text2">none detected</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="text-text2 py-8 text-center">
            {channels.length === 0
              ? 'No channels detected yet. Analyze services first.'
              : 'No channels match your filter.'}
          </div>
        )}
      </div>
    </>
  );
}
