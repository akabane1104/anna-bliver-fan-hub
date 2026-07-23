const db = require('../config/database');
const { PERMISSIONS } = require('../middleware/permissions');
const { positiveInt } = require('../utils/validation');

const VALID_ROLES = new Set(['user', 'premium', 'admin']);

const TYPES = [
  [PERMISSIONS.PLAYLIST_MANAGE, '歌单管理'],
  [PERMISSIONS.MARSHMALLOW_MANAGE, '棉花糖管理'],
  [PERMISSIONS.PRIZE_MANAGE, '商城管理'],
  [PERMISSIONS.POINTS_MANAGE, '积分管理'],
  [PERMISSIONS.SITE_CONFIG_MANAGE, '网站配置'],
  [PERMISSIONS.LIVE_CONTROL_MANAGE, '点歌控制']
].map(([key, name]) => ({ key, name }));

function requireAdmin(req, res) {
  if (req.userRole === 'admin') return true;
  res.status(403).json({ message: 'Admin access required' });
  return false;
}

exports.getPermissionTypes = (req, res) => res.json(TYPES);

exports.getMyPermissions = async (req, res) => {
  const [rows] = await db.query('SELECT permission_key FROM permissions WHERE user_id = ?', [req.userId]);
  res.json({ role: req.userRole, permissions: rows.map((row) => row.permission_key) });
};

exports.getAllUsersWithPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.email, u.role,
            GROUP_CONCAT(p.permission_key ORDER BY p.permission_key) AS permissions
     FROM users u LEFT JOIN permissions p ON p.user_id = u.id
     GROUP BY u.id ORDER BY u.id DESC`
  );
  res.json(rows.map((row) => ({ ...row, permissions: row.permissions ? row.permissions.split(',') : [] })));
};

exports.getUserPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = positiveInt(req.params.userId, { field: 'User ID' });
  const [users] = await db.query('SELECT id, username, email, role FROM users WHERE id = ?', [userId]);
  if (!users.length) return res.status(404).json({ message: 'User not found' });
  const [permissions] = await db.query('SELECT permission_key FROM permissions WHERE user_id = ?', [userId]);
  res.json({ ...users[0], permissions: permissions.map((row) => row.permission_key) });
};

exports.updateUserPermissions = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = positiveInt(req.params.userId, { field: 'User ID' });
  const requested = [...new Set(Array.isArray(req.body.permissions) ? req.body.permissions : [])];
  const allowed = new Set(TYPES.map((item) => item.key));
  if (requested.some((key) => !allowed.has(key))) return res.status(400).json({ message: 'Unknown permission' });
  const requestedRole = req.body.role == null ? null : String(req.body.role);
  if (requestedRole && !VALID_ROLES.has(requestedRole)) return res.status(400).json({ message: 'Invalid role' });

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [targets] = await connection.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!targets.length) {
      const error = new Error('User not found');
      error.status = 404;
      throw error;
    }
    if (targets[0].role === 'admin' && requestedRole && requestedRole !== 'admin') {
      const [admins] = await connection.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
      if (admins.length <= 1) {
        const error = new Error('Cannot demote the last administrator');
        error.status = 409;
        throw error;
      }
    }
    if (requestedRole) await connection.query('UPDATE users SET role = ? WHERE id = ?', [requestedRole, userId]);
    await connection.query('DELETE FROM permissions WHERE user_id = ?', [userId]);
    for (const key of requested) {
      await connection.query('INSERT INTO permissions (user_id, permission_key) VALUES (?, ?)', [userId, key]);
    }
    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to update user permissions' });
  } finally {
    connection.release();
  }
};
