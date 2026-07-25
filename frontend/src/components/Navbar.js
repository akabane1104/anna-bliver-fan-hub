import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { authService, permissionService } from '../services';
import { useSiteSettings } from '../context/SiteSettingsContext';
import BrandMark from './BrandMark';

function Navbar() {
  const navigate = useNavigate();
  const { siteSettings } = useSiteSettings();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [user, setUser] = useState(authService.getCurrentUser());
  const [canManageLiveControl, setCanManageLiveControl] = useState(false);
  const liveAdminMenuRef = useRef(null);
  const isAuthenticated = authService.isAuthenticated();

  useEffect(() => {
    const syncUser = () => setUser(authService.getCurrentUser());
    window.addEventListener('auth:userUpdated', syncUser);
    window.addEventListener('storage', syncUser);
    if (authService.isAuthenticated()) {
      authService.getProfile().then((profile) => {
        authService.setCurrentUser({ ...(authService.getCurrentUser() || {}), ...profile });
      }).catch(syncUser);
    }
    return () => {
      window.removeEventListener('auth:userUpdated', syncUser);
      window.removeEventListener('storage', syncUser);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !user) {
      setCanManageLiveControl(false);
      return;
    }
    if (user.role === 'admin') {
      setCanManageLiveControl(true);
      return;
    }
    permissionService.getMyPermissions()
      .then((result) => setCanManageLiveControl(
        result.permissions?.includes(permissionService.PERMISSIONS.LIVE_CONTROL_MANAGE)
      ))
      .catch(() => setCanManageLiveControl(false));
  }, [isAuthenticated, user]);

  const closeMenu = () => {
    setIsMenuOpen(false);
    if (liveAdminMenuRef.current) liveAdminMenuRef.current.open = false;
  };
  const logout = () => {
    authService.logout();
    closeMenu();
    navigate('/login');
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <div className="navbar-header">
          <Link to="/" className="navbar-brand" onClick={closeMenu} aria-label={siteSettings.siteTitle}>
            <BrandMark settings={siteSettings} />
          </Link>
          <button className="menu-icon" type="button" aria-label="切换导航" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)}>
            <span className={isMenuOpen ? 'bar open' : 'bar'} />
            <span className={isMenuOpen ? 'bar open' : 'bar'} />
            <span className={isMenuOpen ? 'bar open' : 'bar'} />
          </button>
        </div>
        <ul className={isMenuOpen ? 'navbar-links active' : 'navbar-links'}>
          <li><Link to="/playlists" onClick={closeMenu}>网页歌单</Link></li>
          <li><Link to="/marshmallows" onClick={closeMenu}>棉花糖</Link></li>
          {isAuthenticated && user ? <>
            <li><Link to="/prizes" onClick={closeMenu}>积分商城</Link></li>
            {canManageLiveControl && (
              <li className="navbar-admin-menu-item">
                <details className="navbar-admin-menu" ref={liveAdminMenuRef}>
                  <summary>直播管理</summary>
                  <div>
                    <Link to="/admin/live-status" onClick={closeMenu}>直播状态</Link>
                    <Link to="/admin/live-events" onClick={closeMenu}>事件记录</Link>
                    <Link to="/admin/song-requests" onClick={closeMenu}>点歌控制</Link>
                  </div>
                </details>
              </li>
            )}
            <li className="user-points"><span>积分 {user.points || 0}</span></li>
            <li><Link to="/profile" onClick={closeMenu}>个人资料</Link></li>
            <li><button onClick={logout} className="btn btn-outline">退出登录</button></li>
          </> : <>
            <li><Link to="/login" onClick={closeMenu}>登录</Link></li>
            <li><Link to="/register" onClick={closeMenu}>注册</Link></li>
          </>}
        </ul>
        {isMenuOpen && <button className="navbar-overlay" aria-label="关闭导航" onClick={closeMenu} />}
      </div>
    </nav>
  );
}

export default Navbar;
