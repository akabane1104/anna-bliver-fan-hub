const db = require('../config/database');
const {
  generateLoginQRCode,
  pollQRCodeStatus
} = require('../utils/bilibiliApi');
const pointsService = require('../services/pointsService');
const {
  defaultViewerIdentityService,
  publicSyncStatus
} = require('../services/viewerIdentityService');

const QR_TTL_MS = 3 * 60 * 1000;
const sessions = new Map();

function clearTransientCredentials(result) {
  if (result?.cookies && typeof result.cookies === 'object') {
    for (const key of Object.keys(result.cookies)) delete result.cookies[key];
  }
  if (result && Object.prototype.hasOwnProperty.call(result, 'refreshToken')) {
    result.refreshToken = null;
  }
}

exports.createQr = async (req, res) => {
  const [bindings] = await db.query(
    `SELECT id FROM user_bilibili_bindings WHERE user_id = ? AND status = 'verified'`,
    [req.userId]
  );
  if (bindings.length >= pointsService.MAX_BINDINGS_PER_USER) {
    return res.status(409).json({
      message: `最多可绑定 ${pointsService.MAX_BINDINGS_PER_USER} 个 B 站账号`
    });
  }

  const result = await generateLoginQRCode();
  if (!result.success) {
    return res.status(502).json({ message: '暂时无法创建 B 站扫码会话' });
  }
  const expiresAt = Date.now() + QR_TTL_MS;
  sessions.set(result.qrcode_key, {
    userId: req.userId,
    expiresAt,
    consumed: false
  });
  setTimeout(() => sessions.delete(result.qrcode_key), QR_TTL_MS).unref?.();
  return res.status(201).json({
    qrcode_key: result.qrcode_key,
    url: result.url,
    expires_at: new Date(expiresAt).toISOString()
  });
};

exports.pollQr = async (req, res) => {
  const key = req.params.key;
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(key);
    return res.status(410).json({ status: 'expired', message: '二维码已过期' });
  }
  if (session.userId !== req.userId) {
    return res.status(404).json({ message: '扫码会话不存在' });
  }
  if (session.consumed) {
    return res.status(409).json({ message: '扫码会话已使用' });
  }

  const result = await pollQRCodeStatus(key);
  if (!result.success) return res.json({ status: result.status || 'pending' });

  session.consumed = true;
  const uid = String(
    result.cookies?.DedeUserID || result.userInfo?.mid || ''
  ).trim();
  if (!/^\d{1,20}$/.test(uid)) {
    clearTransientCredentials(result);
    sessions.delete(key);
    return res.status(502).json({ message: 'B 站未返回有效 UID' });
  }

  const transientCredentials = {
    cookies: result.cookies || {},
    refreshToken: result.refreshToken || null
  };
  let connection;
  let binding;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [mine] = await connection.query(
      `SELECT id
       FROM user_bilibili_bindings
       WHERE user_id = ? AND status = 'verified'
       FOR UPDATE`,
      [req.userId]
    );
    if (mine.length >= pointsService.MAX_BINDINGS_PER_USER) {
      throw new Error('BINDING_LIMIT');
    }

    const [existing] = await connection.query(
      `SELECT user_id
       FROM user_bilibili_bindings
       WHERE bilibili_uid = ? AND status = 'verified'
       FOR UPDATE`,
      [uid]
    );
    if (existing.some((row) => Number(row.user_id) !== Number(req.userId))) {
      throw new Error('UID_IN_USE');
    }
    if (existing.length) throw new Error('ALREADY_BOUND');

    const uname = String(
      result.userInfo?.name || result.userInfo?.uname || ''
    ).slice(0, 100);
    const face = String(result.userInfo?.face || '').slice(0, 500);
    await connection.query(
      `INSERT INTO user_bilibili_bindings (
         user_id, bilibili_uid, bilibili_uname, bilibili_face,
         status, is_primary, verified_at
       ) VALUES (?, ?, ?, ?, 'verified', ?, NOW())`,
      [req.userId, uid, uname, face, mine.length === 0 ? 1 : 0]
    );
    await pointsService.claimPointAccountForUser(
      req.userId,
      uid,
      uname,
      face,
      connection
    );
    await connection.commit();
    sessions.delete(key);
    binding = {
      bilibili_uid: uid,
      bilibili_uname: uname,
      bilibili_face: face,
      is_primary: mine.length === 0
    };
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    session.consumed = false;
    clearTransientCredentials(result);
    clearTransientCredentials(transientCredentials);
    const messages = {
      BINDING_LIMIT: '已达到五个 B 站账号的绑定上限',
      UID_IN_USE: '该 B 站账号已绑定到其他用户',
      ALREADY_BOUND: '该 B 站账号已绑定'
    };
    return res.status(409).json({
      message: messages[error.message] || '绑定失败'
    });
  } finally {
    connection?.release();
  }

  let identitySync = {
    status: 'unavailable',
    error_code: 'identity_source_not_configured'
  };
  try {
    identitySync = await defaultViewerIdentityService.syncBinding({
      userId: req.userId,
      bilibiliUid: uid,
      transientCredentials,
      force: true,
      refreshSnapshot: true
    });
  } catch (error) {
    identitySync = {
      status: 'failed',
      error_code: error.code || 'identity_sync_failed'
    };
  } finally {
    clearTransientCredentials(result);
    clearTransientCredentials(transientCredentials);
  }
  return res.json({
    status: 'success',
    binding,
    identity_sync: identitySync
  });
};

