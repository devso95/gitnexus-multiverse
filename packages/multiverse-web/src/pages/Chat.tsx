import { useState, useRef, useEffect, FormEvent, KeyboardEvent } from 'react';
import { get, post, del } from '../api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  timestamp: number;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [model, setModel] = useState('');
  const [sessionId] = useState(() => `s_${Date.now()}`);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    get('/api/mv/chat/status')
      .then((r) => {
        setAvailable(r.available);
        setModel(r.model || '');
      })
      .catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text, timestamp: Date.now() }]);
    setLoading(true);

    try {
      const res = await post('/api/mv/chat', { message: text, sessionId });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.response,
          toolsUsed: res.toolsUsed,
          timestamp: Date.now(),
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `❌ Error: ${err.message}`, timestamp: Date.now() },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const clear = async () => {
    await del(`/api/mv/chat?sessionId=${sessionId}`).catch(() => {});
    setMessages([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (available === false) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-text2 max-w-md text-center">
          <div className="mb-2 text-4xl">🤖</div>
          <h2 className="mb-2 text-lg font-semibold">AI Chat Not Available</h2>
          <p className="text-sm">
            Set <code className="bg-surface2 rounded px-1">ANTHROPIC_BASE_URL</code> and{' '}
            <code className="bg-surface2 rounded px-1">ANTHROPIC_AUTH_TOKEN</code> env vars to
            enable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b bg-surface px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">🤖 AI Chat</h1>
          {model && <span className="text-text2 text-xs">{model}</span>}
        </div>
        <button
          onClick={clear}
          className="bg-surface2 border-border hover:bg-err/20 rounded border px-2.5 py-1 text-xs hover:text-white"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {!messages.length && (
          <div className="text-text2 mt-12 text-center">
            <div className="mb-3 text-3xl">⚡</div>
            <p className="mb-4 text-sm">Ask about your microservices architecture</p>
            <div className="mx-auto flex max-w-md flex-wrap justify-center gap-2">
              {[
                'Show me the service map',
                'What does flex-back do?',
                'Trace POST /api/v1/order/place',
                'Which services use Kafka?',
                'Find unresolved sinks',
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setInput(q);
                    setTimeout(() => send(), 50);
                  }}
                  className="bg-surface2 border-border rounded-lg border px-3 py-1.5 text-xs hover:bg-accent/20"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`mb-4 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
                m.role === 'user' ? 'bg-accent text-white' : 'border-border bg-surface2 border'
              }`}
            >
              {m.role === 'assistant' ? (
                <div
                  className="chat-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                />
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
              {m.toolsUsed?.length ? (
                <div className="text-text2 mt-2 flex flex-wrap gap-1 border-t border-white/10 pt-1.5">
                  {[...new Set(m.toolsUsed)].map((t) => (
                    <span
                      key={t}
                      className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
                    >
                      🔧 {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {loading && (
          <div className="mb-4 flex justify-start">
            <div className="border-border bg-surface2 rounded-xl border px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="animate-pulse">🔍</span>
                <span className="text-text2">Thinking...</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-border border-t bg-surface p-3">
        <form onSubmit={send} className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about your services..."
            rows={1}
            className="bg-surface2 border-border text-text flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="hover:bg-accent2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Minimal markdown renderer ──

function renderMarkdown(md: string): string {
  return (
    md
      // Code blocks
      .replace(
        /```(\w*)\n([\s\S]*?)```/g,
        '<pre class="bg-[#1a1b26] rounded-lg p-3 my-2 overflow-x-auto text-xs"><code>$2</code></pre>',
      )
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="bg-[#1a1b26] rounded px-1 py-0.5 text-xs">$1</code>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3 class="font-semibold mt-3 mb-1">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="font-semibold text-base mt-3 mb-1">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="font-bold text-lg mt-3 mb-1">$1</h1>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Tables
      .replace(/^\|(.+)\|$/gm, (match) => {
        const cells = match
          .split('|')
          .filter(Boolean)
          .map((c) => c.trim());
        if (cells.every((c) => /^[-:]+$/.test(c))) return ''; // separator row
        const tag = cells.every((c) => /^[-:]+$/.test(c)) ? 'th' : 'td';
        return `<tr>${cells.map((c) => `<${tag} class="border border-white/10 px-2 py-1 text-xs">${c}</${tag}>`).join('')}</tr>`;
      })
      .replace(/(<tr>[\s\S]*?<\/tr>\s*)+/g, '<table class="border-collapse my-2 w-full">$&</table>')
      // Lists
      .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal">$2</li>')
      // Line breaks
      .replace(/\n\n/g, '<br/><br/>')
      .replace(/\n/g, '<br/>')
  );
}
