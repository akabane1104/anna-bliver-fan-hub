import React from 'react';
import { NavLink } from 'react-router';

const ITEMS = Object.freeze([
  ['/admin/live-status', '直播状态'],
  ['/admin/live-events', '事件记录'],
  ['/admin/song-requests', '点歌控制']
]);

function LiveAdminNav() {
  return (
    <nav className="live-admin-tabs" aria-label="直播管理">
      {ITEMS.map(([to, label]) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => (isActive ? 'active' : '')}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export default LiveAdminNav;
