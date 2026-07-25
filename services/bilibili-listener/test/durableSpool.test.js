const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  prepareEvent
} = require('../src/deliveryClient');
const {
  DurableEventSpool,
  eventKey
} = require('../src/durableSpool');
const {
  mapSourceEvent
} = require('../src/eventMapper');
const {
  ListenerSupervisor
} = require('../src/listenerSupervisor');
const {
  createSyntheticAdapter
} = require('../src/syntheticAdapter');
const {
  syntheticDanmaku
} = require('../src/syntheticFixtures');
const { testConfig } = require('./helpers/testConfig');
const { FakeTimers } = require('./helpers/fakeTimers');

function withSpool(work) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-spool-'));
  const config = testConfig({
    dataDir,
    durableRetryDelayMs: 300000,
    ingestDisabledRetryMs: 300000
  });
  const create = (overrides = {}) => new DurableEventSpool({
    dataDir,
    maxEntries: 4,
    maxBytes: 1024 * 1024,
    maxEntryBytes: 64 * 1024,
    ...overrides
  });
  return Promise.resolve()
    .then(() => work({ dataDir, config, create }))
    .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
}

function eventFixture(config, id = 'durable-spool-fixture') {
  return mapSourceEvent(syntheticDanmaku(id), config).event;
}

test('spool persists atomically and replays after process restart', async () => {
  await withSpool(async ({ create, config }) => {
    const first = create();
    first.initialize(prepareEvent);
    const stored = first.persist(eventFixture(config), prepareEvent);
    assert.equal(stored.status, 'stored');
    assert.equal(first.snapshot().pending_count, 1);

    const second = create();
    const replay = second.initialize(prepareEvent);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].prepared.eventId, eventFixture(config).event_id);
    second.acknowledge(replay[0]);
    assert.equal(second.snapshot().pending_count, 0);
  });
});

test('corrupt pending entries and abandoned temporary writes are quarantined', async () => {
  await withSpool(async ({ create, dataDir }) => {
    const pending = path.join(dataDir, 'pending');
    const temporary = path.join(dataDir, 'tmp');
    fs.mkdirSync(pending, { recursive: true });
    fs.mkdirSync(temporary, { recursive: true });
    fs.writeFileSync(
      path.join(pending, `${'a'.repeat(64)}.json`),
      '{"invalid":true}',
      'utf8'
    );
    fs.writeFileSync(
      path.join(temporary, 'abandoned.tmp'),
      '{"partial":',
      'utf8'
    );
    const spool = create();
    assert.deepEqual(spool.initialize(prepareEvent), []);
    assert.equal(spool.snapshot().pending_count, 0);
    assert.equal(spool.snapshot().quarantine_count, 2);
  });
});

test('spool capacity and event-id content conflicts fail closed', async () => {
  await withSpool(async ({ create, config }) => {
    const spool = create({ maxEntries: 1 });
    spool.initialize(prepareEvent);
    const original = eventFixture(config, 'durable-capacity-1');
    spool.persist(original, prepareEvent);
    assert.throws(
      () => spool.persist(
        eventFixture(config, 'durable-capacity-2'),
        prepareEvent
      ),
      { code: 'spool_full' }
    );

    const target = path.join(
      spool.pendingDir,
      `${eventKey(original.event_id)}.json`
    );
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    value.event.payload.text = 'changed content';
    fs.writeFileSync(target, JSON.stringify(value), 'utf8');
    assert.throws(
      () => spool.persist(original, prepareEvent),
      { code: 'pending_event_id_conflict' }
    );
  });
});

test('supervisor retains exhausted delivery and replays it after restart', async () => {
  await withSpool(async ({ create, config }) => {
    const firstAdapter = createSyntheticAdapter();
    const first = new ListenerSupervisor({
      config,
      adapter: firstAdapter,
      deliveryClient: {
        prepare: prepareEvent,
        async deliverPrepared() {
          return { outcome: 'failed', reason: 'network_error' };
        }
      },
      spool: create(),
      logger: { write() {} }
    });
    await first.start();
    await firstAdapter.emitEvent(
      syntheticDanmaku('durable-restart-replay')
    );
    assert.equal((await first.waitForIdle(500)).drained, true);
    assert.equal(first.snapshot().spool.pending_count, 1);
    await first.stop();

    const delivered = [];
    const second = new ListenerSupervisor({
      config,
      adapter: createSyntheticAdapter(),
      deliveryClient: {
        prepare: prepareEvent,
        async deliverPrepared(prepared) {
          delivered.push(prepared.eventId);
          return { outcome: 'accepted' };
        }
      },
      spool: create(),
      logger: { write() {} }
    });
    await second.start();
    assert.equal((await second.waitForIdle(500)).drained, true);
    assert.equal(delivered.length, 1);
    assert.equal(second.snapshot().spool.pending_count, 0);
    await second.stop();
  });
});

