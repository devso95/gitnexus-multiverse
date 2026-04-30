import { useEffect, useState } from 'react';
import { get } from '../api';

export default function Attention() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    get('/api/mv/services').then((r) => {
      const svcs = r.services || [];
      const issues: any[] = [];
      for (const s of svcs) {
        if (!s.indexedAt) {
          issues.push({
            type: 'never',
            icon: '🔴',
            service: s.id,
            message: 'Never analyzed',
            action: 'Analyze',
          });
        } else {
          const h = (Date.now() - new Date(s.indexedAt).getTime()) / 3600000;
          if (h > 168)
            issues.push({
              type: 'stale',
              icon: '🟡',
              service: s.id,
              message: `Stale (${Math.floor(h / 24)} days)`,
              action: 'Re-analyze',
            });
        }
      }
      setItems(issues);
    });
  }, []);

  return (
    <>
      <div className="border-border border-b bg-surface px-8 py-4">
        <h1 className="text-xl font-semibold">Needs Attention</h1>
      </div>
      <div className="space-y-3 p-8">
        {items.length === 0 && (
          <div className="text-text2">✅ All services are healthy. Nothing needs attention.</div>
        )}
        {items.map((it, i) => (
          <div
            key={i}
            className="border-border flex items-center justify-between rounded-xl border bg-surface p-4"
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">{it.icon}</span>
              <div>
                <div className="font-medium">{it.service}</div>
                <div className="text-text2 text-sm">{it.message}</div>
              </div>
            </div>
            <button className="bg-surface2 border-border rounded-lg border px-3 py-1.5 text-sm hover:bg-accent hover:text-white">
              {it.action}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
