const { createSignedHeaders } = require('./signer');

const INGEST_PATH = '/api/internal/live-events/v1/ingest';
const MAX_ACK_BYTES = 16 * 1024;
const LOOPBACK_BASE_URL_PATTERN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;

function simulatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertLoopbackBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw simulatorError('invalid_base_url', 'Base URL is invalid');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    typeof value !== 'string' ||
    !LOOPBACK_BASE_URL_PATTERN.test(value) ||
    parsed.protocol !== 'http:' ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw simulatorError('remote_target_rejected', 'Simulator only accepts plain HTTP loopback URLs');
  }
  return parsed;
}

function parseAck(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_ACK_BYTES) {
    throw simulatorError('ack_too_large', 'ACK exceeded the simulator response limit');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw simulatorError('invalid_ack', 'Backend returned an invalid ACK');
  }
}

async function postSignedEvent({
  baseUrl,
  secret,
  event,
  now = Date.now,
  fetchImpl = fetch,
  timeoutMs = 10000
}) {
  const parsedBaseUrl = assertLoopbackBaseUrl(baseUrl);
  const endpoint = new URL(INGEST_PATH, parsedBaseUrl);
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
  const timestamp = String(Math.floor(now() / 1000));
  const headers = createSignedHeaders({ secret, timestamp, rawBody });

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: rawBody,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw simulatorError('http_request_failed', 'Loopback request failed');
  }

  const ack = parseAck(await response.text());
  return {
    httpStatus: response.status,
    status: ack.status,
    reason: ack.reason || null
  };
}

module.exports = {
  INGEST_PATH,
  LOOPBACK_BASE_URL_PATTERN,
  MAX_ACK_BYTES,
  assertLoopbackBaseUrl,
  parseAck,
  postSignedEvent
};
