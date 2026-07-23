const {
  ROOM_ID_PATTERN,
  SITE_ID_PATTERN
} = require('../../../backend/src/utils/liveEventConfig');
const { isPlaceholderSecret } = require('../../../backend/src/config/runtimeConfig');
const { listenerError } = require('./errors');
const { assertLoopbackBaseUrl } = require('./urlSafety');

const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MODES = new Set(['dry-run', 'test', 'production']);

const NUMERIC_SETTINGS = Object.freeze({
  connectTimeoutMs: Object.freeze({
    env: 'LISTENER_CONNECT_TIMEOUT_MS', fallback: 10000, min: 100, max: 60000
  }),
  heartbeatTimeoutMs: Object.freeze({
    env: 'LISTENER_HEARTBEAT_TIMEOUT_MS', fallback: 30000, min: 1000, max: 120000
  }),
  reconnectInitialMs: Object.freeze({
    env: 'LISTENER_RECONNECT_INITIAL_MS', fallback: 1000, min: 50, max: 60000
  }),
  reconnectMaxMs: Object.freeze({
    env: 'LISTENER_RECONNECT_MAX_MS', fallback: 30000, min: 50, max: 300000
  }),
  deliveryMaxAttempts: Object.freeze({
    env: 'LISTENER_DELIVERY_MAX_ATTEMPTS', fallback: 3, min: 1, max: 10
  }),
  deliveryTimeoutMs: Object.freeze({
    env: 'LISTENER_DELIVERY_TIMEOUT_MS', fallback: 5000, min: 100, max: 30000
  }),
  deliveryRetryInitialMs: Object.freeze({
    env: 'LISTENER_DELIVERY_RETRY_INITIAL_MS', fallback: 250, min: 10, max: 10000
  }),
  deliveryRetryMaxMs: Object.freeze({
    env: 'LISTENER_DELIVERY_RETRY_MAX_MS', fallback: 5000, min: 10, max: 60000
  }),
  queueMaxLength: Object.freeze({
    env: 'LISTENER_QUEUE_MAX_LENGTH', fallback: 1000, min: 1, max: 10000
  }),
  deliveryConcurrency: Object.freeze({
    env: 'LISTENER_DELIVERY_CONCURRENCY', fallback: 1, min: 1, max: 4
  }),
  shutdownDrainTimeoutMs: Object.freeze({
    env: 'LISTENER_SHUTDOWN_DRAIN_TIMEOUT_MS', fallback: 10000, min: 100, max: 120000
  })
});

function parseInteger(value, definition) {
  const raw = value === undefined || value === null || value === ''
    ? String(definition.fallback)
    : String(value);
  if (!/^[0-9]+$/.test(raw)) throw listenerError('invalid_numeric_config');
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < definition.min ||
    parsed > definition.max
  ) {
    throw listenerError('invalid_numeric_config');
  }
  return parsed;
}

function loadListenerConfig(env = {}, {
  mode = 'production',
  overrides = {}
} = {}) {
  if (!MODES.has(mode)) throw listenerError('invalid_listener_mode');

  const siteId = String(overrides.siteId ?? env.LISTENER_SITE_ID ?? '').trim();
  const instanceId = String(
    overrides.instanceId ?? env.LISTENER_INSTANCE_ID ?? ''
  ).trim();
  const roomId = String(overrides.roomId ?? env.LISTENER_ROOM_ID ?? '').trim();
  const backendUrl = String(
    overrides.backendUrl ?? env.LISTENER_BACKEND_URL ?? ''
  ).trim();
  const secret = String(env.LIVE_EVENT_INGEST_SECRET || '');

  if (!SITE_ID_PATTERN.test(siteId)) throw listenerError('invalid_listener_site_id');
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw listenerError('invalid_listener_instance_id');
  }
  if (!ROOM_ID_PATTERN.test(roomId)) throw listenerError('invalid_listener_room_id');
  const parsedBackendUrl = assertLoopbackBaseUrl(backendUrl);

  if (
    mode !== 'dry-run' &&
    (
      !secret.trim() ||
      Buffer.byteLength(secret, 'utf8') < 32 ||
      isPlaceholderSecret(secret)
    )
  ) {
    throw listenerError('invalid_ingest_secret');
  }

  const numeric = {};
  for (const [key, definition] of Object.entries(NUMERIC_SETTINGS)) {
    numeric[key] = parseInteger(
      overrides[key] ?? env[definition.env],
      definition
    );
  }
  if (numeric.reconnectMaxMs < numeric.reconnectInitialMs) {
    throw listenerError('invalid_reconnect_range');
  }
  if (numeric.deliveryRetryMaxMs < numeric.deliveryRetryInitialMs) {
    throw listenerError('invalid_delivery_retry_range');
  }

  return Object.freeze({
    mode,
    eventMode: mode === 'production' ? 'live' : 'simulation',
    siteId,
    instanceId,
    roomId,
    backendUrl: parsedBackendUrl.origin,
    secret,
    ...numeric
  });
}

module.exports = {
  INSTANCE_ID_PATTERN,
  MODES,
  NUMERIC_SETTINGS,
  loadListenerConfig,
  parseInteger
};
