const { prepareEvent } = require('./deliveryClient');
const { loadListenerConfig } = require('./config');
const { listenerError } = require('./errors');
const { ListenerSupervisor } = require('./listenerSupervisor');
const { createSafeLogger } = require('./logger');
const { createSyntheticAdapter } = require('./syntheticAdapter');
const {
  SYNTHETIC_INSTANCE_ID,
  SYNTHETIC_ROOM_ID,
  SYNTHETIC_SITE_ID,
  syntheticDanmaku,
  syntheticGift,
  syntheticInvalid,
  syntheticUnsupported
} = require('./syntheticFixtures');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class DryRunDelivery {
  constructor() {
    this.records = new Map();
    this.httpConnections = 0;
    this.backendConnections = 0;
    this.mysqlConnections = 0;
    this.blocker = null;
  }

  prepare(event) {
    return prepareEvent(event);
  }

  block() {
    this.blocker = deferred();
  }

  release() {
    this.blocker?.resolve();
    this.blocker = null;
  }

  async deliverPrepared(prepared) {
    if (this.blocker) await this.blocker.promise;
    const existing = this.records.get(prepared.eventId);
    if (existing === prepared.bodyHash) return { outcome: 'duplicate', retries: 0 };
    if (existing) return { outcome: 'conflict', retries: 0 };
    this.records.set(prepared.eventId, prepared.bodyHash);
    return { outcome: 'accepted', retries: 0 };
  }
}

async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw listenerError('dry_run_timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runDryRun() {
  const config = loadListenerConfig({}, {
    mode: 'dry-run',
    overrides: {
      siteId: SYNTHETIC_SITE_ID,
      instanceId: SYNTHETIC_INSTANCE_ID,
      roomId: SYNTHETIC_ROOM_ID,
      backendUrl: 'http://127.0.0.1:5000',
      connectTimeoutMs: 500,
      heartbeatTimeoutMs: 1000,
      reconnectInitialMs: 50,
      reconnectMaxMs: 50,
      deliveryMaxAttempts: 1,
      deliveryTimeoutMs: 500,
      deliveryRetryInitialMs: 10,
      deliveryRetryMaxMs: 10,
      queueMaxLength: 2,
      deliveryConcurrency: 1,
      shutdownDrainTimeoutMs: 1000
    }
  });
  const adapter = createSyntheticAdapter();
  const delivery = new DryRunDelivery();
  const records = [];
  const supervisor = new ListenerSupervisor({
    config,
    adapter,
    deliveryClient: delivery,
    random: () => 0.5,
    logger: createSafeLogger({ sink: (record) => records.push(record) })
  });

  await supervisor.start();
  const danmaku = syntheticDanmaku('phase4e-dry-danmaku-1');
  await adapter.emitEvent(danmaku);
  await supervisor.waitForIdle(500);
  await adapter.emitEvent(syntheticGift('phase4e-dry-gift-1'));
  await supervisor.waitForIdle(500);
  await adapter.emitEvent(syntheticUnsupported('phase4e-dry-unsupported-1'));
  await adapter.emitEvent(syntheticInvalid());
  await adapter.emitEvent(danmaku);
  await supervisor.waitForIdle(500);

  await adapter.emitDisconnect();
  await waitUntil(() => adapter.connectCount === 2);

  delivery.block();
  await adapter.emitEvent(syntheticDanmaku('phase4e-dry-pressure-1'));
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.emitEvent(syntheticDanmaku('phase4e-dry-pressure-2'));
  await adapter.emitEvent(syntheticDanmaku('phase4e-dry-pressure-3'));
  delivery.release();
  await supervisor.waitForIdle(500);
  const stopResult = await supervisor.stop();
  const snapshot = supervisor.snapshot();

  const expected = {
    received: 8,
    mapped: 6,
    ignored: 1,
    invalid: 1,
    accepted: 4,
    duplicate: 1,
    conflict: 0,
    retried: 0,
    failed: 0,
    queue_rejected: 1,
    reconnect_count: 1
  };
  for (const [key, value] of Object.entries(expected)) {
    if (snapshot[key] !== value) throw listenerError('dry_run_assertion_failed');
  }
  if (
    !stopResult.drained ||
    adapter.networkConnections !== 0 ||
    delivery.httpConnections !== 0 ||
    delivery.backendConnections !== 0 ||
    delivery.mysqlConnections !== 0
  ) {
    throw listenerError('dry_run_assertion_failed');
  }

  return Object.freeze({
    mode: 'dry-run',
    scenario_count: 7,
    event_count: 8,
    source_connects: adapter.connectCount,
    bilibili_connections: adapter.networkConnections,
    http_connections: delivery.httpConnections,
    backend_connections: delivery.backendConnections,
    mysql_connections: delivery.mysqlConnections,
    adapter_pauses: adapter.pauseCount,
    adapter_resumes: adapter.resumeCount,
    log_records: records.length,
    ...snapshot
  });
}

module.exports = {
  DryRunDelivery,
  runDryRun,
  waitUntil
};
