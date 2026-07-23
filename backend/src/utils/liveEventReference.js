const crypto = require('node:crypto');

const EVENT_REFERENCE_VERSION = 'v1';
const EVENT_REFERENCE_PREFIX = `ler:${EVENT_REFERENCE_VERSION}:`;
const EVENT_REFERENCE_DOMAIN = 'live-event-reference:v1';
const MINIMUM_SECRET_BYTES = 32;
const PLACEHOLDER_SECRET = /^(?:change|replace|example|sample|your)[-_ ]/i;

class LiveEventReferenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LiveEventReferenceError';
    this.code = code;
    this.status = 503;
  }
}

function validatedSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new LiveEventReferenceError('event_ref_secret_missing');
  }
  if (
    Buffer.byteLength(secret, 'utf8') < MINIMUM_SECRET_BYTES
    || PLACEHOLDER_SECRET.test(secret.trim())
  ) {
    throw new LiveEventReferenceError('event_ref_secret_invalid');
  }
  return secret;
}

function canonicalIdentity(row) {
  const id = String(row?.id ?? '');
  const contentHash = String(row?.content_hash || '').toLowerCase();
  if (!/^[1-9][0-9]*$/.test(id) || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new LiveEventReferenceError('event_ref_identity_invalid');
  }
  return `${EVENT_REFERENCE_DOMAIN}\0${id}\0${contentHash}`;
}

function createLiveEventReference(row, secret) {
  const key = validatedSecret(secret);
  const digest = crypto
    .createHmac('sha256', key)
    .update(canonicalIdentity(row), 'utf8')
    .digest('hex');
  return `${EVENT_REFERENCE_PREFIX}${digest}`;
}

function isVersionedLiveEventReference(value) {
  return typeof value === 'string'
    && /^ler:v1:[a-f0-9]{64}$/.test(value);
}

module.exports = {
  EVENT_REFERENCE_PREFIX,
  EVENT_REFERENCE_VERSION,
  LiveEventReferenceError,
  createLiveEventReference,
  isVersionedLiveEventReference,
  validatedSecret
};
