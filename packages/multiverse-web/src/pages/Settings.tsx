import { useEffect, useState } from 'react';
import { get, put } from '../api';

interface CLIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  cursorModel?: string;
  apiVersion?: string;
  isReasoningModel?: boolean;
}

export default function Settings() {
  const [config, setConfig] = useState<CLIConfig>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    get('/api/mv/config/llm').then((res) => {
      setConfig(res || {});
    });
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setConfig((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await put('/api/mv/config/llm', config);
      setMsg({ type: 'success', text: 'Settings saved successfully!' });
      setTimeout(() => setMsg(null), 3000);
    } catch (e: unknown) {
      setMsg({
        type: 'error',
        text: 'Error saving settings: ' + (e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 mx-auto max-w-[900px] p-8 duration-500">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-white">System Settings</h1>
        <p className="text-text/70 mt-2">
          Configure global preferences and AI provider connections.
        </p>
      </header>

      <div className="space-y-8">
        {/* LLM Section */}
        <section className="border-border overflow-hidden rounded-2xl border bg-surface shadow-xl">
          <div className="border-border bg-surface2/50 border-b px-6 py-4">
            <div className="flex items-center gap-2">
              <span className="text-xl">🤖</span>
              <h2 className="text-lg font-semibold text-white">LLM Configuration</h2>
            </div>
          </div>

          <div className="p-6">
            <div className="bg-info/10 border-info/20 mb-8 rounded-lg border p-4">
              <div className="flex gap-3">
                <span className="text-info text-lg">ℹ️</span>
                <p className="text-info/90 text-sm leading-relaxed">
                  These settings configure the LLM provider used by Multiverse AI tools. They are
                  persisted in your{' '}
                  <code className="bg-info/20 text-info rounded px-1.5 py-0.5">
                    ~/.gitnexus/config.json
                  </code>{' '}
                  file.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-text text-sm font-semibold">AI Provider</label>
                <select
                  name="provider"
                  value={config.provider || 'openai'}
                  onChange={handleChange}
                  className="border-border bg-surface2 text-text w-full rounded-lg border px-4 py-2.5 text-sm transition-all outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                >
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="azure">Azure</option>
                  <option value="custom">Custom / Ollama</option>
                  <option value="cursor">Cursor</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-text text-sm font-semibold">Model Name</label>
                <input
                  type="text"
                  name="model"
                  value={config.model || ''}
                  onChange={handleChange}
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet"
                  className="border-border bg-surface2 text-text placeholder:text-text2/50 w-full rounded-lg border px-4 py-2.5 text-sm transition-all outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <label className="text-text text-sm font-semibold">Base URL</label>
                <input
                  type="text"
                  name="baseUrl"
                  value={config.baseUrl || ''}
                  onChange={handleChange}
                  placeholder="e.g. https://api.openai.com/v1"
                  className="border-border bg-surface2 text-text placeholder:text-text2/50 w-full rounded-lg border px-4 py-2.5 text-sm transition-all outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <label className="text-text text-sm font-semibold">API Key</label>
                <div className="relative">
                  <input
                    type="password"
                    name="apiKey"
                    value={config.apiKey || ''}
                    onChange={handleChange}
                    placeholder="sk-..."
                    className="border-border bg-surface2 text-text placeholder:text-text2/50 w-full rounded-lg border px-4 py-2.5 text-sm transition-all outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                    <span className="text-text2/50">🔒</span>
                  </div>
                </div>
              </div>

              {config.provider === 'azure' && (
                <div className="space-y-2 md:col-span-2">
                  <label className="text-text text-sm font-semibold">API Version (Azure)</label>
                  <input
                    type="text"
                    name="apiVersion"
                    value={config.apiVersion || ''}
                    onChange={handleChange}
                    placeholder="2024-10-21"
                    className="border-border bg-surface2 text-text w-full rounded-lg border px-4 py-2.5 text-sm transition-all outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                </div>
              )}

              <div className="flex items-center gap-3 pt-2 md:col-span-2">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    name="isReasoningModel"
                    checked={config.isReasoningModel || false}
                    onChange={handleChange}
                    className="peer sr-only"
                  />
                  <div className="bg-surface2 peer border-border h-6 w-11 rounded-full border peer-checked:bg-accent peer-focus:outline-none after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white rtl:peer-checked:after:-translate-x-full"></div>
                  <span className="text-text ms-3 text-sm font-medium">Reasoning Model</span>
                </label>
                <span className="text-text2 text-[11px] font-medium">
                  (Enable for models like o1, o3-mini)
                </span>
              </div>
            </div>
          </div>

          <div className="border-border bg-surface2/30 flex items-center justify-between border-t px-6 py-6">
            <div>
              {msg && (
                <div
                  className={`animate-in fade-in slide-in-from-left-2 flex items-center gap-2 text-sm ${msg.type === 'success' ? 'text-ok' : 'text-err'}`}
                >
                  <span>{msg.type === 'success' ? '✅' : '❌'}</span>
                  {msg.text}
                </div>
              )}
            </div>
            <button
              onClick={handleSave}
              disabled={saving}
              className="group relative flex items-center gap-2 rounded-lg bg-accent px-8 py-2.5 text-sm font-semibold text-white transition-all hover:scale-[1.02] hover:bg-accent/90 active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {saving ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Saving...
                </>
              ) : (
                'Save Settings'
              )}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
