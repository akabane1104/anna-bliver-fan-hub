const { listenerError } = require('./errors');

const LOOPBACK_BASE_URL_PATTERN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;

function assertLoopbackBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw listenerError('invalid_backend_url');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    typeof value !== 'string' ||
    !LOOPBACK_BASE_URL_PATTERN.test(value) ||
    parsed.protocol !== 'http:' ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port === '0' ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw listenerError('remote_backend_rejected');
  }
  return parsed;
}

module.exports = {
  LOOPBACK_BASE_URL_PATTERN,
  assertLoopbackBaseUrl
};
