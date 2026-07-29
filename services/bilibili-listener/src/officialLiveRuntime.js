const { listenerError } = require('./errors');
const {
  loadOfficialBilibiliConfig,
  loadOfficialLiveConfig
} = require('./config');
const { createSafeLogger } = require('./logger');
const { MysqlSessionLock } = require('./mysqlSessionLock');
const { OfficialApiClient } = require('./officialApiClient');
const { OfficialEventProcessor } = require('./officialEventProcessor');
const { OfficialLiveRepository } = require('./officialLiveRepository');
const { OfficialSessionManager } = require('./officialSessionManager');
const { PortkeyAiAssistant } = require('./portkeyAiAssistant');

function requiredDatabaseConfig(env) {
  const host = String(env.DB_HOST || '').trim();
  const user = String(env.DB_USER || '').trim();
  const password = String(env.DB_PASSWORD || '');
  const database = String(env.DB_NAME || '').trim();
  const port = Number(env.DB_PORT || 3306);
  if (
    !host ||
    !user ||
    !password ||
    !database ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw listenerError('invalid_official_database_config');
  }
  return Object.freeze({
    host,
    port,
    user,
    password,
    database,
    charset: 'utf8mb4',
    timezone: 'Z'
  });
}

function createOpenAiClient(config, OpenAIClass) {
  const OpenAI = OpenAIClass || require('openai');
  return new OpenAI({
    baseURL: config.aiBaseUrl,
    apiKey: config.aiApiKey,
    timeout: config.aiTimeoutMs,
    maxRetries: config.aiMaxRetries
  });
}

function createOfficialLiveRuntime({
  env = process.env,
  mysqlModule = null,
  OpenAIClass = null,
  webSocketFactory = (url) => new WebSocket(url),
  logger = null,
  lookup,
  clock = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep,
  apiClient = null,
  sessionLock = null,
  repository = null,
  aiAssistant = null,
  eventProcessor = null,
  sessionManager = null
} = {}) {
  const liveConfig = loadOfficialLiveConfig(env);
  let state = liveConfig.liveEnabled ? 'STARTING' : 'STOPPED';
  let pool = null;
  let manager = sessionManager;
  let repo = repository;
  const safeLogger = logger || createSafeLogger({ clock });

  async function initialize() {
    if (manager || !liveConfig.liveEnabled) return;
    const mysql = mysqlModule || require('mysql2/promise');
    const databaseConfig = requiredDatabaseConfig(env);
    pool = mysql.createPool({
      ...databaseConfig,
      waitForConnections: true,
      connectionLimit: 4,
      queueLimit: 20,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
    repo = repo || new OfficialLiveRepository({ pool, clock });
    const lock = sessionLock || new MysqlSessionLock({
      connectionFactory: mysql.createConnection,
      connectionOptions: databaseConfig,
      siteId: env.LISTENER_SITE_ID
    });
    const officialConfig = loadOfficialBilibiliConfig(env, {
      expectedRoomId: env.LISTENER_ROOM_ID
    });
    const officialApiClient = apiClient || new OfficialApiClient({
      accessKeyId: officialConfig.accessKeyId,
      accessKeySecret: officialConfig.accessKeySecret,
      appId: officialConfig.appId,
      identityCode: officialConfig.identityCode,
      expectedRoomId: officialConfig.roomId,
      timeoutMs: officialConfig.apiTimeoutMs,
      clock,
      setTimer,
      clearTimer
    });
    const assistant = aiAssistant || (
      liveConfig.aiEnabled
        ? new PortkeyAiAssistant({
            config: liveConfig,
            repository: repo,
            logger: safeLogger,
            client: createOpenAiClient(liveConfig, OpenAIClass),
            clock
          })
        : null
    );
    const processor = eventProcessor || new OfficialEventProcessor({
      config: liveConfig,
      repository: repo,
      aiAssistant: assistant,
      logger: safeLogger,
      clock
    });
    manager = new OfficialSessionManager({
      config: Object.freeze({ ...officialConfig, ...liveConfig }),
      apiClient: officialApiClient,
      sessionLock: lock,
      eventProcessor: processor,
      webSocketFactory,
      logger: safeLogger,
      lookup,
      clock,
      random,
      setTimer,
      clearTimer,
      sleep
    });
  }

  return Object.freeze({
    async start() {
      if (!liveConfig.liveEnabled) {
        state = 'STOPPED';
        return this.snapshot();
      }
      await initialize();
      await manager.start();
      state = manager.snapshot().state;
      return this.snapshot();
    },
    async stop() {
      await manager?.stop?.();
      await pool?.end?.().catch(() => {});
      pool = null;
      state = 'STOPPED';
      return this.snapshot();
    },
    async controlledReconnect() {
      return manager?.controlledReconnect?.() || Object.freeze({
        status: 'not_active'
      });
    },
    snapshot() {
      const active = manager?.snapshot?.() || null;
      if (active) state = active.state;
      return Object.freeze({
        enabled: liveConfig.liveEnabled,
        ai_enabled: liveConfig.aiEnabled,
        business_effects_enabled: false,
        state,
        ...(active || {})
      });
    }
  });
}

module.exports = {
  createOfficialLiveRuntime,
  createOpenAiClient,
  requiredDatabaseConfig
};
