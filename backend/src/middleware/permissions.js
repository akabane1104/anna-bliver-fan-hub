const db = require('../config/database');

const PERMISSIONS = Object.freeze({
  PLAYLIST_MANAGE: 'playlist.manage',
  MARSHMALLOW_MANAGE: 'marshmallow.manage',
  PRIZE_MANAGE: 'prize.manage',
  POINTS_MANAGE: 'points.manage',
  SITE_CONFIG_MANAGE: 'site_config.manage',
  LIVE_CONTROL_MANAGE: 'live_control.manage'
});

async function hasPermission(userId, key) {
  const [users] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  if (users[0]?.role === 'admin') return true;
  const [rows] = await db.query('SELECT id FROM permissions WHERE user_id = ? AND permission_key = ?', [userId, key]);
  return rows.length > 0;
}

const requirePermission = (key) => async (req, res, next) => {
  try {
    if (await hasPermission(req.userId, key)) {
      req.grantedPermissions = [...new Set([...(req.grantedPermissions || []), key])];
      return next();
    }
    return res.status(403).json({ message: 'Permission denied' });
  } catch (error) {
    return next(error);
  }
};

module.exports = { PERMISSIONS, hasPermission, requirePermission };
