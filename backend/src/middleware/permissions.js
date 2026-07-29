const db = require('../config/database');
const {
  PERMISSIONS,
  effectivePermissions,
  isAdminRole,
  roleHasPermission
} = require('../config/accessControl');

async function hasPermission(userId, key) {
  const [users] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  if (!users.length) return false;
  if (roleHasPermission(users[0].role, key)) return true;
  const [rows] = await db.query('SELECT id FROM permissions WHERE user_id = ? AND permission_key = ?', [userId, key]);
  return rows.length > 0;
}

async function getEffectivePermissions(userId, role = null) {
  let resolvedRole = role;
  if (!resolvedRole) {
    const [users] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
    resolvedRole = users[0]?.role;
  }
  const [rows] = await db.query(
    'SELECT permission_key FROM permissions WHERE user_id = ?',
    [userId]
  );
  return effectivePermissions(
    resolvedRole,
    rows.map((row) => row.permission_key)
  );
}

const requirePermission = (key) => async (req, res, next) => {
  try {
    if (await hasPermission(req.userId, key)) {
      req.grantedPermissions = [...new Set([...(req.grantedPermissions || []), key])];
      return next();
    }
    return res.status(403).json({ message: '没有执行此操作的权限' });
  } catch (error) {
    return next(error);
  }
};

const requireAdmin = (req, res, next) => {
  if (isAdminRole(req.userRole)) return next();
  return res.status(403).json({ message: '仅管理员可以执行此操作' });
};

module.exports = {
  PERMISSIONS,
  getEffectivePermissions,
  hasPermission,
  requireAdmin,
  requirePermission
};
