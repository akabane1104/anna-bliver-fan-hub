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

const historyQuerySchema = z.object({
  query: z.string().trim().max(200).optional().default(''),
  status: z.enum([
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
  reason
}).strict();

const requestTransitionSchema = z.object({
  expected_version: version,
  reason
}).strict();

const fulfillmentSchema = z.object({
  expected_version: version,
  fulfillment_type: z.enum(['sung', 'played']),
  reason
}).strict();

const reorderSchema = z.object({
  expected_version: version,
  request_public_ids: z.array(publicId).min(1).max(500)
}).strict();

const aliasSchema = z.object({
  alias: query
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
  optionalTargetQuerySchema,
  parseIdempotencyKey,
  positiveIdParamSchema,
  publicIdParamSchema,
  reorderSchema,
  requestTransitionSchema,
  sessionTransitionSchema,
  targetQuerySchema,
  websiteSongRequestSchema
};
