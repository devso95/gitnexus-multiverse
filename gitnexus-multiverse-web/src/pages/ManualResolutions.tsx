import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, del } from '../api';

interface MR {
  id: string;
  serviceId: string;
  patternId: string;
  filePath: string;
  lineNumber: number;
  resolvedValue: string;
  sinkType: string;
  confidence: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export default function ManualResolutions() {
  const [items, setItems] = useState<MR[]>([]);
  const [filter, setFilter] = useState('');

  const load = () =>
    get('/api/mv/services/manual-resolutions').then((r) => setItems(r.items || []));

  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    if (!confirm('Delete this manual resolution?')) return;
    await del(`/api/mv/services/${id.split(':')[1]}/manual-resolutions/${encodeURIComponent(id)}`);
    load();
  };

  const filtered = filter
    ? items.filter(
        (m) =>
          m.serviceId.includes(filter) ||
          m.resolvedValue.includes(filter) ||
          m.filePath.includes(filter),
      )
    : items;

  const byService = filtered.reduce<Record<string, MR[]>>((acc, m) => {
    (acc[m.serviceId] ||= []).push(m);
    return acc;
  }, {});

  const typeColor: Record<string, string> = {
    http: 'text-info',
    kafka: 'text-kafka',
    activemq: 'text-orange-400',
    rabbit: 'text-purple-400',
    redis: 'text-red-400',
  };

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Manual Resolutions</h1>
          <p className="text-text2 text-sm">
            Cached sink resolutions that survive re-analyze. Applied automatically after bubble-up +
            LLM resolve.
          </p>
        </div>
        <span className="text-text2 text-sm">{items.length} total</span>
      </div>

      <input
        className="bg-surface2 border-border mb-4 w-full rounded border px-3 py-2 text-sm"
        placeholder="Filter by service, file, or value..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {Object.entries(byService).map(([svc, mrs]) => (
        <div key={svc} className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Link to={`/services/${svc}`} className="text-accent2 hover:underline">
              {svc}
            </Link>
            <span className="text-text2 font-normal">({mrs.length})</span>
          </h2>
          <div className="border-border overflow-hidden rounded border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface2 text-text2 text-left">
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">File</th>
                  <th className="px-3 py-2">Line</th>
                  <th className="px-3 py-2">Pattern</th>
                  <th className="px-3 py-2">Resolved Value</th>
                  <th className="px-3 py-2">Conf</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="w-16 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {mrs.map((m) => (
                  <tr key={m.id} className="border-border hover:bg-surface2/50 border-t">
                    <td
                      className={`px-3 py-1.5 font-mono ${typeColor[m.sinkType] || 'text-text2'}`}
                    >
                      {m.sinkType}
                    </td>
                    <td
                      className="text-text2 max-w-[200px] truncate px-3 py-1.5"
                      title={m.filePath}
                    >
                      {m.filePath.split('/').pop()}
                    </td>
                    <td className="px-3 py-1.5">{m.lineNumber}</td>
                    <td className="text-text2 px-3 py-1.5">{m.patternId}</td>
                    <td
                      className="max-w-[250px] truncate px-3 py-1.5 font-mono text-green-400"
                      title={m.resolvedValue}
                    >
                      {m.resolvedValue}
                    </td>
                    <td className="px-3 py-1.5">{m.confidence}</td>
                    <td className="text-text2 max-w-[120px] truncate px-3 py-1.5">
                      {m.note || '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        onClick={() => remove(m.id)}
                        className="text-red-400 hover:text-red-300"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {!filtered.length && (
        <div className="text-text2 py-12 text-center">
          No manual resolutions yet. Use <code className="text-accent2">resolve-sink</code> MCP tool
          or the Sinks page to create them.
        </div>
      )}
    </div>
  );
}
