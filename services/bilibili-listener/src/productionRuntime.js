const { loadListenerConfig, loadOfficialBilibiliConfig } = require('./config');
const { DeliveryClient } = require('./deliveryClient');
const { listenerError } = require('./errors');
const { ListenerSupervisor } = require('./listenerSupervisor');
const { createSafeLogger } = require('./logger');
const { OfficialApiClient } = require('./officialApiClient');
const { OfficialBilibiliAdapter } = require('./officialBilibiliAdapter');
const {
  assertOfficialWssEvidenceVerified
} = require('./officialWssUrl');

function createProductionRuntime({
  source,
  env = process.env,
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  logger = createSafeLogger(),
  clock = Date.now,
  nonce,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (source !== 'bilibili-official') {
    throw listenerError('bilibili_adapter_not_implemented');
  }
  assertOfficialWssEvidenceVerified();
  const listenerConfig = loadListenerConfig(env, { mode: 'production' });
  const officialConfig = loadOfficialBilibiliConfig(env, {
    expectedRoomId: listenerConfig.roomId
  });
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
        throw listenerError('official_source_fatal');
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
