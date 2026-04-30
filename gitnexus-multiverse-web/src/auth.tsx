import { createContext, useContext, useState, ReactNode, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

interface AuthCtx {
  user: string | null;
  login: (u: string, p: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>({ user: null, login: async () => {}, logout: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const stored = sessionStorage.getItem('mv_auth');
  const [user, setUser] = useState<string | null>(stored ? atob(stored).split(':')[0] : null);

  const login = async (u: string, p: string) => {
    const token = btoa(`${u}:${p}`);
    const res = await fetch('/api/ops/health', { headers: { Authorization: `Basic ${token}` } });
    // health endpoint is no-auth, so test with services
    const res2 = await fetch('/api/mv/services', { headers: { Authorization: `Basic ${token}` } });
    if (!res2.ok) throw new Error('Invalid credentials');
    sessionStorage.setItem('mv_auth', token);
    setUser(u);
  };

  const logout = () => {
    sessionStorage.removeItem('mv_auth');
    setUser(null);
  };

  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await login(u, p);
      nav('/');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-bg flex min-h-screen items-center justify-center">
      <form
        onSubmit={submit}
        className="border-border w-80 space-y-4 rounded-xl border bg-surface p-8"
      >
        <div className="text-center text-xl font-bold">
          ⚡ <span className="text-accent2">Multiverse</span>
        </div>
        {err && <div className="text-err text-center text-sm">{err}</div>}
        <input
          className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 outline-none focus:border-accent"
          placeholder="Username"
          value={u}
          onChange={(e) => setU(e.target.value)}
          autoFocus
        />
        <input
          className="bg-surface2 border-border text-text w-full rounded-lg border px-3 py-2 outline-none focus:border-accent"
          type="password"
          placeholder="Password"
          value={p}
          onChange={(e) => setP(e.target.value)}
        />
        <button
          disabled={loading}
          className="hover:bg-accent2 w-full rounded-lg bg-accent py-2 font-medium text-white disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
