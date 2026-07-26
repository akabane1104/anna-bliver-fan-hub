const { z } = require('zod');

const safeText = (maxLength) => z.string()
  .trim()
  .max(maxLength)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    { message: '文字包含不允许的控制字符' }
  );
const isoDateTime = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const liveHomeOverrideSchema = z.object({
  mode: z.enum(['auto', 'force_live', 'force_offline']),
  expires_at: isoDateTime.nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.mode !== 'auto' && !value.expires_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expires_at'],
      message: '手动模式必须设置过期时间'
    });
  }
  if (value.mode === 'auto' && value.expires_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expires_at'],
      message: '自动模式不能设置过期时间'
    });
  }
});

const songRequestOpenSchema = z.object({
  open: z.boolean()
}).strict();

const liveHomeActivitySchema = z.object({
  enabled: z.boolean(),
  title: safeText(120),
  content: safeText(500),
  starts_at: isoDateTime.nullable(),
  ends_at: isoDateTime.nullable()
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.title || !value.content)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['title'],
      message: '启用活动时必须填写标题与内容'
    });
  }
  if (
    value.starts_at &&
    value.ends_at &&
    new Date(value.starts_at).getTime() >= new Date(value.ends_at).getTime()
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ends_at'],
      message: '结束时间必须晚于开始时间'
    });
  }
});

const liveHomeAdvanceSchema = z.object({
  expected_version: z.number().int().min(0).max(2147483647),
  outcome: z.enum(['completed', 'skipped']),
  activate_next: z.boolean(),
  reason: safeText(500).optional()
}).strict();

const listenerStatusReportSchema = z.object({
  report_id: z.string().uuid(),
  site_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  room_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  transport_state: z.enum([
    'connected',
    'connecting',
    'disconnected',
    'disabled',
    'unavailable'
  ]),
  authenticated: z.boolean(),
  reported_at: isoDateTime
}).strict().superRefine((value, context) => {
  if (value.authenticated && value.transport_state !== 'connected') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authenticated'],
      message: '只有已连接状态可以报告认证成功'
    });
  }
});

module.exports = {
  listenerStatusReportSchema,
  liveHomeActivitySchema,
  liveHomeAdvanceSchema,
  liveHomeOverrideSchema,
  songRequestOpenSchema
};
