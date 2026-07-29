const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const db = require('../config/database');
const { sendVerificationEmail } = require('../utils/emailService');
const { verifyCaptcha } = require('../utils/aliyunCaptcha');
const { isEmailVerificationEnabled } = require('../utils/optionalFeatures');
const pointsService = require('../services/pointsService');
const {
  defaultViewerIdentityService
} = require('../services/viewerIdentityService');
const { positiveInt } = require('../utils/validation');
const {
  ROLES,
  VIEWER_ROLES,
  isAdminRole,
  isValidRole
} = require('../config/accessControl');

// 生成6位随机验证码
function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// 发送邮箱验证码
exports.sendVerificationCode = async (req, res) => {
  try {
    const { email, username, captchaVerifyParam } = req.body;

    if (!isEmailVerificationEnabled()) {
      return res.status(404).json({
        message: '邮箱验证未启用',
        emailVerificationEnabled: false
      });
    }

    // 验证阿里云验证码
    const captchaResult = await verifyCaptcha(captchaVerifyParam, process.env.ALIYUN_CAPTCHA_SCENE_ID);
    if (!captchaResult.success) {
      return res.status(400).json({ message: `验证码校验失败: ${captchaResult.message}`, captchaFailed: true });
    }

    if (!email) {
      return res.status(400).json({ message: '请输入邮箱地址' });
    }

    // 验证邮箱格式
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: '请输入有效的邮箱地址' });
    }

    // 检查邮箱是否已注册
    const [existingEmail] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: '该邮箱已被注册' });
    }

    // 检查是否在60秒内已发送过验证码
    const [recentCode] = await db.query(
      'SELECT id FROM email_verification_codes WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)',
      [email]
    );
    if (recentCode.length > 0) {
      return res.status(429).json({ message: '请等待60秒后再次发送' });
    }

    // 生成验证码
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10分钟后过期

    // 将之前的验证码标记为已使用
    await db.query(
      'UPDATE email_verification_codes SET used = TRUE WHERE email = ? AND used = FALSE',
      [email]
    );

    // 存储新验证码
    await db.query(
      'INSERT INTO email_verification_codes (email, code, expires_at) VALUES (?, ?, ?)',
      [email, code, expiresAt]
    );

    // 发送邮件
    const displayName = username || email.split('@')[0];
    await sendVerificationEmail(email, displayName, code);

    res.json({ message: '验证码已发送' });
  } catch (error) {
    console.error('Send verification code error:', error);
    res.status(500).json({ message: '发送验证码失败，请稍后重试' });
  }
};


exports.register = async (req, res) => {
  let connection;
  try {
    const [settings] = await db.query(
      'SELECT setting_value FROM settings WHERE setting_key = ?',
      ['registration_open']
    );

    const isOpen = settings.length > 0 ? settings[0].setting_value === 'true' : true;

    if (!isOpen) {
      return res.status(403).json({ message: '当前未开放注册' });
    }

    const { username, email, password, verificationCode, captchaVerifyParam } = req.body;
    const emailVerificationEnabled = isEmailVerificationEnabled();

    if (!username || !email || !password || (emailVerificationEnabled && !verificationCode)) {
      return res.status(400).json({ message: '所有字段都是必填的' });
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: '请输入有效的邮箱地址' });
    }

    // 验证用户名：3-20个字符，只允许字母、数字、下划线、中文
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ message: '用户名长度需要在3-20个字符之间' });
    }
    const usernameRegex = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ message: '用户名只能包含字母、数字、下划线和中文' });
    }

    // 验证密码：10-64个字符，至少包含两种字符类型
    if (password.length < 10 || password.length > 64) {
      return res.status(400).json({ message: '密码长度需要在10-64个字符之间' });
    }
    let typeCount = 0;
    if (/[a-zA-Z]/.test(password)) typeCount++;
    if (/[0-9]/.test(password)) typeCount++;
    if (/[^a-zA-Z0-9]/.test(password)) typeCount++;
    if (typeCount < 2) {
      return res.status(400).json({ message: '密码需要包含字母、数字、特殊符号中的至少两种' });
    }

    if (!emailVerificationEnabled) {
      const captchaResult = await verifyCaptcha(captchaVerifyParam, process.env.ALIYUN_CAPTCHA_SCENE_ID);
      if (!captchaResult.success) {
        return res.status(400).json({ message: `验证码校验失败: ${captchaResult.message}`, captchaFailed: true });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    connection = await db.getConnection();
    await connection.beginTransaction();

    let validCodeId = null;
    if (emailVerificationEnabled) {
      const [validCodes] = await connection.query(
        'SELECT id FROM email_verification_codes WHERE email = ? AND code = ? AND used = FALSE AND expires_at > NOW() ORDER BY id DESC LIMIT 1 FOR UPDATE',
        [email, verificationCode]
      );
      if (!validCodes.length) {
        await connection.rollback();
        return res.status(400).json({ message: '验证码无效或已过期' });
      }
      validCodeId = validCodes[0].id;
    }

    const [existing] = await connection.query(
      'SELECT email, username FROM users WHERE email = ? OR username = ? FOR UPDATE',
      [email, username]
    );
    if (existing.some((row) => row.email === email)) {
      await connection.rollback();
      return res.status(409).json({ message: '该邮箱已被注册' });
    }
    if (existing.some((row) => row.username === username)) {
      await connection.rollback();
      return res.status(409).json({ message: '该用户名已被使用' });
    }

    const [result] = await connection.query(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );

    if (validCodeId) {
      await connection.query('UPDATE email_verification_codes SET used = TRUE WHERE id = ?', [validCodeId]);
    }
    await connection.commit();

    res.status(201).json({
      message: '注册成功',
      userId: result.insertId
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Register error:', error);
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: '邮箱或用户名已被注册' });
    res.status(500).json({ message: '服务器错误' });
  } finally {
    connection?.release();
  }
};

