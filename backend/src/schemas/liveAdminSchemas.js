const { z } = require('zod');
const { EVENT_MODES, EVENT_TYPES } = require('./liveEventSchema');

const emptyToUndefined = (value) => (
  typeof value === 'string' && value.trim() === '' ? undefined : value
);
const optionalDateTime = z.preprocess(
  emptyToUndefined,
  z.string().datetime({ offset: true }).optional()
);

const liveEventAdminQuerySchema = z.object({
  query: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).max(200).optional()
  ),
  event_type: z.preprocess(
    emptyToUndefined,
    z.enum(EVENT_TYPES).optional()
  ),
  status: z.preprocess(
    emptyToUndefined,
    z.literal('recorded').optional()
  ),
  source: z.preprocess(
    emptyToUndefined,
    z.enum(EVENT_MODES).optional()
  ),
  session: z.preprocess(
    emptyToUndefined,
    z.string().uuid().optional()
  ),
  start: optionalDateTime,
  end: optionalDateTime,
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
}).strict().superRefine((value, context) => {
  if (value.start && value.end && Date.parse(value.start) > Date.parse(value.end)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end'],
      message: '结束时间不能早于开始时间'
    });
  }
});

module.exports = {
  liveEventAdminQuerySchema
};
