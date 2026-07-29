const path = require('node:path');
const {
  ROOM_ID_PATTERN,
  SITE_ID_PATTERN
} = require('../../../backend/src/utils/liveEventConfig');
const { isPlaceholderSecret } = require('../../../backend/src/config/runtimeConfig');
const { listenerError } = require('./errors');
const { assertBackendBaseUrl } = require('./urlSafety');

const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MODES = new Set(['dry-run', 'test', 'production']);
const CANONICAL_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

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
  spoolMaxEntries: Object.freeze({
    env: 'LISTENER_SPOOL_MAX_ENTRIES',
    fallback: 10000,
    min: 1,
    max: 1000000
  }),
  deliveryConcurrency: Object.freeze({
    env: 'LISTENER_DELIVERY_CONCURRENCY', fallback: 1, min: 1, max: 4
  }),
  shutdownDrainTimeoutMs: Object.freeze({
    env: 'LISTENER_SHUTDOWN_DRAIN_TIMEOUT_MS', fallback: 10000, min: 100, max: 120000
  }),
  spoolMaxBytes: Object.freeze({
    env: 'LISTENER_SPOOL_MAX_BYTES',
    fallback: 64 * 1024 * 1024,
    min: 64 * 1024,
    max: 1024 * 1024 * 1024
  }),
  spoolMaxEntryBytes: Object.freeze({
    env: 'LISTENER_SPOOL_MAX_ENTRY_BYTES',
    fallback: 64 * 1024,
    min: 4096,
    max: 1024 * 1024
  }),
  durableRetryDelayMs: Object.freeze({
    env: 'LISTENER_DURABLE_RETRY_DELAY_MS',
    fallback: 30000,
    min: 1000,
    max: 300000
  }),
  ingestDisabledRetryMs: Object.freeze({
    env: 'LISTENER_INGEST_DISABLED_RETRY_MS',
    fallback: 60000,
    min: 5000,
    max: 600000
  })
});

const OFFICIAL_NUMERIC_SETTINGS = Object.freeze({
  apiTimeoutMs: Object.freeze({
    env: 'BILIBILI_API_TIMEOUT_MS', fallback: 5000, min: 100, max: 15000
  }),
  authTimeoutMs: Object.freeze({
    env: 'BILIBILI_AUTH_TIMEOUT_MS', fallback: 10000, min: 100, max: 30000
  }),
  apiHeartbeatIntervalMs: Object.freeze({
    env: 'BILIBILI_API_HEARTBEAT_INTERVAL_MS',
    fallback: 20000,
    min: 5000,
    max: 20000
  }),
  wsHeartbeatIntervalMs: Object.freeze({
    env: 'BILIBILI_WS_HEARTBEAT_INTERVAL_MS',
    fallback: 20000,
    min: 5000,
    max: 30000
  }),
  wsHeartbeatTimeoutMs: Object.freeze({
    env: 'BILIBILI_WS_HEARTBEAT_TIMEOUT_MS',
    fallback: 30000,
    min: 5000,
    max: 45000
  }),
  apiHeartbeatFailureThreshold: Object.freeze({
    env: 'BILIBILI_API_HEARTBEAT_FAILURE_THRESHOLD',
    fallback: 2,
    min: 1,
    max: 2
  }),
  endTimeoutMs: Object.freeze({
    env: 'BILIBILI_END_TIMEOUT_MS', fallback: 5000, min: 100, max: 15000
  })
});

