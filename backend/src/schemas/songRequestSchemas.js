const { z } = require('zod');
const { ROOM_ID_PATTERN, SITE_ID_PATTERN } = require('../utils/liveEventConfig');
const { MAX_QUERY_LENGTH, normalizeSongText } = require('../utils/songText');

const positiveInt = z.number().int().positive().max(2147483647);
const version = z.number().int().min(0).max(2147483647);
const siteId = z.string().regex(SITE_ID_PATTERN);
const roomId = z.string().regex(ROOM_ID_PATTERN);
const publicId = z.string().uuid();
const query = z.string().min(1).max(MAX_QUERY_LENGTH).superRefine((value, context) => {
  try {
    normalizeSongText(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '歌名必须是安全、非空的单行文本'
    });
  }
});
const reason = z.string().trim().min(1).max(500).optional();
const reasonCode = z.enum([
  'identity_binding_required',
  'requests_closed',
  'queue_capacity_reached',
  'user_active_limit',
  'duplicate_in_queue',
  'song_cooldown',
  'already_sung_today',
  'song_temporarily_blocked',
  'special_event_only',
  'title_unclear',
  'song_not_found',
  'manual_rejection',
  'manual_skip',
  'technical_issue',
  'singer_unavailable',
  'other'
]).optional();
const publicReason = z.string().trim().max(200).optional();
const internalNote = z.string().trim().max(500).optional();
const publicIdParamSchema = z.object({ publicId }).strict();
const positiveIdParamSchema = z.object({
  id: z.coerce.number().int().positive().max(2147483647)
}).strict();

function requireTargetPair(value, context) {
  if (Boolean(value.site_id) !== Boolean(value.room_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.site_id ? ['room_id'] : ['site_id'],
      message: 'site_id and room_id must be provided together'
    });
  }
}

const websiteSongRequestSchema = z.object({
  site_id: siteId.optional(),
  room_id: roomId.optional(),
  song_id: positiveInt.optional(),
  query: query.optional()
}).strict().superRefine((value, context) => {
  if (!value.song_id && !value.query) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: 'song_id or query is required'
    });
  }
  requireTargetPair(value, context);
  if (!value.song_id && (!value.site_id || !value.room_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['song_id'],
      message: 'song_id is required when target is omitted'
    });
  }
});

const createSessionSchema = z.object({
  site_id: siteId,
  room_id: roomId,
  playlist_id: positiveInt,
  title: z.string().trim().min(1).max(200)
}).strict();

const targetQuerySchema = z.object({
  site_id: siteId,
  room_id: roomId
}).strict();

const optionalTargetQuerySchema = z.object({
  site_id: siteId.optional(),
  room_id: roomId.optional()
}).strict().superRefine(requireTargetPair);

const catalogQuerySchema = z.object({
  query: z.string().max(MAX_QUERY_LENGTH).optional().default(''),
  tag: z.string().trim().max(50).optional().default(''),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
}).strict();

const ownRequestsQuerySchema = z.object({
  status: z.enum([
    'pending_review',
    'queued',
    'singing',
    'completed',
    'skipped',
    'rejected',
    'withdrawn'
  ]).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
}).strict();

const withdrawRequestSchema = z.object({
  expected_revision: version.optional()
}).strict();

const rerequestSchema = z.object({}).strict();

const historyQuerySchema = z.object({
  query: z.string().trim().max(200).optional().default(''),
  status: z.enum([
    'pending_review',
    'singing',
    'withdrawn',
    'observed',
    'needs_match',
    'queued',
    'active',
    'completed',
    'rejected',
    'cancelled',
    'skipped',
    'failed'
  ]).optional(),
  source: z.enum([
    'bilibili_danmaku',
    'website',
    'manual',
    'simulation',
    'replay'
  ]).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
}).strict();

const sessionTransitionSchema = z.object({
  expected_version: version,
  reason
}).strict();

