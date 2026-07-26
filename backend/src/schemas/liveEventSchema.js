const { z } = require('zod');
const { ROOM_ID_PATTERN, SITE_ID_PATTERN } = require('../utils/liveEventConfig');

const EVENT_TYPES = Object.freeze([
  'danmaku',
  'gift',
  'super_chat',
  'guard_buy',
  'like',
  'room_enter',
  'live_start',
  'live_end'
]);
const EVENT_MODES = Object.freeze(['live', 'simulation', 'replay']);

const normalizeText = (value) => value.replace(/\r\n?/g, '\n').normalize('NFC');
const boundedText = (maxLength) => z.string()
  .max(maxLength)
  .transform(normalizeText)
  .refine((value) => value.trim().length > 0, { message: 'String must not be blank' });
const boundedOptionalText = (maxLength) => z.string().max(maxLength).transform(normalizeText).optional();
const normalizedIdentifier = (minLength, maxLength, pattern) => z.string()
  .trim()
  .min(minLength)
  .max(maxLength)
  .regex(pattern);
const platformIdentifier = z.string()
  .min(1)
  .max(128)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/);
const sourceIdentifier = normalizedIdentifier(1, 255, /^[A-Za-z0-9._:/-]+$/);
const decimalString = z.string().regex(/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,6})?$/);
const integerString = z.string().regex(/^(?:0|[1-9][0-9]{0,23})$/);
const isoDateTime = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const webUrl = z.string()
  .url()
  .max(500)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

const actorSchema = z.object({
  open_id: platformIdentifier,
  union_id: platformIdentifier.optional(),
  display_name: boundedOptionalText(100),
  avatar_url: webUrl.optional()
}).strict();

const deliverySchema = z.object({
  attempt: z.number().int().min(1).max(100000),
  replay: z.boolean(),
  trace_id: normalizedIdentifier(1, 128, /^[A-Za-z0-9._:/-]+$/).optional()
}).strict();

function sourceSchema(cmd, requireMessageId) {
  return z.object({
    platform: z.literal('bilibili_live_open'),
    cmd: z.literal(cmd),
    message_id: requireMessageId ? sourceIdentifier : sourceIdentifier.optional(),
    session_id: sourceIdentifier.optional()
  }).strict();
}

const commonFields = {
  schema_version: z.literal('1.0'),
  event_id: normalizedIdentifier(8, 255, /^[A-Za-z0-9._:/-]+$/),
  site_id: z.string().regex(SITE_ID_PATTERN),
  room_id: z.string().regex(ROOM_ID_PATTERN),
  mode: z.enum(EVENT_MODES),
  occurred_at: isoDateTime,
  received_at: isoDateTime,
  delivery: deliverySchema
};

function eventSchema(eventType, source, actor, payload) {
  return z.object({
    ...commonFields,
    event_type: z.literal(eventType),
    source,
    actor,
    payload
  }).strict();
}

const liveEventSchema = z.discriminatedUnion('event_type', [
  eventSchema(
    'danmaku',
    sourceSchema('LIVE_OPEN_PLATFORM_DM', true),
    actorSchema,
    z.object({
      text: boundedText(500),
      dm_type: z.enum(['text', 'emoji']).optional(),
      emoji_url: webUrl.optional()
    }).strict()
  ),
  eventSchema(
    'gift',
    sourceSchema('LIVE_OPEN_PLATFORM_SEND_GIFT', true),
    actorSchema,
    z.object({
      gift_id: normalizedIdentifier(1, 64, /^[A-Za-z0-9._:-]+$/),
      gift_name: boundedText(100),
      gift_num: z.number().int().min(1).max(1000000000),
      paid: z.boolean(),
      price: integerString,
      r_price: integerString.optional(),
      price_unit: z.literal('bilibili_price'),
      combo_gift: z.boolean().optional(),
      combo_info: z.object({
        combo_base_num: z.number().int().min(1).max(1000000000),
        combo_count: z.number().int().min(1).max(1000000000),
        combo_id: sourceIdentifier,
        combo_timeout: z.number().int().min(0).max(86400)
      }).strict().optional(),
      points_status: z.literal('not_processed').optional(),
      points_reason: z.literal(
        'official_open_id_account_mapping_unavailable'
      ).optional()
    }).strict().superRefine((payload, context) => {
      if (
        (payload.combo_gift === true) !== Boolean(payload.combo_info)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['combo_info'],
          message: 'Combo metadata must match combo_gift'
        });
      }
      if (
        (payload.points_status === undefined) !==
        (payload.points_reason === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points_reason'],
          message: 'Points status and reason must be provided together'
        });
      }
    })
  ),
  eventSchema(
    'super_chat',
    sourceSchema('LIVE_OPEN_PLATFORM_SUPER_CHAT', true),
    actorSchema,
    z.object({
      message_id: sourceIdentifier,
      message: boundedText(2000),
      rmb: decimalString,
      currency_unit: z.literal('CNY')
    }).strict()
  ),
  eventSchema(
    'guard_buy',
    sourceSchema('LIVE_OPEN_PLATFORM_GUARD', true),
    actorSchema,
    z.object({
      guard_level: z.enum(['1', '2', '3']),
      guard_num: z.number().int().min(1).max(1000000),
      guard_unit: boundedText(30),
      price: integerString,
      price_unit: z.literal('bilibili_guard_price')
    }).strict()
  ),
  eventSchema(
    'like',
    sourceSchema('LIVE_OPEN_PLATFORM_LIKE', false),
    actorSchema,
    z.object({
      like_count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    }).strict()
  ),
  eventSchema(
    'room_enter',
    sourceSchema('LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER', false),
    actorSchema,
    z.object({}).strict()
  ),
  eventSchema(
    'live_start',
    sourceSchema('LIVE_OPEN_PLATFORM_LIVE_START', false),
    actorSchema.nullable(),
    z.object({
      title: boundedOptionalText(200),
      area_name: boundedOptionalText(100)
    }).strict()
  ),
  eventSchema(
    'live_end',
    sourceSchema('LIVE_OPEN_PLATFORM_LIVE_END', false),
    actorSchema.nullable(),
    z.object({
      title: boundedOptionalText(200),
      area_name: boundedOptionalText(100)
    }).strict()
  )
]).superRefine((event, context) => {
  if ((event.mode === 'replay') !== event.delivery.replay) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['delivery', 'replay'],
      message: 'Replay delivery flag must match mode'
    });
  }
});

function validateLiveEvent(value) {
  return liveEventSchema.safeParse(value);
}

module.exports = {
  EVENT_MODES,
  EVENT_TYPES,
  liveEventSchema,
  validateLiveEvent
};
