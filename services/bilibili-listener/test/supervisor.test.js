const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvent } = require('../src/deliveryClient');
const { DryRunDelivery } = require('../src/dryRun');
const { ListenerSupervisor } = require('../src/listenerSupervisor');
const {
  deliveryRetryDelay,
  sourceReconnectDelay
} = require('../src/retryPolicy');
const { createSyntheticAdapter } = require('../src/syntheticAdapter');
const {
  syntheticDanmaku,
  syntheticUnsupported
} = require('../src/syntheticFixtures');
const { FakeTimers } = require('./helpers/fakeTimers');
const { testConfig } = require('./helpers/testConfig');

function silentLogger() {
  return { write() {} };
}

test('supervisor starts one connection, rejects duplicate start, and stops idempotently', async () => {
  const adapter = createSyntheticAdapter();
  const supervisor = new ListenerSupervisor({
    config: testConfig(),
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger()
  });
  await supervisor.start();
  assert.equal(supervisor.snapshot().state, 'connected');
  assert.equal(adapter.connectCount, 1);
  await assert.rejects(supervisor.start(), { code: 'listener_already_started' });
  const firstStop = await supervisor.stop();
  const secondStop = await supervisor.stop();
  assert.deepEqual(firstStop, secondStop);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('failed source connection enters capped backoff and reconnects once', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter({ connectFailures: 1 });
  const supervisor = new ListenerSupervisor({
    config: { ...testConfig(), reconnectInitialMs: 5, reconnectMaxMs: 5 },
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger(),
    random: () => 0.5,
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  assert.equal(supervisor.snapshot().state, 'backing_off');
  await timers.advance(5);
  assert.equal(supervisor.snapshot().state, 'connected');
  assert.equal(adapter.connectCount, 2);
  assert.equal(supervisor.snapshot().reconnect_count, 1);
  await supervisor.stop();
});

test('connect timeout aborts the active generation before scheduling reconnect', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  let activeConnects = 0;
  let maximumConnects = 0;
  adapter.connect = async ({ signal }) => {
    adapter.connectCount += 1;
    activeConnects += 1;
    maximumConnects = Math.max(maximumConnects, activeConnects);
    return new Promise((resolve, reject) => {
      void resolve;
      signal.addEventListener('abort', () => {
        activeConnects -= 1;
        const error = new Error('synthetic abort');
        error.code = 'source_connect_aborted';
        reject(error);
      }, { once: true });
    });
  };
  const supervisor = new ListenerSupervisor({
    config: {
      ...testConfig(),
      connectTimeoutMs: 10,
      reconnectInitialMs: 100,
      reconnectMaxMs: 100
    },
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger(),
    random: () => 0.5,
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  const starting = supervisor.start();
  await timers.advance(10);
  await starting;
  assert.equal(supervisor.snapshot().state, 'backing_off');
  assert.equal(activeConnects, 0);
  assert.equal(maximumConnects, 1);
  await supervisor.stop();
  await timers.advance(120);
  assert.equal(adapter.connectCount, 1);
});

test('source and delivery backoff calculations are independent and bounded', () => {
  assert.equal(sourceReconnectDelay({
    attempt: 0,
    initialMs: 100,
    maxMs: 1000,
    random: () => 0.5
  }), 100);
  assert.equal(sourceReconnectDelay({
    attempt: 10,
    initialMs: 100,
    maxMs: 1000,
    random: () => 0.5
  }), 1000);
  assert.equal(sourceReconnectDelay({
    attempt: 0,
    initialMs: 100,
    maxMs: 1000,
    random: () => 0
  }), 80);
  assert.equal(sourceReconnectDelay({
    attempt: 0,
    initialMs: 100,
    maxMs: 1000,
    random: () => 1
  }), 120);
  assert.equal(deliveryRetryDelay({
    attempt: 1,
    initialMs: 25,
    maxMs: 100
  }), 25);
  assert.equal(deliveryRetryDelay({
    attempt: 10,
    initialMs: 25,
    maxMs: 100
  }), 100);
});

test('heartbeat timeout triggers one disconnect path and one reconnect', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  const supervisor = new ListenerSupervisor({
    config: {
      ...testConfig(),
      heartbeatTimeoutMs: 10,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5
    },
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger(),
    random: () => 0.5,
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  await timers.advance(10);
  await timers.advance(5);
  assert.equal(adapter.connectCount, 2);
  assert.equal(supervisor.snapshot().reconnect_count, 1);
  assert.equal(adapter.disconnectCount, 1);
  await supervisor.stop();
});

test('stale callbacks from an older generation cannot schedule another reconnect', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  const supervisor = new ListenerSupervisor({
    config: {
      ...testConfig(),
      heartbeatTimeoutMs: 1000,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5
    },
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger(),
    random: () => 0.5,
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  const staleDisconnect = adapter.handlerHistory[0].disconnect;
  await staleDisconnect();
  await timers.advance(5);
  assert.equal(adapter.connectCount, 2);
  await staleDisconnect();
  await timers.advance(20);
  assert.equal(adapter.connectCount, 2);
  await supervisor.stop();
});

test('invalid and unsupported source events update counters without crashing', async () => {
  const adapter = createSyntheticAdapter();
  const supervisor = new ListenerSupervisor({
    config: testConfig(),
    adapter,
    deliveryClient: new DryRunDelivery(),
    logger: silentLogger()
  });
  await supervisor.start();
  await adapter.emitEvent(syntheticUnsupported('phase4e-supervisor-unsupported'));
  const invalid = syntheticDanmaku('phase4e-supervisor-invalid');
  delete invalid.provider_event_id;
  await adapter.emitEvent(invalid);
  assert.equal(supervisor.snapshot().ignored, 1);
  assert.equal(supervisor.snapshot().invalid, 1);
  await supervisor.stop();
});

test('queue rejection applies adapter backpressure and later resumes', async () => {
  const adapter = createSyntheticAdapter();
  const delivery = new DryRunDelivery();
  const supervisor = new ListenerSupervisor({
    config: { ...testConfig(), queueMaxLength: 2 },
    adapter,
    deliveryClient: delivery,
    logger: silentLogger()
  });
  await supervisor.start();
  delivery.block();
  await adapter.emitEvent(syntheticDanmaku('phase4e-supervisor-pressure-1'));
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.emitEvent(syntheticDanmaku('phase4e-supervisor-pressure-2'));
  const rejected = await adapter.emitEvent(
    syntheticDanmaku('phase4e-supervisor-pressure-3')
  );
  assert.deepEqual(rejected, { accepted: false, reason: 'queue_full' });
  assert.equal(adapter.pauseCount, 1);
  delivery.release();
  assert.equal((await supervisor.waitForIdle(500)).drained, true);
  assert.equal(supervisor.snapshot().queue_rejected, 1);
  assert.equal(adapter.resumeCount, 1);
  await supervisor.stop();
});

test('shutdown never resumes a source that was paused for backpressure', async () => {
  const adapter = createSyntheticAdapter();
  const delivery = new DryRunDelivery();
  const supervisor = new ListenerSupervisor({
    config: {
      ...testConfig(),
      queueMaxLength: 2,
      shutdownDrainTimeoutMs: 500
    },
    adapter,
    deliveryClient: delivery,
    logger: silentLogger()
  });
  await supervisor.start();
  delivery.block();
  await adapter.emitEvent(syntheticDanmaku('phase4e-stop-pressure-1'));
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.emitEvent(syntheticDanmaku('phase4e-stop-pressure-2'));
  await adapter.emitEvent(syntheticDanmaku('phase4e-stop-pressure-3'));
  assert.equal(adapter.pauseCount, 1);

  const stopping = supervisor.stop();
  delivery.release();
  assert.equal((await stopping).drained, true);
  assert.equal(adapter.resumeCount, 0);
});

test('a reconnected source resumes after backpressure drains while disconnected', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  const delivery = new DryRunDelivery();
  const supervisor = new ListenerSupervisor({
    config: {
      ...testConfig(),
      queueMaxLength: 2,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5
    },
    adapter,
    deliveryClient: delivery,
    logger: silentLogger(),
    random: () => 0.5,
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  delivery.block();
  await adapter.emitEvent(syntheticDanmaku('phase4e-reconnect-pressure-1'));
  await timers.flush();
  await adapter.emitEvent(syntheticDanmaku('phase4e-reconnect-pressure-2'));
  await adapter.emitEvent(syntheticDanmaku('phase4e-reconnect-pressure-3'));
  assert.equal(adapter.pauseCount, 1);

  await adapter.emitDisconnect();
  delivery.release();
  await timers.flush();
  assert.equal(adapter.resumeCount, 0);
  await timers.advance(5);
  assert.equal(supervisor.snapshot().state, 'connected');
  assert.equal(adapter.resumeCount, 1);
  await supervisor.stop();
});

test('unexpected delivery errors become a failed counter instead of escaping the queue', async () => {
  const adapter = createSyntheticAdapter();
  const supervisor = new ListenerSupervisor({
    config: testConfig(),
    adapter,
    deliveryClient: {
      prepare: prepareEvent,
      async deliverPrepared() {
        const error = new Error('synthetic delivery implementation failure');
        error.code = 'synthetic_delivery_failure';
        throw error;
      }
    },
    logger: silentLogger()
  });
  await supervisor.start();
  await adapter.emitEvent(syntheticDanmaku('phase4e-delivery-throws'));
  assert.equal((await supervisor.waitForIdle(500)).drained, true);
  assert.equal(supervisor.snapshot().failed, 1);
  await supervisor.stop();
});

test('shutdown drains accepted work and prevents all later reconnects', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  const delivered = [];
  const delivery = {
    prepare: prepareEvent,
    async deliverPrepared(prepared) {
      delivered.push(prepared.eventId);
      return { outcome: 'accepted', retries: 0 };
    }
  };
  const supervisor = new ListenerSupervisor({
    config: testConfig(),
    adapter,
    deliveryClient: delivery,
    logger: silentLogger(),
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  await adapter.emitEvent(syntheticDanmaku('phase4e-supervisor-drain'));
  assert.equal((await supervisor.stop()).drained, true);
  await adapter.emitDisconnect();
  await timers.advance(20);
  assert.equal(delivered.length, 1);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('drain timeout aborts in-flight delivery and leaves no queued work', async () => {
  const timers = new FakeTimers();
  const adapter = createSyntheticAdapter();
  const delivery = {
    prepare: prepareEvent,
    async deliverPrepared(prepared, { signal }) {
      void prepared;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ outcome: 'failed', reason: 'delivery_aborted' });
        }, { once: true });
      });
    }
  };
  const supervisor = new ListenerSupervisor({
    config: { ...testConfig(), shutdownDrainTimeoutMs: 10 },
    adapter,
    deliveryClient: delivery,
    logger: silentLogger(),
    clock: timers.clock,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  await supervisor.start();
  await adapter.emitEvent(syntheticDanmaku('phase4e-supervisor-timeout'));
  await timers.flush();
  const stopping = supervisor.stop();
  await timers.advance(10);
  const result = await stopping;
  assert.equal(result.drained, true);
  assert.equal(supervisor.snapshot().queue_depth, 0);
  assert.equal(supervisor.snapshot().failed, 1);
});