/*
exports.register = async (req, res) => {
  return res.status(403).json({ message: '注册功能已关闭' });
};
*/

exports.login = async (req, res) => {
  try {
    const { email, password, captchaVerifyParam } = req.body;

    // 验证阿里云验证码
    const captchaResult = await verifyCaptcha(captchaVerifyParam, process.env.ALIYUN_CAPTCHA_SCENE_ID);
    if (!captchaResult.success) {
      return res.status(400).json({ message: `验证码校验失败: ${captchaResult.message}`, captchaFailed: true });
    }

    if (!email || !password) {
      return res.status(400).json({ message: '请输入邮箱和密码' });
    }

    // Find user
    const [users] = await db.query(
      'SELECT id, username, email, password, role FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: '邮箱或密码错误' });
    }

    const user = users[0];

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ message: '邮箱或密码错误' });
    }

    try {
      await defaultViewerIdentityService.refreshUserIfStale(user.id);
      const [currentUsers] = await db.query(
        'SELECT role FROM users WHERE id = ?',
        [user.id]
      );
      if (currentUsers.length) user.role = currentUsers[0].role;
    } catch (error) {
      console.warn('[viewer-identity]', {
        code: 'login_refresh_failed',
        user_id: Number(user.id),
        error_code: error.code || 'identity_sync_failed'
      });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    const pointBalances = await pointsService.getUserPointBalances(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        ...pointBalances,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, username, email, role, created_at FROM users WHERE id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: '未找到用户' });
    }

    const pointBalances = await pointsService.getUserPointBalances(req.userId);

    res.json({
      ...users[0],
      ...pointBalances
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    // Check if requester is admin
    const [admins] = await db.query('SELECT role FROM users WHERE id = ?', [req.userId]);
    if (admins.length === 0 || !isAdminRole(admins[0].role)) {
      return res.status(403).json({ message: '仅管理员可以查看用户列表' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let query = 'SELECT id, username, email, role, created_at FROM users';
    let countQuery = 'SELECT COUNT(*) as total FROM users';
    let params = [];

    if (search) {
      const searchCondition = ' WHERE username LIKE ? OR email LIKE ?';
      query += searchCondition;
      countQuery += searchCondition;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const [totalResult] = await db.query(countQuery, params);
    const total = totalResult[0].total;

    const [users] = await db.query(query, params);

    res.json({
      users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

exports.updateUserRole = async (req, res) => {
  let connection;
  try {
    const { role } = req.body;
    const targetUserId = positiveInt(req.params.id, { field: 'User ID' });

    // Check if requester is admin
    const [admins] = await db.query('SELECT role FROM users WHERE id = ?', [req.userId]);
    if (admins.length === 0 || !isAdminRole(admins[0].role)) {
      return res.status(403).json({ message: '仅管理员可以修改用户角色' });
    }

    if (!isValidRole(role)) {
      return res.status(400).json({ message: '角色无效' });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    const [targets] = await connection.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [targetUserId]);
    if (!targets.length) {
      await connection.rollback();
      return res.status(404).json({ message: '未找到用户' });
    }
    if (targets[0].role === ROLES.ADMIN && role !== ROLES.ADMIN) {
      const [adminRows] = await connection.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
      if (adminRows.length <= 1) {
        await connection.rollback();
        return res.status(409).json({ message: '不能降级最后一名管理员' });
      }
    }

    await connection.query('UPDATE users SET role = ? WHERE id = ?', [role, targetUserId]);
    if (
      [ROLES.STREAMER, ROLES.ADMIN].includes(targets[0].role)
      && VIEWER_ROLES.includes(role)
    ) {
      await defaultViewerIdentityService.recomputeUserRole(
        targetUserId,
        connection
      );
    }
    await connection.commit();
    const [updatedUsers] = await db.query(
      'SELECT role FROM users WHERE id = ?',
      [targetUserId]
    );

    res.json({ message: '用户角色已更新', role: updatedUsers[0]?.role || role });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Update role error:', error);
    res.status(500).json({ message: '服务器错误' });
  } finally {
    connection?.release();
  }
};