const manualRequestSchema = z.object({
  site_id: siteId,
  room_id: roomId,
  session_public_id: publicId.optional(),
  song_id: positiveInt.optional(),
  query: query.optional(),
  requester_display_name: z.string().trim().min(1).max(100).optional()
}).strict().superRefine((value, context) => {
  if (!value.song_id && !value.query) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: 'song_id or query is required'
    });
  }
});

const assignRequestSchema = z.object({
  session_public_id: publicId,
  expected_version: version,
  reason
}).strict();

const matchRequestSchema = z.object({
  song_id: positiveInt,
  expected_version: version,
  save_alias: z.boolean().optional().default(false),
  reason,
  reason_code: reasonCode,
  public_reason: publicReason,
  internal_note: internalNote
}).strict();

const requestTransitionSchema = z.object({
  expected_version: version,
  reason,
  reason_code: reasonCode,
  public_reason: publicReason,
  internal_note: internalNote
}).strict();

const fulfillmentSchema = z.object({
  expected_version: version,
  fulfillment_type: z.enum(['sung', 'played']),
  reason,
  reason_code: reasonCode,
  public_reason: publicReason,
  internal_note: internalNote
}).strict();

const reorderSchema = z.object({
  expected_version: version,
  request_public_ids: z.array(publicId).min(1).max(500)
}).strict();

const aliasSchema = z.object({
  alias: query
}).strict();

const songRequestSettingsSchema = z.object({
  cooldown_minutes: z.number().int().min(0).max(10080).optional(),
  block_repeat_today: z.boolean().optional(),
  queue_limit: z.number().int().min(1).max(500),
  reopen_threshold: z.number().int().min(0).max(499),
  max_eta_minutes: z.number().int().min(1).max(1440),
  reopen_eta_minutes: z.number().int().min(0).max(1439),
  default_song_seconds: z.number().int().min(30).max(7200),
  buffer_seconds: z.number().int().min(0).max(600),
  eta_paused: z.boolean().optional(),
  active_event_tag_id: positiveInt.nullable().optional(),
  expected_revision: version
}).strict().superRefine((value, context) => {
  if (value.reopen_threshold >= value.queue_limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reopen_threshold'],
      message: 'reopen_threshold must be lower than queue_limit'
    });
  }
  if (value.reopen_eta_minutes >= value.max_eta_minutes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reopen_eta_minutes'],
      message: 'reopen_eta_minutes must be lower than max_eta_minutes'
    });
  }
});

const etaPauseSchema = z.object({
  paused: z.boolean(),
  expected_revision: version
}).strict();

const songPolicySchema = z.object({
  blocked: z.boolean(),
  public_reason: z.string().trim().max(200).optional(),
  internal_note: z.string().trim().max(500).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  special_event_tag_id: positiveInt.nullable().optional(),
  duration_override_seconds: z.number().int().min(30).max(7200).nullable().optional(),
  expected_version: version
}).strict().superRefine((value, context) => {
  if (value.blocked && !value.public_reason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['public_reason'],
      message: 'public_reason is required when blocking a song'
    });
  }
});

const undoSchema = z.object({
  expected_revision: z.number().int().positive()
}).strict();

function parseIdempotencyKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(normalized)) return null;
  return normalized;
}

module.exports = {
  aliasSchema,
  assignRequestSchema,
  createSessionSchema,
  catalogQuerySchema,
  fulfillmentSchema,
  historyQuerySchema,
  manualRequestSchema,
  matchRequestSchema,
  ownRequestsQuerySchema,
  optionalTargetQuerySchema,
  parseIdempotencyKey,
  positiveIdParamSchema,
  publicIdParamSchema,
  reorderSchema,
  requestTransitionSchema,
  rerequestSchema,
  sessionTransitionSchema,
  songPolicySchema,
  songRequestSettingsSchema,
  targetQuerySchema,
  undoSchema,
  websiteSongRequestSchema,
  withdrawRequestSchema,
  etaPauseSchema
};
