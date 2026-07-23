import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authService, bilibiliService, permissionService } from '../services';
import { useSiteSettings } from '../context/SiteSettingsContext';

const featureIcons = {
  playlists: '🎵', marshmallows: '🍬', prizes: '🎁',
  siteConfig: '🎨', pointsAdmin: '⭐', prizesAdmin: '🎁',
  ordersAdmin: '📋', permissions: '🔐', songControl: '🎙️'
};

function Home() {
  const { siteSettings } = useSiteSettings();
  const [biliInfo, setBiliInfo] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const currentUser = authService.getCurrentUser();
  const isAuthenticated = authService.isAuthenticated();
  const isAdmin = isAuthenticated && currentUser?.role === 'admin';
  const canManage = (permission) => isAdmin || permissions.includes(permission);

  useEffect(() => {
    if (!siteSettings.bilibiliUid) {
      setBiliInfo(null);
      return;
    }
    bilibiliService.getInfo().then(setBiliInfo).catch(() => setBiliInfo(null));
  }, [siteSettings.bilibiliUid]);

  useEffect(() => {
    if (!isAuthenticated || isAdmin) {
      setPermissions([]);
      return;
    }
    permissionService.getMyPermissions()
      .then((result) => setPermissions(Array.isArray(result.permissions) ? result.permissions : []))
      .catch(() => setPermissions([]));
  }, [isAuthenticated, isAdmin]);

  const features = [
    { key: 'playlists', to: '/playlists', title: siteSettings.playlistCardTitle, description: siteSettings.playlistCardDescription },
    { key: 'marshmallows', to: '/marshmallows', title: siteSettings.marshmallowCardTitle, description: siteSettings.marshmallowCardDescription },
    ...(isAuthenticated ? [{ key: 'prizes', to: '/prizes', title: siteSettings.prizeCardTitle, description: siteSettings.prizeCardDescription }] : []),
    ...(canManage(permissionService.PERMISSIONS.SITE_CONFIG_MANAGE) ? [{ key: 'siteConfig', to: '/admin/site-config', title: '网站配置', description: '管理站点资料、首页文案与主题样式。', admin: true }] : []),
    ...(canManage(permissionService.PERMISSIONS.POINTS_MANAGE) ? [{ key: 'pointsAdmin', to: '/admin/points', title: '积分管理', description: '管理用户积分、导入记录和投喂折算。', admin: true }] : []),
    ...(canManage(permissionService.PERMISSIONS.PRIZE_MANAGE) ? [
      { key: 'prizesAdmin', to: '/admin/prizes', title: '兑换商品管理', description: '创建商品、维护图片、价格、库存和选项。', admin: true },
      { key: 'ordersAdmin', to: '/admin/prize-orders', title: '兑换订单管理', description: '处理兑换订单、收货信息和退款状态。', admin: true }
    ] : []),
    ...(canManage(permissionService.PERMISSIONS.LIVE_CONTROL_MANAGE) ? [
      { key: 'songControl', to: '/admin/song-requests', title: '点歌控制', description: '管理统一点歌队列、场次和历史记录。', admin: true }
    ] : []),
    ...(isAdmin ? [{ key: 'permissions', to: '/admin/permissions', title: '权限管理', description: '管理用户角色、功能权限和注册开关。', admin: true }] : [])
  ];

  return (
    <div className="container">
      <section className="home-intro home-intro-original">
        {biliInfo && <a className="bili-profile-link" href={`https://space.bilibili.com/${biliInfo.mid}`} target="_blank" rel="noopener noreferrer">
          <div className="bili-profile-card">
            <div className="bili-avatar-wrapper"><img src={biliInfo.face} alt={biliInfo.name} className="bili-avatar" referrerPolicy="no-referrer" /></div>
            <div className="bili-info-content">
              <div className="bili-username-row"><span className="bili-username">{biliInfo.name}</span><span className="bili-badge">UP主</span></div>
              <div className="bili-stats-row">
                <div className="bili-stat-item"><span className="bili-stat-value">{biliInfo.archive_count}</span><span className="bili-stat-label">投稿</span></div>
                <div className="bili-stat-item"><span className="bili-stat-value">{biliInfo.fans}</span><span className="bili-stat-label">粉丝</span></div>
                <div className="bili-stat-item"><span className="bili-stat-value">{biliInfo.likes}</span><span className="bili-stat-label">获赞</span></div>
              </div>
            </div>
          </div>
        </a>}
        <h1 className="page-title">{siteSettings.homeTitle}</h1>
        <p className="page-subtitle">{siteSettings.homeSubtitle?.trim() || biliInfo?.sign || ''}</p>
      </section>
      <section className="home-feature-grid home-feature-grid-original" aria-label="主要功能">
        {features.map((feature) => <Link key={feature.key} to={feature.to} className="home-feature-link">
          <article className={`card home-feature-card home-feature-card-original ${feature.admin ? 'home-feature-card-admin' : ''}`}>
            <span className="home-feature-icon" aria-hidden="true">{featureIcons[feature.key]}</span>
            <h2 className="card-title">{feature.title}</h2>
            <p className="card-description">{feature.description}</p>
          </article>
        </Link>)}
      </section>
    </div>
  );
}

export default Home;
