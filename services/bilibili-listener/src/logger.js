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
  'counters'
]);

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
  clock = Date.now
} = {}) {
  return {
    write(level, code, fields = {}) {
      const record = {
        timestamp: new Date(clock()).toISOString(),
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        code: safeErrorCode({ code }, 'listener_event'),
        component: 'bilibili-listener'
      };
      for (const [key, value] of Object.entries(fields)) {
        if (ALLOWED_FIELDS.has(key)) record[key] = sanitizeValue(key, value);
      }
      const frozenRecord = Object.freeze(record);
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
  createSafeLogger,
  sanitizeValue
};
