const { COUNTER_NAMES } = require('./status');
const { safeErrorCode } = require('./errors');

const ALLOWED_FIELDS = new Set([
  'state',
  'site_id',
  'instance_id',
  'room_id',
  'event_type',
  'queue_depth',
  'retry_attempt',
  'duration_ms',
  'event_fingerprint',
  'result',
  'error_code',
  'counters',
  'output'
]);
const RATE_LIMITED_CODES = new Set([
  'delivery_result',
  'delivery_retry',
  'official_event_ignored',
  'official_event_invalid',
  'queue_rejected',
  'source_event_invalid'
]);
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;

function sanitizeValue(key, value) {
  if (key === 'counters') {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(
      COUNTER_NAMES.map((name) => [name, Number(source[name] || 0)])
    );
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean' || value === null) return value;
  return String(value).slice(0, 128);
}

function createSafeLogger({
  sink = (record) => console.log(JSON.stringify(record)),
  clock = Date.now,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS
} = {}) {
  const buckets = new Map();
  return {
    write(level, code, fields = {}) {
      const now = clock();
      const record = {
        timestamp: new Date(now).toISOString(),
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        code: safeErrorCode({ code }, 'listener_event'),
        component: 'bilibili-listener'
      };
      for (const [key, value] of Object.entries(fields)) {
        if (
          ALLOWED_FIELDS.has(key) &&
          (key !== 'output' || record.code === 'ai_local_output')
        ) {
          record[key] = sanitizeValue(key, value);
        }
      }
      const frozenRecord = Object.freeze(record);
      if (
        RATE_LIMITED_CODES.has(record.code) &&
        Number.isInteger(rateLimitMax) &&
        rateLimitMax > 0 &&
        Number.isInteger(rateLimitWindowMs) &&
        rateLimitWindowMs > 0
      ) {
        let bucket = buckets.get(record.code);
        if (
          !bucket ||
          now < bucket.startedAt ||
          now - bucket.startedAt >= rateLimitWindowMs
        ) {
          bucket = { startedAt: now, count: 0 };
          buckets.set(record.code, bucket);
        }
        bucket.count += 1;
        if (bucket.count > rateLimitMax) return frozenRecord;
      }
      try {
        const result = sink(frozenRecord);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch {
        // Logging failures must never alter listener delivery or lifecycle.
      }
      return frozenRecord;
    }
  };
}

module.exports = {
  ALLOWED_FIELDS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  RATE_LIMITED_CODES,
  createSafeLogger,
  sanitizeValue
};
