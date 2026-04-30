import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';

const nav = [
  { label: '📊 Dashboard', to: '/' },
  { label: '📦 Services', to: '/services' },
  { label: '🗺️ Service Map', to: '/map' },
  { section: 'Analysis' },
  { label: '📡 Channels', to: '/channels' },
  { section: 'Config' },
  { label: '🎯 Sink Patterns', to: '/patterns' },
  { label: '📌 Manual Resolutions', to: '/manual-resolutions' },
  { label: '🧩 Entrypoint Patterns', to: '/rules' },
  { section: 'Docs' },
  { label: '🤖 AI Chat', to: '/chat' },
  { label: '📖 Wiki', to: '/wiki' },
  { section: 'System' },
  { label: '⚙️ Settings', to: '/settings' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="border-border flex w-60 shrink-0 flex-col border-r bg-surface">
        <div className="border-border border-b p-5 text-lg font-bold">
          ⚡ <span className="text-accent2">Multiverse</span>
        </div>
        <div className="flex-1 overflow-y-auto py-3">
          {nav.map((n, i) =>
            'section' in n ? (
              <div
                key={i}
                className="text-text2 px-5 pt-4 pb-1 text-[11px] tracking-wider uppercase"
              >
                {n.section}
              </div>
            ) : (
              <NavLink
                key={n.to}
                to={n.to!}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-5 py-2.5 text-sm transition-colors ${isActive ? 'bg-accent text-white' : 'text-text2 hover:bg-surface2 hover:text-text'}`
                }
              >
                {n.label}
              </NavLink>
            ),
          )}
        </div>
        <div className="border-border flex items-center gap-2.5 border-t p-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-semibold">
            {user?.[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user}</div>
            <button onClick={logout} className="text-text2 hover:text-err text-[11px]">
              Logout
            </button>
          </div>
        </div>
      </nav>
      {/* Main */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
