import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get } from '../api';
import { marked } from 'marked';

const FILE_LABELS: Record<string, { icon: string; label: string }> = {
  'README.md': { icon: '📋', label: 'Overview' },
  'api-endpoints.md': { icon: '🔌', label: 'API Endpoints' },
  'messaging.md': { icon: '📡', label: 'Messaging' },
  'dependencies.md': { icon: '🔗', label: 'Dependencies' },
  'config.md': { icon: '⚙️', label: 'Config & Sinks' },
};

interface ServiceSummary {
  id: string;
  name: string;
}

export default function WikiViewer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [selected, setSelected] = useState(searchParams.get('service') || '');
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('README.md');
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    get<{ services: ServiceSummary[] }>('/api/mv/services').then((r) =>
      setServices(r.services || []),
    );
  }, []);

  // Load file list when service changes
  useEffect(() => {
    if (!selected) {
      setFiles([]);
      setMarkdown('');
      return;
    }
    setSearchParams({ service: selected });
    get<{ files: string[] }>(`/api/mv/wiki/md/${selected}`)
      .then((r) => {
        const f = r.files || [];
        setFiles(f);
        // Reset to README if available
        setActiveFile(f.includes('README.md') ? 'README.md' : f[0] || '');
      })
      .catch(() => setFiles([]));
  }, [selected]);

  // Load markdown content when file changes
  useEffect(() => {
    if (!selected || !activeFile) {
      setMarkdown('');
      return;
    }
    setLoading(true);
    const auth = sessionStorage.getItem('mv_auth') || '';
    fetch(`/api/mv/wiki/md/${selected}/${activeFile}`, {
      headers: auth ? { Authorization: `Basic ${auth}` } : {},
    })
      .then((r) => (r.ok ? r.text() : ''))
      .then((md) => {
        setMarkdown(md);
        setLoading(false);
      })
      .catch(() => {
        setMarkdown('');
        setLoading(false);
      });
  }, [selected, activeFile]);

  const html = useMemo(() => {
    if (!markdown) return '';
    return marked.parse(markdown, { async: false }) as string;
  }, [markdown]);

  return (
    <div className="flex h-full">
      {/* Left sidebar — service + file nav */}
      <div className="border-border flex w-64 shrink-0 flex-col border-r bg-surface">
        <div className="border-border border-b p-4">
          <select
            className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select a service...</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        </div>

        {selected && files.length > 0 && (
          <div className="flex-1 overflow-y-auto py-2">
            {files.map((f) => {
              const meta = FILE_LABELS[f] || { icon: '📄', label: f.replace('.md', '') };
              const isActive = f === activeFile;
              return (
                <button
                  key={f}
                  onClick={() => setActiveFile(f)}
                  className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors ${
                    isActive
                      ? 'text-accent2 border-l-2 border-accent bg-accent/10'
                      : 'text-text2 hover:bg-surface2 hover:text-text'
                  }`}
                >
                  <span>{meta.icon}</span>
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {selected && files.length === 0 && (
          <div className="text-text2 p-4 text-center text-sm">
            No wiki generated yet.
            <br />
            <span className="text-xs">Run analyze or generate wiki first.</span>
          </div>
        )}
      </div>

      {/* Main content — rendered markdown */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="text-text2 flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-2 text-4xl">📖</div>
              <div className="text-lg">Service Wiki</div>
              <div className="mt-1 text-sm">Select a service to view its documentation</div>
            </div>
          </div>
        ) : loading ? (
          <div className="text-text2 flex h-full items-center justify-center">
            <div className="text-sm">Loading...</div>
          </div>
        ) : html ? (
          <article
            className="wiki-content mx-auto max-w-4xl px-10 py-8"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="text-text2 flex h-full items-center justify-center">
            <div className="text-sm">No content available</div>
          </div>
        )}
      </div>
    </div>
  );
}
