import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { get } from '../api';

interface ConfigEntry {
  key: string;
  value: string;
}

export default function ConfigViewer() {
  const { id } = useParams<{ id: string }>();
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');

  useEffect(() => {
    if (!id) return;
    get(`/api/mv/services/${id}/config`).then((r) => {
      setEntries(r.config || []);
      setTotal(r.total || 0);
    });
  }, [id]);

  const categories = ['all', 'kafka', 'services', 'spring', 'other'];
  const categorize = (key: string) => {
    if (key.includes('kafka') || key.includes('topic')) return 'kafka';
    if (key.includes('services.') || key.includes('base-url')) return 'services';
    if (key.startsWith('spring.')) return 'spring';
    return 'other';
  };

  const filtered = entries.filter((e) => {
    if (category !== 'all' && categorize(e.key) !== category) return false;
    if (search) {
      const q = search.toLowerCase();
      return e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q);
    }
    return true;
  });

  const catColor = (c: string) => {
    if (c === 'kafka') return 'text-red-400';
    if (c === 'services') return 'text-blue-400';
    if (c === 'spring') return 'text-green-400';
    return 'text-text2';
  };

  const catCounts = categories.reduce(
    (acc, c) => {
      acc[c] = c === 'all' ? entries.length : entries.filter((e) => categorize(e.key) === c).length;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <div className="text-text2 mb-1 flex items-center gap-2 text-xs">
        <Link to="/services" className="hover:text-text1">
          Services
        </Link>
        <span>/</span>
        <Link to={`/services/${id}`} className="hover:text-text1">
          {id}
        </Link>
        <span>/</span>
        <span className="text-text1">Config</span>
      </div>

      <h1 className="mb-1 text-xl font-semibold">Config Viewer — {id}</h1>
      <p className="text-text2 mb-4 text-sm">
        {total} config keys (local YAML + Spring Cloud Config)
      </p>

      <div className="mb-4 flex items-center gap-3">
        <input
          className="bg-bg2 border-border focus:border-info w-72 rounded border px-3 py-1.5 text-sm outline-none"
          placeholder="Search key or value..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded px-3 py-1 text-xs ${category === c ? 'bg-info/20 text-info' : 'bg-bg2 text-text2 hover:text-text1'}`}
            >
              {c === 'all' ? `All (${catCounts.all})` : `${c} (${catCounts[c]})`}
            </button>
          ))}
        </div>
        <span className="text-text2 ml-auto text-xs">{filtered.length} results</span>
      </div>

      <div className="border-border overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg2 text-text2 text-xs uppercase">
              <th className="w-1/2 px-4 py-2 text-left">Key</th>
              <th className="w-1/2 px-4 py-2 text-left">Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr
                key={e.key}
                className={`border-border border-t ${i % 2 === 0 ? 'bg-bg1' : 'bg-bg0'} hover:bg-info/5`}
              >
                <td className="px-4 py-1.5">
                  <code className={`text-xs ${catColor(categorize(e.key))}`}>{e.key}</code>
                </td>
                <td className="px-4 py-1.5">
                  <code className="text-text1 text-xs break-all">{e.value}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-text2 py-8 text-center">No config entries found</div>
        )}
      </div>
    </div>
  );
}
