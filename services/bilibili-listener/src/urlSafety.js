const { listenerError } = require('./errors');

const LOOPBACK_BASE_URL_PATTERN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;
const DOCKER_BACKEND_URL = 'http://backend:5000';

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

function assertBackendBaseUrl(value) {
  if (value === DOCKER_BACKEND_URL || value === `${DOCKER_BACKEND_URL}/`) {
    return new URL(DOCKER_BACKEND_URL);
  }
  return assertLoopbackBaseUrl(value);
}

module.exports = {
  DOCKER_BACKEND_URL,
  LOOPBACK_BASE_URL_PATTERN,
  assertBackendBaseUrl,
  assertLoopbackBaseUrl
};
