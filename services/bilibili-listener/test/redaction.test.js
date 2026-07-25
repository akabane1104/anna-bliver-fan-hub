const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeLogger } = require('../src/logger');
const { ListenerStatus } = require('../src/status');

test('logger emits an allowlisted record and discards nested sensitive fields', () => {
  const records = [];
  const logger = createSafeLogger({
    clock: () => 1784764800000,
    sink: (record) => records.push(record)
  });
  const record = logger.write('error', 'delivery_result', {
    state: 'connected',
    event_type: 'danmaku',
    event_fingerprint: '0123456789abcdef',
    result: 'failed',
    secret: 'MUST_NOT_APPEAR',
    token: 'MUST_NOT_APPEAR',
    cookie: 'MUST_NOT_APPEAR',
    signature: 'MUST_NOT_APPEAR',
    open_id: 'MUST_NOT_APPEAR',
    uid: 'MUST_NOT_APPEAR',
    username: 'MUST_NOT_APPEAR',
    text: 'MUST_NOT_APPEAR',
    raw_payload: { nested: 'MUST_NOT_APPEAR' },
    error: { config: 'MUST_NOT_APPEAR' }
  });
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(record), /MUST_NOT_APPEAR/);
  assert.deepEqual(Object.keys(record).sort(), [
    'code',
    'component',
    'event_fingerprint',
    'event_type',
    'level',
    'result',
    'state',
    'timestamp'
  ]);
});

test('nested counters are rebuilt from a fixed status whitelist', () => {
  const logger = createSafeLogger({ sink() {} });
  const record = logger.write('info', 'status_snapshot', {
    counters: {
      received: 2,
      accepted: 1,
      secret_counter: 999
    }
  });
  assert.equal(record.counters.received, 2);
  assert.equal(record.counters.accepted, 1);
  assert.equal('secret_counter' in record.counters, false);
});

test('synchronous and asynchronous log sink failures never escape', async () => {
  const synchronous = createSafeLogger({
    sink() {
      throw new Error('synthetic sink failure');
    }
  });
  assert.doesNotThrow(() => synchronous.write('error', 'delivery_result'));

  const asynchronous = createSafeLogger({
    sink() {
      return Promise.reject(new Error('synthetic async sink failure'));
    }
  });
  assert.doesNotThrow(() => asynchronous.write('error', 'delivery_result'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('high-frequency event logs are bounded per fixed window', () => {
  const records = [];
  let now = 1784764800000;
  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    clock: () => now,
    rateLimitMax: 2,
    rateLimitWindowMs: 1000
  });
  for (let index = 0; index < 5; index += 1) {
    logger.write('info', 'delivery_result', {
      result: 'accepted'
    });
  }
  assert.equal(records.length, 2);

  now += 1000;
  logger.write('info', 'delivery_result', {
    result: 'accepted'
  });
  assert.equal(records.length, 3);
});

test('status snapshot contains counters and lifecycle fields but no credentials or body', () => {
  let now = 1784764800000;
  const status = new ListenerStatus({ clock: () => now });
  status.transition('connected');
  status.setGeneration(3);
  status.increment('received');
  status.increment('accepted');
  status.markConnected();
  status.markDeliverySuccess();
  now += 250;
  const snapshot = status.snapshot(2);
  assert.equal(snapshot.state, 'connected');
  assert.equal(snapshot.uptime_ms, 250);
  assert.equal(snapshot.connection_generation, 3);
  assert.equal(snapshot.queue_depth, 2);
  assert.equal(snapshot.received, 1);
  assert.equal(snapshot.accepted, 1);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /secret|token|cookie|signature|open_id|uid|text|payload/i
  );
});
