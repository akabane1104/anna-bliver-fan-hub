const db = require('../config/database');
const crypto = require('crypto');
const { verifyCaptcha } = require('../utils/aliyunCaptcha');
const { sendMarshmallowNotificationEmail } = require('../utils/emailService');
const { idList, positiveInt, stringValue } = require('../utils/validation');
const {
  publishMarshmallowSchema
} = require('../schemas/obsOverlaySchemas');
const {
  defaultObsOverlayEventService
} = require('../services/obsOverlayEventService');

// Create a new marshmallow
exports.createMarshmallow = async (req, res) => {
  try {
    const { title, sender_alias, content, captchaVerifyParam } = req.body;
    const safeTitle = stringValue(title, { field: 'Title', max: 200 });
    const safeSenderAlias = stringValue(sender_alias, { field: 'Sender alias', max: 100 }) || '匿名的猪小娜';
    const safeContent = stringValue(content, { field: 'Content', required: true, max: 10000 });
    // Optional auth: req.userId might be set if optionalAuth middleware is used
    const userId = req.userId || null;
    const uuid = crypto.randomUUID();

    // 未登录用户需要验证验证码
    if (!userId) {
      const captchaResult = await verifyCaptcha(captchaVerifyParam, process.env.ALIYUN_CAPTCHA_SCENE_ID);
      if (!captchaResult.success) {
        return res.status(400).json({ message: `验证码校验失败: ${captchaResult.message}`, captchaFailed: true });
      }
    }

    const [result] = await db.query(
      'INSERT INTO marshmallows (uuid, title, sender_alias, content, user_id) VALUES (?, ?, ?, ?, ?)',
      [uuid, safeTitle || null, safeSenderAlias, safeContent, userId]
    );

    try {
      await sendMarshmallowNotificationEmail({
        sender: safeSenderAlias,
        title: safeTitle || '无标题棉花糖',
        content: safeContent
      });
    } catch (emailError) {
      console.error('发送棉花糖提醒邮件失败:', emailError);
    }

    res.status(201).json({
      message: 'Marshmallow sent successfully',
      id: uuid // Return UUID instead of internal ID
    });
  } catch (error) {
    console.error('Error creating marshmallow:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Get current user's marshmallows
exports.getMyMarshmallows = async (req, res) => {
  try {
    const userId = req.userId;

    const [marshmallows] = await db.query(
      'SELECT * FROM marshmallows WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json(marshmallows);
  } catch (error) {
    console.error('Error fetching user marshmallows:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Bind a marshmallow to the current user
exports.bindMarshmallow = async (req, res) => {
  try {
    const { marshmallowId } = req.body;
    const userId = req.userId;

    if (!/^[0-9a-f-]{36}$/i.test(String(marshmallowId || ''))) {
      return res.status(400).json({ message: 'Marshmallow ID is required' });
    }

    // Check if marshmallow exists and is not already bound
    // Use UUID for lookup
    const [marshmallows] = await db.query(
      'SELECT * FROM marshmallows WHERE uuid = ?',
      [marshmallowId]
    );

    if (marshmallows.length === 0) {
      return res.status(404).json({ message: 'Marshmallow not found' });
    }

    if (marshmallows[0].user_id) {
      return res.status(400).json({ message: 'Marshmallow is already bound to a user' });
    }

    await db.query(
      'UPDATE marshmallows SET user_id = ? WHERE uuid = ?',
      [userId, marshmallowId]
    );

    res.json({ message: 'Marshmallow bound successfully' });
  } catch (error) {
    console.error('Error binding marshmallow:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Admin: Get all marshmallows
exports.getAllMarshmallows = async (req, res) => {
  try {
    const userId = req.userId;

    const [marshmallows] = await db.query(
      `SELECT m.*, u.username as sender_username, mr.read_at as user_read_at
       FROM marshmallows m
       LEFT JOIN users u ON m.user_id = u.id
       LEFT JOIN marshmallow_reads mr ON m.id = mr.marshmallow_id AND mr.user_id = ?
       ORDER BY m.created_at DESC`,
      [userId]
    );

    res.json(marshmallows);
  } catch (error) {
    console.error('Error fetching all marshmallows:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Admin: Mark marshmallow as read
exports.markAsRead = async (req, res) => {
  try {
    const id = positiveInt(req.params.id, { field: 'Marshmallow ID' });
    const userId = req.userId;

    await db.query(
      'INSERT IGNORE INTO marshmallow_reads (user_id, marshmallow_id) VALUES (?, ?)',
      [userId, id]
    );

    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Error marking marshmallow as read:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Admin: Delete marshmallows (batch)
exports.deleteMarshmallows = async (req, res) => {
  try {
    const ids = idList(req.body.ids, { field: 'Marshmallow IDs', max: 100 });

    await db.query(
      'DELETE FROM marshmallows WHERE id IN (?)',
      [ids]
    );

    res.json({ message: 'Marshmallows deleted successfully' });
  } catch (error) {
    console.error('Error deleting marshmallows:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

// Admin: Reply to a marshmallow
exports.replyMarshmallow = async (req, res) => {
  try {
    const id = positiveInt(req.params.id, { field: 'Marshmallow ID' });
    const replyContent = stringValue(req.body.reply_content, { field: 'Reply content', required: true, max: 10000 });

    await db.query(
      'UPDATE marshmallows SET reply_content = ?, reply_at = NOW(), is_read = FALSE WHERE id = ?',
      [replyContent, id]
    );

    res.json({ message: 'Reply sent successfully' });
  } catch (error) {
    console.error('Error replying to marshmallow:', error);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error' });
  }
};

exports.publishMarshmallowToObs = async (req, res) => {
  try {
    const id = positiveInt(req.params.id, { field: 'Marshmallow ID' });
    const validation = publishMarshmallowSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ message: 'OBS display settings are invalid' });
    }
    const [rows] = await db.query(
      `SELECT sender_alias, content, reply_content, created_at
       FROM marshmallows
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Marshmallow not found' });
    }
    const marshmallow = rows[0];
    const result = await defaultObsOverlayEventService.create({
      eventType: 'cotton_candy',
      source: 'manual',
      displayDurationMs: validation.data.displayDurationMs,
      idempotencyKey: validation.data.idempotencyKey,
      payload: {
        displayName: marshmallow.sender_alias || '匿名观众',
        content: marshmallow.content,
        reply: marshmallow.reply_content || null,
        createdAt: new Date(marshmallow.created_at).toISOString()
      }
    }, req.userId);
    return res.status(result.duplicate ? 200 : 201).json({
      status: result.duplicate ? 'duplicate' : 'created',
      event: result.event
    });
  } catch (error) {
    const status = Number(error?.status);
    return res.status(status >= 400 && status < 500 ? status : 500).json({
      message: status >= 400 && status < 500
        ? error.message
        : 'OBS event could not be created'
    });
  }
};
