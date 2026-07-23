const { isPlaceholderSecret } = require('../config/runtimeConfig');

const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ROOM_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const DEFAULT_MAX_SKEW_SECONDS = 300;
const MAX_CONFIGURED_SKEW_SECONDS = 3600;

function parsePositiveInteger(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAllowedTargets(value) {
  const raw = String(value || '').trim();
  if (!raw) return { valid: false, targets: new Set() };

  const targets = new Set();
  for (const entry of raw.split(',')) {
    const normalized = entry.trim();
    const separator = normalized.indexOf(':');
    if (
      !normalized ||
      separator <= 0 ||
      separator !== normalized.lastIndexOf(':') ||
      normalized.includes('*')
    ) {
      return { valid: false, targets: new Set() };
    }

    const siteId = normalized.slice(0, separator);
    const roomId = normalized.slice(separator + 1);
    if (!SITE_ID_PATTERN.test(siteId) || !ROOM_ID_PATTERN.test(roomId)) {
      return { valid: false, targets: new Set() };
    }
    targets.add(`${siteId}:${roomId}`);
  }

  return { valid: targets.size > 0, targets };
}

function resolveLiveEventConfig(env = process.env) {
  const enabled = String(env.LIVE_EVENT_INGEST_ENABLED || '').trim().toLowerCase() === 'true';
  const secret = String(env.LIVE_EVENT_INGEST_SECRET || '');
  const maxSkewSeconds = parsePositiveInteger(
    env.LIVE_EVENT_MAX_SKEW_SECONDS,
    DEFAULT_MAX_SKEW_SECONDS
  );
  const allowed = parseAllowedTargets(env.LIVE_EVENT_ALLOWED_TARGETS);
  const secretIsValid = Buffer.byteLength(secret, 'utf8') >= 32 && !isPlaceholderSecret(secret);
  const skewIsValid = maxSkewSeconds !== null && maxSkewSeconds <= MAX_CONFIGURED_SKEW_SECONDS;

  return Object.freeze({
    enabled,
    ready: enabled && secretIsValid && skewIsValid && allowed.valid,
    secret,
    maxSkewSeconds,
    allowedTargets: allowed.targets
  });
}

function isLiveEventTargetAllowed(config, siteId, roomId) {
  return config.allowedTargets.has(`${siteId}:${roomId}`);
}

module.exports = {
  DEFAULT_MAX_SKEW_SECONDS,
  MAX_CONFIGURED_SKEW_SECONDS,
  ROOM_ID_PATTERN,
  SITE_ID_PATTERN,
  isLiveEventTargetAllowed,
  parseAllowedTargets,
  resolveLiveEventConfig
};
