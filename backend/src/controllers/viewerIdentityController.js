const { ROLES } = require('../config/accessControl');
const {
  defaultViewerIdentityService
} = require('../services/viewerIdentityService');
const { positiveInt } = require('../utils/validation');

const OPERATOR_ROLES = new Set([ROLES.STREAMER, ROLES.ADMIN]);

const ERROR_MESSAGES = Object.freeze({
  identity_automatic_classification_active: '自动识别结果仍然有效，不能人工覆盖',
  identity_binding_not_found: '未找到对应的 B 站绑定',
  identity_fallback_expiry_required: '补录大航海身份时必须填写未来的截止时间',
  identity_fallback_not_found: '未找到可撤销的人工补录',
  identity_fallback_owned_by_another_operator: '只能修改或撤销自己创建的补录',
  identity_invalid_fallback_reason: '请填写有效的补录原因',
  identity_invalid_fallback_role: '人工补录只能使用四种观众角色',
  identity_protected_role: '主播和管理员身份不能由自动同步或人工补录修改',
  identity_sync_rate_limited: '同步请求过于频繁，请稍后再试',
  identity_user_not_found: '未找到用户'
});

function requireOperator(req, res) {
  if (OPERATOR_ROLES.has(req.userRole)) return true;
  res.status(403).json({ message: '没有管理观众身份的权限' });
  return false;
}

function sendError(res, error) {
  const code = error.code || 'identity_operation_failed';
  return res.status(error.status || 400).json({
    message: ERROR_MESSAGES[code] || '观众身份操作失败',
    code
  });
}

exports.listUsers = async (req, res) => {
  if (!requireOperator(req, res)) return;
  res.json(await defaultViewerIdentityService.listIdentityUsers());
};

exports.listAudit = async (req, res) => {
  if (!requireOperator(req, res)) return;
  const userId = positiveInt(req.params.userId, { field: 'User ID' });
  res.json(await defaultViewerIdentityService.listAudit(userId));
};

exports.resync = async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const userId = positiveInt(req.params.userId, { field: 'User ID' });
    const result = await defaultViewerIdentityService.syncBinding({
      userId,
      bilibiliUid: req.params.bilibiliUid,
      force: true,
      refreshSnapshot: true,
      requireViewerTarget: req.userRole === ROLES.STREAMER
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.setFallback = async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await defaultViewerIdentityService.setManualFallback({
      actorUserId: req.userId,
      actorRole: req.userRole,
      targetUserId: positiveInt(req.params.userId, { field: 'User ID' }),
      bilibiliUid: req.params.bilibiliUid,
      role: String(req.body?.role || ''),
      reason: req.body?.reason,
      expiresAt: req.body?.expires_at
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.revokeFallback = async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const result = await defaultViewerIdentityService.revokeManualFallback({
      actorUserId: req.userId,
      actorRole: req.userRole,
      targetUserId: positiveInt(req.params.userId, { field: 'User ID' }),
      bilibiliUid: req.params.bilibiliUid
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

exports.__test__ = { ERROR_MESSAGES, OPERATOR_ROLES, requireOperator };
