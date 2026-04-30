import { useEffect, useState, FormEvent } from 'react';
import { get, post, put, del } from '../api';

interface Pattern {
  id: string;
  name: string;
  category: string;
  methodPattern: string;
  targetArgIndex: number;
  enabled: boolean;
}

export default function SinkPatterns() {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    id: '',
    name: '',
    category: 'http',
    methodPattern: '',
    targetArgIndex: 0,
  });
  const [err, setErr] = useState('');

  const load = () => {
    get('/api/mv/config/patterns').then((r) => setPatterns(r.patterns || []));
  };
  useEffect(load, []);

  const toggle = async (p: Pattern) => {
    await put(`/api/mv/config/patterns/${p.id}`, { enabled: !p.enabled });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this pattern?')) return;
    await del(`/api/mv/config/patterns/${id}`);
    load();
  };

  const addPattern = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await post('/api/mv/config/patterns', { ...form, enabled: true });
      setShowAdd(false);
      setForm({ id: '', name: '', category: 'http', methodPattern: '', targetArgIndex: 0 });
      load();
    } catch (ex: any) {
      setErr(ex.message);
    }
  };

  const catBadge = (c: string) => {
    const cls =
      c === 'kafka'
        ? 'bg-kafka/15 text-kafka'
        : c === 'http'
          ? 'bg-info/15 text-info'
          : c === 'rabbit'
            ? 'bg-warn/15 text-warn'
            : 'bg-ok/15 text-ok';
    return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{c}</span>;
  };

  return (
    <>
      <div className="border-border flex items-center justify-between border-b bg-surface px-8 py-4">
        <h1 className="text-xl font-semibold">Sink Patterns</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="hover:bg-accent2 rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
        >
          + Add Pattern
        </button>
      </div>
      <div className="p-8">
        <div className="border-border overflow-hidden rounded-xl border bg-surface">
          <table className="w-full">
            <thead>
              <tr className="bg-surface2">
                {['Pattern', 'Category', 'Regex', 'Arg Index', 'Enabled', 'Actions'].map((h) => (
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
              {patterns.map((p) => (
                <tr key={p.id} className="hover:bg-accent/5">
                  <td className="border-border border-b px-4 py-3 font-medium">{p.name}</td>
                  <td className="border-border border-b px-4 py-3">{catBadge(p.category)}</td>
                  <td className="border-border text-text2 max-w-xs truncate border-b px-4 py-3 font-mono text-sm">
                    {p.methodPattern}
                  </td>
                  <td className="border-border text-text2 border-b px-4 py-3">
                    {p.targetArgIndex}
                  </td>
                  <td className="border-border border-b px-4 py-3">
                    <button
                      onClick={() => toggle(p)}
                      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium ${p.enabled ? 'bg-ok/15 text-ok' : 'bg-surface2 text-text2'}`}
                    >
                      {p.enabled ? '● Enabled' : '○ Disabled'}
                    </button>
                  </td>
                  <td className="border-border border-b px-4 py-3">
                    <button
                      onClick={() => remove(p.id)}
                      className="bg-surface2 border-border hover:bg-err rounded border px-2 py-1 text-xs hover:text-white"
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

      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowAdd(false)}
        >
          <form
            onSubmit={addPattern}
            onClick={(e) => e.stopPropagation()}
            className="border-border w-96 space-y-3 rounded-xl border bg-surface p-6"
          >
            <h2 className="text-lg font-semibold">Add Sink Pattern</h2>
            {err && <div className="text-err text-sm">{err}</div>}
            <input
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="ID (e.g. my-http-client)"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              required
            />
            <input
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <select
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              <option value="http">HTTP</option>
              <option value="kafka">Kafka</option>
              <option value="rabbit">RabbitMQ</option>
              <option value="redis">Redis</option>
              <option value="grpc">gRPC</option>
              <option value="jms">JMS</option>
              <option value="queue">Queue</option>
              <option value="sqs">SQS</option>
            </select>
            <input
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-accent"
              placeholder="Regex (e.g. myClient\.call)"
              value={form.methodPattern}
              onChange={(e) => setForm({ ...form, methodPattern: e.target.value })}
              required
            />
            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                className="hover:bg-accent2 flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="bg-surface2 border-border text-text flex-1 rounded-lg border py-2 text-sm"
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