exports.getBindingStatus = async (req, res) => {
  const [[rows], [users]] = await Promise.all([
    db.query(
      `SELECT *
       FROM user_bilibili_bindings
       WHERE user_id = ? AND status = 'verified'
       ORDER BY is_primary DESC, verified_at ASC`,
      [req.userId]
    ),
    db.query('SELECT role FROM users WHERE id = ?', [req.userId])
  ]);
  const bindings = rows.map(publicSyncStatus);
  return res.json({
    bound: bindings.length > 0,
    binding_limit: pointsService.MAX_BINDINGS_PER_USER,
    role: users[0]?.role || null,
    bindings
  });
};

exports.setPrimary = async (req, res) => {
  try {
    await pointsService.setPrimaryBilibiliAccount(
      req.userId,
      req.params.bilibiliUid
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({
      message: error.message || '设置主账号失败'
    });
  }
};

exports.unbind = async (req, res) => {
  const uid = String(req.params.bilibiliUid || '').trim();
  const [rows] = await db.query(
    `SELECT is_primary
     FROM user_bilibili_bindings
     WHERE user_id = ? AND bilibili_uid = ? AND status = 'verified'`,
    [req.userId, uid]
  );
  if (!rows.length) {
    return res.status(404).json({ message: '未找到该绑定' });
  }
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM user_bilibili_bindings
     WHERE user_id = ? AND status = 'verified'`,
    [req.userId]
  );
  if (rows[0].is_primary && Number(countRows[0].total) > 1) {
    return res.status(409).json({ message: '请先将另一个账号设为主账号' });
  }
  await db.query(
    `DELETE FROM user_bilibili_bindings
     WHERE user_id = ? AND bilibili_uid = ?`,
    [req.userId, uid]
  );
  await pointsService.releasePointAccountForUser(req.userId, uid);
  await defaultViewerIdentityService.recomputeUserRole(req.userId);
  return res.json({ success: true });
};

exports.resync = async (req, res) => {
  try {
    const result = await defaultViewerIdentityService.syncBinding({
      userId: req.userId,
      bilibiliUid: req.params.bilibiliUid,
      refreshSnapshot: true
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 400).json({
      message: error.code === 'identity_sync_rate_limited'
        ? '同步请求过于频繁，请稍后再试'
        : '身份同步失败',
      code: error.code || 'identity_sync_failed'
    });
  }
};

exports.__test__ = {
  clearTransientCredentials,
  sessions,
  QR_TTL_MS
};
