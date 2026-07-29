const db = require('../config/database');
const {
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  VIEWER_ROLES,
  effectivePermissions,
  isAdminRole,
  isValidRole,
  permissionsForRole
} = require('../config/accessControl');
const {
  defaultViewerIdentityService
} = require('../services/viewerIdentityService');
const { positiveInt } = require('../utils/validation');

const TYPES = [
  [PERMISSIONS.PLAYLIST_MANAGE, '歌单管理'],
  [PERMISSIONS.MARSHMALLOW_MANAGE, '棉花糖管理'],
  [PERMISSIONS.PRIZE_MANAGE, '商城管理'],
  [PERMISSIONS.POINTS_MANAGE, '积分管理'],
  [PERMISSIONS.SITE_CONFIG_MANAGE, '网站配置'],
  [PERMISSIONS.LIVE_CONTROL_MANAGE, '点歌控制']
].map(([key, name]) => ({ key, name }));

function requireAdmin(req, res) {
  if (isAdminRole(req.userRole)) return true;
  res.status(403).json({ message: '仅管理员可以管理用户与权限' });
  return false;
}

function userPermissionDto(user, assignedPermissions) {
  return {
    ...user,
    role_label: ROLE_LABELS[user.role] || user.role,
    permissions: effectivePermissions(user.role, assignedPermissions),
    assigned_permissions: [...assignedPermissions].sort(),
    role_permissions: [...permissionsForRole(user.role)]
  };
}

exports.getPermissionTypes = (req, res) => res.json(TYPES);

exports.getMyPermissions = async (req, res) => {
  const [rows] = await db.query('SELECT permission_key FROM permissions WHERE user_id = ?', [req.userId]);
  res.json(userPermissionDto(
    { role: req.userRole },
    rows.map((row) => row.permission_key)
  ));
};

exports.getAllUsersWithPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.email, u.role,
            GROUP_CONCAT(p.permission_key ORDER BY p.permission_key) AS permissions
     FROM users u LEFT JOIN permissions p ON p.user_id = u.id
     GROUP BY u.id ORDER BY u.id DESC`
  );
  res.json(rows.map((row) => userPermissionDto(
    { ...row, permissions: undefined },
    row.permissions ? row.permissions.split(',') : []
  )));
};

exports.getUserPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = positiveInt(req.params.userId, { field: 'User ID' });
  const [users] = await db.query('SELECT id, username, email, role FROM users WHERE id = ?', [userId]);
  if (!users.length) return res.status(404).json({ message: '未找到用户' });
  const [permissions] = await db.query('SELECT permission_key FROM permissions WHERE user_id = ?', [userId]);
  res.json(userPermissionDto(
    users[0],
    permissions.map((row) => row.permission_key)
  ));
};

exports.updateUserPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = positiveInt(req.params.userId, { field: 'User ID' });
  const requested = [...new Set(Array.isArray(req.body.permissions) ? req.body.permissions : [])];
  const allowed = new Set(TYPES.map((item) => item.key));
  if (requested.some((key) => !allowed.has(key))) return res.status(400).json({ message: '包含未知权限' });
  const requestedRole = req.body.role == null ? null : String(req.body.role);
  if (requestedRole && !isValidRole(requestedRole)) return res.status(400).json({ message: '角色无效' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [targets] = await connection.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!targets.length) {
      const error = new Error('未找到用户');
      error.status = 404;
      throw error;
    }
    if (targets[0].role === ROLES.ADMIN && requestedRole && requestedRole !== ROLES.ADMIN) {
      const [admins] = await connection.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
      if (admins.length <= 1) {
        const error = new Error('不能降级最后一名管理员');
        error.status = 409;
        throw error;
      }
    }
    if (requestedRole) {
      await connection.query(
        'UPDATE users SET role = ? WHERE id = ?',
        [requestedRole, userId]
      );
      if (
        [ROLES.STREAMER, ROLES.ADMIN].includes(targets[0].role)
        && VIEWER_ROLES.includes(requestedRole)
      ) {
        await defaultViewerIdentityService.recomputeUserRole(
          userId,
          connection
        );
      }
    }
    await connection.query('DELETE FROM permissions WHERE user_id = ?', [userId]);
    for (const key of requested) {
      await connection.query('INSERT INTO permissions (user_id, permission_key) VALUES (?, ?)', [userId, key]);
    }
    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    res.status(error.status || 500).json({ message: error.status ? error.message : '更新用户权限失败' });
  } finally {
    connection.release();
  }
};
