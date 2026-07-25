const {
  loadListenerConfig,
  loadListenerServiceConfig,
  loadOfficialBilibiliConfig
} = require('./config');
const { DeliveryClient } = require('./deliveryClient');
const { listenerError } = require('./errors');
const { ListenerSupervisor } = require('./listenerSupervisor');
const { createSafeLogger } = require('./logger');
const { DurableEventSpool } = require('./durableSpool');
const { OfficialApiClient } = require('./officialApiClient');
const { OfficialBilibiliAdapter } = require('./officialBilibiliAdapter');

function createProductionRuntime({
  source,
  env = process.env,
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  logger = createSafeLogger(),
  clock = Date.now,
  lookup,
  nonce,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (source !== 'bilibili-official') {
    throw listenerError('bilibili_adapter_not_implemented');
  }
  const listenerConfig = loadListenerConfig(env, { mode: 'production' });
  const officialConfig = loadOfficialBilibiliConfig(env, {
    expectedRoomId: listenerConfig.roomId
  });
  const serviceConfig = loadListenerServiceConfig(env);
  if (!serviceConfig.listenerEnabled) {
    throw listenerError('listener_disabled');
  }
  if (typeof fetchImpl !== 'function') throw listenerError('official_fetch_unavailable');
  if (typeof webSocketImpl !== 'function') {
    throw listenerError('production_websocket_unavailable');
  }

  const apiClient = new OfficialApiClient({
    ...officialConfig,
    expectedRoomId: listenerConfig.roomId,
    fetchImpl,
    clock,
    ...(nonce ? { nonce } : {}),
    setTimer,
    clearTimer
  });
  const adapter = new OfficialBilibiliAdapter({
    config: officialConfig,
    apiClient,
    webSocketFactory: (url) => new webSocketImpl(url),
    logger,
    lookup,
    clock,
    setTimer,
    clearTimer
  });
  const deliveryClient = new DeliveryClient({
    config: listenerConfig,
    fetchImpl,
    clock,
    setTimer,
    clearTimer
  });
  const supervisor = new ListenerSupervisor({
    config: listenerConfig,
    adapter,
    deliveryClient,
    spool: new DurableEventSpool({
      dataDir: listenerConfig.dataDir,
      maxEntries: listenerConfig.spoolMaxEntries,
      maxBytes: listenerConfig.spoolMaxBytes,
      maxEntryBytes: listenerConfig.spoolMaxEntryBytes,
      clock
    }),
    logger,
    clock,
    setTimer,
    clearTimer
  });

  return Object.freeze({
    source,
    async start() {
      const snapshot = await supervisor.start();
      if (snapshot.state === 'fatal') {
        throw listenerError(
          snapshot.degraded_reason || 'official_source_fatal'
        );
      }
      return snapshot;
    },
    async stop() {
      return supervisor.stop();
    },
    snapshot() {
      return Object.freeze({
        ...supervisor.snapshot(),
        source: adapter.snapshot()
      });
    }
  });
}

module.exports = {
  createProductionRuntime
};
