import React, { useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ProtectedRoute from './components/ProtectedRoute';
import SessionExpiredModal from './components/SessionExpiredModal';
import { FeedbackProvider } from './components/FeedbackProvider';
import { SiteSettingsProvider } from './context/SiteSettingsContext';
import { authService } from './services';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Playlists from './pages/Playlists';
import PlaylistDetail from './pages/PlaylistDetail';
import Prizes from './pages/PrizesWithCart';
import Profile from './pages/Profile';
import MarshmallowHome from './pages/MarshmallowHome';
import MarshmallowWrite from './pages/MarshmallowWrite';
import MarshmallowList from './pages/MarshmallowList';
import MarshmallowAdmin from './pages/MarshmallowAdmin';
import PermissionManagement from './pages/PermissionManagement';
import AdminPoints from './pages/AdminPoints';
import AdminPrizes from './pages/AdminPrizes';
import AdminPrizeOrders from './pages/AdminPrizeOrders';
import SiteConfig from './pages/SiteConfig/SiteConfig';
import SongRequestControl from './pages/SongRequestControl';
import LiveStatusAdmin from './pages/LiveStatusAdmin';
import LiveEventsAdmin from './pages/LiveEventsAdmin';
import './styles/App.css';
import './styles/AdminTheme.css';
import './styles/SongRequests.css';
import './styles/LiveAdmin.css';

const AuthVerifier = () => {
  const location = useLocation();
  const [isSessionExpired, setIsSessionExpired] = React.useState(false);

  useEffect(() => {
    const handleAuthExpired = () => setIsSessionExpired(true);
    window.addEventListener('auth:expired', handleAuthExpired);
    return () => window.removeEventListener('auth:expired', handleAuthExpired);
  }, []);

  useEffect(() => {
    if (authService.isAuthenticated() && location.pathname !== '/login') {
      authService.getProfile().catch(() => {});
    }
  }, [location.pathname]);

  const handleClose = () => {
    setIsSessionExpired(false);
    authService.logout();
    window.location.href = '/login';
  };

  return <SessionExpiredModal isOpen={isSessionExpired} onClose={handleClose} />;
};

const AdminRoute = ({ children }) => (
  <ProtectedRoute adminOnly={true}>{children}</ProtectedRoute>
);

const PermissionRoute = ({ permission, children }) => (
  <ProtectedRoute requiredPermissions={[permission]}>{children}</ProtectedRoute>
);

function App() {
  return (
    <SiteSettingsProvider>
      <Router>
        <FeedbackProvider>
          <div className="App app-shell">
            <AuthVerifier />
            <Navbar />
            <main className="app-main">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:id" element={<PlaylistDetail />} />
                <Route path="/marshmallows" element={<MarshmallowHome />} />
                <Route path="/marshmallows/write" element={<MarshmallowWrite />} />
                <Route path="/marshmallows/my" element={<ProtectedRoute><MarshmallowList /></ProtectedRoute>} />
                <Route path="/prizes" element={<ProtectedRoute><Prizes /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/admin/marshmallows" element={<ProtectedRoute requiredPermissions={['marshmallow.manage']}><MarshmallowAdmin /></ProtectedRoute>} />
                <Route path="/admin/permissions" element={<AdminRoute><PermissionManagement /></AdminRoute>} />
                <Route path="/admin/points" element={<PermissionRoute permission="points.manage"><AdminPoints /></PermissionRoute>} />
                <Route path="/admin/prizes" element={<PermissionRoute permission="prize.manage"><AdminPrizes /></PermissionRoute>} />
                <Route path="/admin/prizes/new" element={<PermissionRoute permission="prize.manage"><AdminPrizes /></PermissionRoute>} />
                <Route path="/admin/prizes/:prizeId/edit" element={<PermissionRoute permission="prize.manage"><AdminPrizes /></PermissionRoute>} />
                <Route path="/admin/prize-orders" element={<PermissionRoute permission="prize.manage"><AdminPrizeOrders /></PermissionRoute>} />
                <Route path="/admin/site-config" element={<PermissionRoute permission="site_config.manage"><SiteConfig /></PermissionRoute>} />
                <Route path="/admin/song-requests" element={<PermissionRoute permission="live_control.manage"><SongRequestControl /></PermissionRoute>} />
                <Route path="/admin/live-status" element={<PermissionRoute permission="live_control.manage"><LiveStatusAdmin /></PermissionRoute>} />
                <Route path="/admin/live-events" element={<PermissionRoute permission="live_control.manage"><LiveEventsAdmin /></PermissionRoute>} />
              </Routes>
            </main>
            <Footer />
          </div>
        </FeedbackProvider>
      </Router>
    </SiteSettingsProvider>
  );
}

export default App;
