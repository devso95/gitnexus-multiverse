import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, LoginPage } from './auth';
import Layout from './layout';
import Dashboard from './pages/Dashboard';
import Services from './pages/Services';
import ServiceDetail from './pages/ServiceDetail';
import ServiceMap from './pages/ServiceMap';
import Channels from './pages/Channels';
import SinkPatterns from './pages/SinkPatterns';
import GraphRules from './pages/GraphRules';
import Chat from './pages/Chat';
import WikiViewer from './pages/WikiViewer';
import SinkExplorer from './pages/SinkExplorer';
import ConfigViewer from './pages/ConfigViewer';
import ManualResolutions from './pages/ManualResolutions';
import Settings from './pages/Settings';

function Protected({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : <Navigate to="/login" />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="services" element={<Services />} />
        <Route path="services/:id" element={<ServiceDetail />} />
        <Route path="services/:id/sinks" element={<SinkExplorer />} />
        <Route path="services/:id/config" element={<ConfigViewer />} />
        <Route path="map" element={<ServiceMap />} />
        <Route path="channels" element={<Channels />} />
        <Route path="patterns" element={<SinkPatterns />} />
        <Route path="manual-resolutions" element={<ManualResolutions />} />
        <Route path="rules" element={<GraphRules />} />
        <Route path="chat" element={<Chat />} />
        <Route path="wiki" element={<WikiViewer />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
