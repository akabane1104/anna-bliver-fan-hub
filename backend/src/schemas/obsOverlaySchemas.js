const { z } = require('zod');

const EVENT_TYPES = Object.freeze([
  'gift_thanks',
  'guard_alert',
  'cotton_candy',
  'ai_bubble',
  'notice'
]);
const EVENT_SOURCES = Object.freeze(['manual', 'simulator']);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PUBLIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plainText(max) {
  return z.string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), {
      message: 'Only plain display text is allowed'
    });
}

const giftPayloadSchema = z.object({
  displayName: plainText(100),
  giftName: plainText(100),
  count: z.number().int().min(1).max(99999)
}).strict();

const guardPayloadSchema = z.object({
  displayName: plainText(100),
  guardText: plainText(100)
}).strict();

const cottonCandyPayloadSchema = z.object({
  displayName: plainText(100),
  content: plainText(1600),
  reply: plainText(1600).nullable().optional(),
  createdAt: z.string().datetime()
}).strict();

const aiBubblePayloadSchema = z.object({
  text: plainText(40),
  persona: z.enum(['sassy', 'sweet', 'normal'])
}).strict();

const noticePayloadSchema = z.object({
  text: plainText(240),
  style: z.enum(['info', 'success', 'warning']).default('info')
}).strict();

const payloadByType = Object.freeze({
  gift_thanks: giftPayloadSchema,
  guard_alert: guardPayloadSchema,
  cotton_candy: cottonCandyPayloadSchema,
  ai_bubble: aiBubblePayloadSchema,
  notice: noticePayloadSchema
});

const createEventSchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  source: z.enum(EVENT_SOURCES),
  payload: z.record(z.unknown()),
  displayDurationMs: z.number().int().min(1000).max(60000),
  idempotencyKey: z.string().regex(IDEMPOTENCY_PATTERN)
}).strict().superRefine((value, context) => {
  const result = payloadByType[value.eventType].safeParse(value.payload);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        ...issue,
        path: ['payload', ...issue.path]
      });
    }
  }
});

const publishMarshmallowSchema = z.object({
  displayDurationMs: z.number().int().min(1000).max(60000).default(12000),
  idempotencyKey: z.string().regex(IDEMPOTENCY_PATTERN)
}).strict();

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).strict();

function boundedQueryInteger(defaultValue, min, max) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max
      ? number
      : defaultValue;
  }, z.number().int());
}

const snapshotQuerySchema = z.object({
  maxItems: boundedQueryInteger(5, 1, 10),
  maxEvents: boundedQueryInteger(5, 1, 10)
}).strict();

const publicIdParamSchema = z.object({
  publicId: z.string().regex(PUBLIC_ID_PATTERN)
}).strict();

function parseEventPayload(eventType, payload) {
  return payloadByType[eventType].parse(payload);
}

module.exports = {
  EVENT_TYPES,
  createEventSchema,
  eventListQuerySchema,
  parseEventPayload,
  plainText,
  publishMarshmallowSchema,
  publicIdParamSchema,
  snapshotQuerySchema
};
