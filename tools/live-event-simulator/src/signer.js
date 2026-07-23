const crypto = require('node:crypto');

const MIN_SECRET_BYTES = 32;

function normalizeRawBody(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new TypeError('rawBody must be a Buffer or string');
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    const error = new Error('Simulator secret must be at least 32 bytes');
    error.code = 'invalid_simulator_secret';
    throw error;
  }
}

function assertTimestamp(timestamp) {
  const value = String(timestamp);
  if (!/^[0-9]{1,12}$/.test(value)) {
    const error = new Error('Timestamp must be Unix seconds');
    error.code = 'invalid_timestamp';
    throw error;
  }
  return value;
}

function signRawBody({ secret, timestamp, rawBody }) {
  assertSecret(secret);
  const normalizedTimestamp = assertTimestamp(timestamp);
  const bytes = normalizeRawBody(rawBody);
  return crypto
    .createHmac('sha256', secret)
    .update(`${normalizedTimestamp}.`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function createSignedHeaders({ secret, timestamp, rawBody }) {
  return {
    'Content-Type': 'application/json',
    'X-Live-Timestamp': assertTimestamp(timestamp),
    'X-Live-Signature': signRawBody({ secret, timestamp, rawBody })
  };
}

module.exports = {
  MIN_SECRET_BYTES,
  createSignedHeaders,
  normalizeRawBody,
  signRawBody
};