const OFFICIAL_LIVE_NUMERIC_SETTINGS = Object.freeze({
  initialRecoveryWaitMs: Object.freeze({
    env: 'BILI_OFFICIAL_INITIAL_RECOVERY_WAIT_MS',
    fallback: 210000,
    min: 0,
    max: 600000
  }),
  duplicateRetryMinMs: Object.freeze({
    env: 'BILI_OFFICIAL_DUPLICATE_RETRY_MIN_MS',
    fallback: 90000,
    min: 1000,
    max: 300000
  }),
  duplicateRetryMaxMs: Object.freeze({
    env: 'BILI_OFFICIAL_DUPLICATE_RETRY_MAX_MS',
    fallback: 300000,
    min: 1000,
    max: 600000
  }),
  lockRetryMs: Object.freeze({
    env: 'BILI_OFFICIAL_LOCK_RETRY_MS',
    fallback: 30000,
    min: 1000,
    max: 300000
  }),
  wssReconnectInitialMs: Object.freeze({
    env: 'BILI_OFFICIAL_WSS_RECONNECT_INITIAL_MS',
    fallback: 1000,
    min: 100,
    max: 30000
  }),
  wssReconnectMaxMs: Object.freeze({
    env: 'BILI_OFFICIAL_WSS_RECONNECT_MAX_MS',
    fallback: 30000,
    min: 1000,
    max: 120000
  }),
  eventDedupeTtlHours: Object.freeze({
    env: 'BILI_OFFICIAL_EVENT_DEDUPE_TTL_HOURS',
    fallback: 168,
    min: 72,
    max: 720
  }),
  aiMemoryHours: Object.freeze({
    env: 'BILI_OFFICIAL_AI_MEMORY_HOURS',
    fallback: 72,
    min: 72,
    max: 72
  }),
  aiTimeoutMs: Object.freeze({
    env: 'BILI_OFFICIAL_AI_TIMEOUT_MS',
    fallback: 10000,
    min: 1000,
    max: 10000
  }),
  aiMaxRetries: Object.freeze({
    env: 'BILI_OFFICIAL_AI_MAX_RETRIES',
    fallback: 1,
    min: 0,
    max: 1
  }),
  aiMaxTokens: Object.freeze({
    env: 'BILI_OFFICIAL_AI_MAX_TOKENS',
    fallback: 96,
    min: 32,
    max: 160
  }),
  aiGlobalConcurrency: Object.freeze({
    env: 'BILI_OFFICIAL_AI_GLOBAL_CONCURRENCY',
    fallback: 2,
    min: 1,
    max: 2
  }),
  aiViewerCooldownMs: Object.freeze({
    env: 'BILI_OFFICIAL_AI_VIEWER_COOLDOWN_MS',
    fallback: 15000,
    min: 15000,
    max: 60000
  }),
  aiQueueMax: Object.freeze({
    env: 'BILI_OFFICIAL_AI_QUEUE_MAX',
    fallback: 20,
    min: 1,
    max: 100
  }),
  aiContextMaxMessages: Object.freeze({
    env: 'BILI_OFFICIAL_AI_CONTEXT_MAX_MESSAGES',
    fallback: 12,
    min: 2,
    max: 20
  }),
  aiCleanupIntervalMs: Object.freeze({
    env: 'BILI_OFFICIAL_AI_CLEANUP_INTERVAL_MS',
    fallback: 3600000,
    min: 60000,
    max: 86400000
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

function parseBoolean(value, name, {
  fallback = false
} = {}) {
  const raw = value === undefined || value === null || value === ''
    ? String(fallback)
    : String(value).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw listenerError(`invalid_${name.toLowerCase()}`);
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
  const dataDir = String(
    overrides.dataDir ?? env.LISTENER_DATA_DIR ?? ''
  ).trim();
  const secret = String(env.LIVE_EVENT_INGEST_SECRET || '');

  if (!SITE_ID_PATTERN.test(siteId)) throw listenerError('invalid_listener_site_id');
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw listenerError('invalid_listener_instance_id');
  }
  if (!ROOM_ID_PATTERN.test(roomId)) throw listenerError('invalid_listener_room_id');
  const parsedBackendUrl = assertBackendBaseUrl(backendUrl);

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
  if (mode === 'production' && (!dataDir || !path.isAbsolute(dataDir))) {
    throw listenerError('invalid_listener_data_dir');
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
    dataDir: dataDir || null,
    secret,
    ...numeric
  });
}

function loadListenerServiceConfig(env = {}) {
  const listenerEnabled = parseBoolean(
    env.BILIBILI_LISTENER_ENABLED,
    'bilibili_listener_enabled'
  );
  const officialApiEnabled = parseBoolean(
    env.BILIBILI_OFFICIAL_API_ENABLED,
    'bilibili_official_api_enabled'
  );
  const officialWssEnabled = parseBoolean(
    env.BILIBILI_OFFICIAL_WSS_ENABLED,
    'bilibili_official_wss_enabled'
  );
  const backendIngestEnabled = parseBoolean(
    env.LIVE_EVENT_INGEST_ENABLED,
    'live_event_ingest_enabled'
  );
  const giftAutoCreditEnabled = parseBoolean(
    env.BILIBILI_GIFT_AUTO_CREDIT_ENABLED,
    'bilibili_gift_auto_credit_enabled'
  );
  const officialLiveEnabled = parseBoolean(
    env.BILI_OFFICIAL_LIVE_ENABLED,
    'bili_official_live_enabled'
  );
  if (giftAutoCreditEnabled) {
    throw listenerError('gift_auto_credit_not_authorized');
  }
  if (
    listenerEnabled &&
    (
      !officialApiEnabled ||
      !officialWssEnabled ||
      (!backendIngestEnabled && !officialLiveEnabled)
    )
  ) {
    throw listenerError('listener_feature_gate_incomplete');
  }
  return Object.freeze({
    listenerEnabled,
    officialApiEnabled,
    officialWssEnabled,
    officialLiveEnabled,
    backendIngestEnabled,
    giftAutoCreditEnabled
  });
}

function requiredCredential(env, name, {
  minBytes = 8,
  maxBytes = 512
} = {}) {
  const value = String(env[name] || '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    !value.trim() ||
    value !== value.trim() ||
    bytes < minBytes ||
    bytes > maxBytes ||
    isPlaceholderSecret(value)
  ) {
    throw listenerError('invalid_bilibili_credentials');
  }
  return value;
}

function canonicalSafeInteger(value, code, {
  exactDigits = null
} = {}) {
  const raw = String(value || '');
  if (
    !CANONICAL_DECIMAL_PATTERN.test(raw) ||
    (exactDigits !== null && raw.length !== exactDigits) ||
    !Number.isSafeInteger(Number(raw))
  ) {
    throw listenerError(code);
  }
  return raw;
}

function loadOfficialBilibiliConfig(env = {}, {
  expectedRoomId,
  overrides = {}
} = {}) {
  const appId = canonicalSafeInteger(
    overrides.appId ?? env.BILIBILI_APP_ID,
    'invalid_bilibili_app_id',
    { exactDigits: 13 }
  );
  const roomId = canonicalSafeInteger(
    expectedRoomId,
    'invalid_listener_room_id'
  );
  const accessKeyId = requiredCredential(env, 'BILIBILI_ACCESS_KEY_ID', {
    minBytes: 4,
    maxBytes: 128
  });
  const accessKeySecret = requiredCredential(env, 'BILIBILI_ACCESS_KEY_SECRET', {
    minBytes: 16,
    maxBytes: 256
  });
  const identityCode = requiredCredential(env, 'BILIBILI_IDENTITY_CODE', {
    minBytes: 8,
    maxBytes: 512
  });
  if (accessKeySecret === String(env.LIVE_EVENT_INGEST_SECRET || '')) {
    throw listenerError('bilibili_secret_reuse_forbidden');
  }

  const numeric = {};
  for (const [key, definition] of Object.entries(OFFICIAL_NUMERIC_SETTINGS)) {
    numeric[key] = parseInteger(
      overrides[key] ?? env[definition.env],
      definition
    );
  }
  if (numeric.wsHeartbeatTimeoutMs <= numeric.wsHeartbeatIntervalMs) {
    throw listenerError('invalid_bilibili_heartbeat_range');
  }

  return Object.freeze({
    appId,
    roomId,
    accessKeyId,
    accessKeySecret,
    identityCode,
    ...numeric
  });
}

function loadOfficialLiveConfig(env = {}) {
  const liveEnabled = parseBoolean(
    env.BILI_OFFICIAL_LIVE_ENABLED,
    'bili_official_live_enabled'
  );
  const aiEnabled = parseBoolean(
    env.BILI_OFFICIAL_AI_ENABLED,
    'bili_official_ai_enabled'
  );
  const businessEffectsEnabled = parseBoolean(
    env.BILI_OFFICIAL_BUSINESS_EFFECTS_ENABLED,
    'bili_official_business_effects_enabled'
  );
  if (businessEffectsEnabled) {
    throw listenerError('official_business_effects_not_authorized');
  }
  const outputMode = String(
    env.BILI_OFFICIAL_AI_OUTPUT_MODE || 'local_only'
  ).trim();
  if (outputMode !== 'local_only') {
    throw listenerError('invalid_official_ai_output_mode');
  }

  const numeric = {};
  for (const [key, definition] of Object.entries(
    OFFICIAL_LIVE_NUMERIC_SETTINGS
  )) {
    numeric[key] = parseInteger(env[definition.env], definition);
  }
  if (numeric.duplicateRetryMaxMs < numeric.duplicateRetryMinMs) {
    throw listenerError('invalid_official_duplicate_retry_range');
  }
  if (numeric.wssReconnectMaxMs < numeric.wssReconnectInitialMs) {
    throw listenerError('invalid_official_wss_reconnect_range');
  }

  const eventHmacKey = liveEnabled
    ? requiredCredential(env, 'BILI_EVENT_HMAC_KEY', {
        minBytes: 32,
        maxBytes: 512
      })
    : null;
  const aiViewerHmacKey = aiEnabled
    ? requiredCredential(env, 'AI_VIEWER_HMAC_KEY', {
        minBytes: 32,
        maxBytes: 512
      })
    : null;
  const aiApiKey = aiEnabled
    ? requiredCredential(env, 'AI_API_KEY', {
        minBytes: 8,
        maxBytes: 1024
      })
    : null;
  const aiProvider = String(env.AI_PROVIDER || '').trim();
  const aiBaseUrl = String(env.AI_BASE_URL || '').trim();
  const aiModel = String(env.AI_MODEL || '').trim();
  const aiApiProtocol = String(env.AI_API_PROTOCOL || '').trim();
  if (
    aiEnabled &&
    (
      aiProvider !== 'openai_compatible' ||
      aiBaseUrl !== 'https://api.portkey.ai/v1' ||
      aiModel !== '@siliconflow/minimax-m3' ||
      aiApiProtocol !== 'chat_completions'
    )
  ) {
    throw listenerError('invalid_official_ai_config');
  }
  if (aiEnabled && eventHmacKey === aiViewerHmacKey) {
    throw listenerError('official_hmac_key_reuse_forbidden');
  }

  return Object.freeze({
    liveEnabled,
    aiEnabled,
    businessEffectsEnabled,
    outputMode,
    eventHmacKey,
    aiViewerHmacKey,
    aiApiKey,
    aiProvider,
    aiBaseUrl,
    aiModel,
    aiApiProtocol,
    ...numeric
  });
}

module.exports = {
  CANONICAL_DECIMAL_PATTERN,
  INSTANCE_ID_PATTERN,
  MODES,
  NUMERIC_SETTINGS,
  OFFICIAL_LIVE_NUMERIC_SETTINGS,
  OFFICIAL_NUMERIC_SETTINGS,
  canonicalSafeInteger,
  loadListenerConfig,
  loadListenerServiceConfig,
  loadOfficialLiveConfig,
  loadOfficialBilibiliConfig,
  parseBoolean,
  parseInteger
};