test('startup replay eventually drains entries beyond the in-memory queue', async () => {
  await withSpool(async ({ create, config }) => {
    const spool = create();
    spool.initialize(prepareEvent);
    for (const id of ['replay-overflow-1', 'replay-overflow-2', 'replay-overflow-3']) {
      spool.persist(eventFixture(config, id), prepareEvent);
    }

    const timers = new FakeTimers();
    const delivered = [];
    const supervisor = new ListenerSupervisor({
      config: {
        ...config,
        queueMaxLength: 1,
        durableRetryDelayMs: 5,
        heartbeatTimeoutMs: 120000
      },
      adapter: createSyntheticAdapter(),
      deliveryClient: {
        prepare: prepareEvent,
        async deliverPrepared(prepared) {
          delivered.push(prepared.eventId);
          return { outcome: 'accepted' };
        }
      },
      spool: create(),
      logger: { write() {} },
      clock: timers.clock,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout
    });
    await supervisor.start();
    await timers.flush();
    await timers.advance(5);
    await timers.advance(5);
    assert.equal((await supervisor.waitForIdle(500)).drained, true);
    assert.equal(delivered.length, 3);
    assert.equal(supervisor.snapshot().spool.pending_count, 0);
    await supervisor.stop();
  });
});

test('authentication failures retain pending while schema rejection quarantines', async () => {
  await withSpool(async ({ create, config }) => {
    for (const [outcome, expectedPending, expectedQuarantine] of [
      ['authentication_failed', 1, 0],
      ['permanent_rejection', 0, 1]
    ]) {
      const dataDir = create().dataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
      const adapter = createSyntheticAdapter();
      const supervisor = new ListenerSupervisor({
        config,
        adapter,
        deliveryClient: {
          prepare: prepareEvent,
          async deliverPrepared() {
            return {
              outcome,
              reason: outcome === 'authentication_failed'
                ? 'ingest_authentication_failed'
                : 'invalid_event_schema'
            };
          }
        },
        spool: create(),
        logger: { write() {} }
      });
      await supervisor.start();
      await adapter.emitEvent(syntheticDanmaku(`durable-${outcome}`));
      assert.equal((await supervisor.waitForIdle(500)).drained, true);
      assert.equal(supervisor.snapshot().spool.pending_count, expectedPending);
      assert.equal(
        supervisor.snapshot().spool.quarantine_count,
        expectedQuarantine
      );
      await supervisor.stop();
    }
  });
});

test('disabled ingest retains pending and drains after Backend becomes available', async () => {
  await withSpool(async ({ create, config }) => {
    const timers = new FakeTimers();
    const adapter = createSyntheticAdapter();
    let enabled = false;
    const supervisor = new ListenerSupervisor({
      config: {
        ...config,
        heartbeatTimeoutMs: 120000,
        ingestDisabledRetryMs: 5000
      },
      adapter,
      deliveryClient: {
        prepare: prepareEvent,
        async deliverPrepared() {
          return enabled
            ? { outcome: 'accepted' }
            : { outcome: 'ingest_disabled', reason: 'ingest_disabled' };
        }
      },
      spool: create(),
      logger: { write() {} },
      clock: timers.clock,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout
    });
    await supervisor.start();
    await adapter.emitEvent(syntheticDanmaku('durable-ingest-disabled'));
    await timers.flush();
    assert.equal(supervisor.snapshot().spool.pending_count, 1);
    enabled = true;
    await timers.advance(5000);
    assert.equal((await supervisor.waitForIdle(500)).drained, true);
    assert.equal(supervisor.snapshot().spool.pending_count, 0);
    await supervisor.stop();
  });
});
