import { useEffect, useState, FormEvent } from 'react';
import { get, post, put, del } from '../api';

interface MatchStep {
  node: string;
  label: string | string[];
  from?: string;
  edge?: string;
  direction?: string;
  where?: Record<string, unknown>;
}

interface GraphRule {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  match: MatchStep[];
  emit: { name: string; topic?: string; type?: string };
}

export default function GraphRules() {
  const [rules, setRules] = useState<GraphRule[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editRule, setEditRule] = useState<GraphRule | null>(null);
  const [form, setForm] = useState({ id: '', name: '', type: 'job', matchJson: '', emitJson: '' });
  const [err, setErr] = useState('');

  const load = () => {
    get('/api/mv/config/rules').then((r) => setRules(r.rules || []));
  };
  useEffect(load, []);

  const toggle = async (r: GraphRule) => {
    await put(`/api/mv/config/rules/${r.id}`, { enabled: !r.enabled });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this rule?')) return;
    await del(`/api/mv/config/rules/${id}`);
    load();
  };

  const openEdit = (r: GraphRule) => {
    setEditRule(r);
    setForm({
      id: r.id,
      name: r.name,
      type: r.type,
      matchJson: JSON.stringify(r.match, null, 2),
      emitJson: JSON.stringify(r.emit, null, 2),
    });
    setShowAdd(true);
    setErr('');
  };

  const openAdd = () => {
    setEditRule(null);
    setForm({
      id: '',
      name: '',
      type: 'job',
      matchJson: JSON.stringify(
        [{ node: 'cls', label: 'Class', where: { name: { regex: '.*Handler$' } } }],
        null,
        2,
      ),
      emitJson: JSON.stringify({ name: '${cls.name}', topic: '${cls.name}' }, null, 2),
    });
    setShowAdd(true);
    setErr('');
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    let match: any, emit: any;
    try {
      match = JSON.parse(form.matchJson);
    } catch {
      setErr('Invalid match JSON');
      return;
    }
    try {
      emit = JSON.parse(form.emitJson);
    } catch {
      setErr('Invalid emit JSON');
      return;
    }
    try {
      if (editRule) {
        await put(`/api/mv/config/rules/${editRule.id}`, {
          name: form.name,
          type: form.type,
          match,
          emit,
        });
      } else {
        await post('/api/mv/config/rules', {
          id: form.id,
          name: form.name,
          type: form.type,
          match,
          emit,
          enabled: true,
        });
      }
      setShowAdd(false);
      setEditRule(null);
      load();
    } catch (ex: any) {
      setErr(ex.message);
    }
  };

  const typeBadge = (t: string) => {
    const cls =
      t === 'job'
        ? 'bg-kafka/15 text-kafka'
        : t === 'scheduled'
          ? 'bg-warn/15 text-warn'
          : t === 'kafka'
            ? 'bg-info/15 text-info'
            : 'bg-ok/15 text-ok';
    return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{t}</span>;
  };

  return (
    <>
      <div className="border-border flex items-center justify-between border-b bg-surface px-8 py-4">
        <h1 className="text-xl font-semibold">Entrypoint Patterns</h1>
        <button
          onClick={openAdd}
          className="hover:bg-accent2 rounded-lg bg-accent px-3 py-1.5 text-sm text-white"
        >
          + Add Rule
        </button>
      </div>
      <div className="p-8">
        <p className="text-text2 mb-4 text-sm">
          Language-agnostic entry point detection via graph pattern matching. Detect scheduled jobs,
          cron tasks, message listeners from any framework.
        </p>
        <div className="border-border overflow-hidden rounded-xl border bg-surface">
          <table className="w-full">
            <thead>
              <tr className="bg-surface2">
                {['Rule', 'Type', 'Match Steps', 'Emit', 'Enabled', 'Actions'].map((h) => (
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
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-accent/5">
                  <td className="border-border border-b px-4 py-3">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-text2 text-xs">{r.id}</div>
                  </td>
                  <td className="border-border border-b px-4 py-3">{typeBadge(r.type)}</td>
                  <td className="border-border text-text2 border-b px-4 py-3 text-sm">
                    {(r.match || []).map((s, i) => (
                      <span key={i} className="mr-1">
                        <span className="font-mono text-xs">
                          {s.node}:{Array.isArray(s.label) ? s.label.join('|') : s.label}
                        </span>
                        {s.from && (
                          <span className="text-text2 text-xs">
                            ←{s.edge}←{s.from}
                          </span>
                        )}
                        {i < r.match.length - 1 && ' → '}
                      </span>
                    ))}
                  </td>
                  <td className="border-border text-text2 max-w-[200px] truncate border-b px-4 py-3 font-mono text-xs">
                    {r.emit?.name || ''}
                  </td>
                  <td className="border-border border-b px-4 py-3">
                    <button
                      onClick={() => toggle(r)}
                      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs font-medium ${r.enabled ? 'bg-ok/15 text-ok' : 'bg-surface2 text-text2'}`}
                    >
                      {r.enabled ? '● Enabled' : '○ Disabled'}
                    </button>
                  </td>
                  <td className="border-border border-b px-4 py-3">
                    <div className="flex gap-1">
                      <button
                        onClick={() => openEdit(r)}
                        className="bg-surface2 border-border rounded border px-2 py-1 text-xs hover:bg-accent hover:text-white"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => remove(r.id)}
                        className="bg-surface2 border-border hover:bg-err rounded border px-2 py-1 text-xs hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
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
          onClick={() => {
            setShowAdd(false);
            setEditRule(null);
          }}
        >
          <form
            onSubmit={save}
            onClick={(e) => e.stopPropagation()}
            className="border-border w-[560px] space-y-3 rounded-xl border bg-surface p-6"
          >
            <h2 className="text-lg font-semibold">
              {editRule ? 'Edit Entrypoint Pattern' : 'Add Entrypoint Pattern'}
            </h2>
            {err && <div className="text-err text-sm">{err}</div>}
            {!editRule && (
              <input
                className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="ID (e.g. my-custom-job)"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                required
              />
            )}
            <input
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <select
              className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="job">Job</option>
              <option value="scheduled">Scheduled</option>
              <option value="cron">Cron</option>
              <option value="kafka">Kafka Listener</option>
              <option value="rabbit">Rabbit Listener</option>
              <option value="event">Event Listener</option>
            </select>
            <div>
              <label className="text-text2 mb-1 block text-xs">Match Steps (JSON)</label>
              <textarea
                className="bg-surface2 border-border text-text h-32 w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                value={form.matchJson}
                onChange={(e) => setForm({ ...form, matchJson: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="text-text2 mb-1 block text-xs">Emit Config (JSON)</label>
              <textarea
                className="bg-surface2 border-border text-text h-20 w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                value={form.emitJson}
                onChange={(e) => setForm({ ...form, emitJson: e.target.value })}
                required
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                className="hover:bg-accent2 flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white"
              >
                {editRule ? 'Save' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setEditRule(null);
                }}
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
