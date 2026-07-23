const SENSITIVE_KEY_PATTERN = /(?:secret|signature|authorization|cookie|token|open_?id|union_?id|raw_?body|headers?)/i;

function redact(value, key = '', depth = 0) {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey, depth + 1);
  }
  return output;
}

function safeFailure(error, scenarioName = null) {
  return {
    status: 'failed',
    ...(scenarioName ? { scenario: scenarioName } : {}),
    error_code: typeof error?.code === 'string' ? error.code : 'simulator_error'
  };
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  redact,
  safeFailure
};
