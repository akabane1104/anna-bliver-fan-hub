import React from 'react';
import { Link } from 'react-router';
import { authService } from '../services';
import BackButton from '../components/BackButton';
import '../styles/App.css';
import { useSiteSettings } from '../context/SiteSettingsContext';

const MarshmallowHome = () => {
  const user = authService.getCurrentUser();
  const { siteSettings } = useSiteSettings();

  return (
    <div className="container">
      <BackButton to="/" />
      <h1 className="page-title">{siteSettings.marshmallowTitle}</h1>
      <p className="page-subtitle">{siteSettings.marshmallowSubtitle}</p>

      <div className="grid" style={{ maxWidth: '800px', margin: '0 auto' }}>
        <Link to="/marshmallows/write" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🍬</div>
            <h2 className="card-title">写棉花糖</h2>
            <p className="card-description">发送一个新的匿名棉花糖</p>
          </div>
        </Link>

        <Link to="/marshmallows/my" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📬</div>
            <h2 className="card-title">查看已发送</h2>
            <p className="card-description">查看我发送的棉花糖及回复</p>
          </div>
        </Link>

        {user && user.role === 'admin' && (
          <Link to="/admin/marshmallows" style={{ textDecoration: 'none' }}>
            <div className="card" style={{ textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '2px solid var(--primary-purple)' }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>👑</div>
              <h2 className="card-title">管理棉花糖</h2>
              <p className="card-description">查看和回复收到的棉花糖</p>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
};

export default MarshmallowHome;
