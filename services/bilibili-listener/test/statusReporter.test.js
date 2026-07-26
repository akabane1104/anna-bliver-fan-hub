const test = require('node:test');
const assert = require('node:assert/strict');
const { signRawBody } = require('../src/deliveryClient');
const {
  ListenerStatusReporter,
  STATUS_PATH,
  classifyStatusAck,
  prepareStatusReport,
  transportFromSnapshot
} = require('../src/statusReporter');
const { testConfig } = require('./helpers/testConfig');

const REPORT_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = 1700000000000;

function healthySnapshot() {
  return {
    enabled: true,
    state: 'healthy',
    runtime: {
      source: {
        websocket_authenticated: true
      }
    }
  };
}

test('status report contains only the strict transport summary', () => {
  const config = testConfig();
  const prepared = prepareStatusReport(healthySnapshot(), config, {
    clock: () => NOW,
    idFactory: () => REPORT_ID
  });
  assert.deepEqual(JSON.parse(prepared.rawBody.toString('utf8')), {
    report_id: REPORT_ID,
    site_id: config.siteId,
    room_id: config.roomId,
    transport_state: 'connected',
    authenticated: true,
    reported_at: '2023-11-14T22:13:20.000Z'
  });
  assert.equal(prepared.rawBody.includes(Buffer.from(config.secret)), false);
});

test('status reporter reuses ingest HMAC headers and the internal status path', async () => {
  const config = testConfig();
  let captured;
  const reporter = new ListenerStatusReporter({
    config,
    clock: () => NOW,
    idFactory: () => REPORT_ID,
    async fetchImpl(url, options) {
      captured = { url: new URL(url), options };
      return new Response(JSON.stringify({ status: 'accepted' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const result = await reporter.report(healthySnapshot());
  assert.equal(result.outcome, 'accepted');
  assert.equal(captured.url.pathname, STATUS_PATH);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(
    captured.options.headers['X-Live-Signature'],
    signRawBody({
      secret: config.secret,
      timestamp: captured.options.headers['X-Live-Timestamp'],
      rawBody: captured.options.body
    })
  );
});

test('successive status reports keep reported_at strictly monotonic', () => {
  const ids = [
    REPORT_ID,
    '123e4567-e89b-42d3-a456-426614174001'
  ];
  const reporter = new ListenerStatusReporter({
    config: testConfig(),
    clock: () => NOW,
    idFactory: () => ids.shift(),
    fetchImpl: async () => {
      throw new Error('prepare must not perform network access');
    }
  });
  const first = JSON.parse(
    reporter.prepare(healthySnapshot()).rawBody.toString('utf8')
  );
  const second = JSON.parse(
    reporter.prepare(healthySnapshot()).rawBody.toString('utf8')
  );
  assert.equal(first.reported_at, '2023-11-14T22:13:20.000Z');
  assert.equal(second.reported_at, '2023-11-14T22:13:20.001Z');
});

test('temporary status failures retry the same report without overlap', async () => {
  const config = testConfig({ deliveryMaxAttempts: 3 });
  const bodies = [];
  const timestamps = [];
  const delays = [];
  let calls = 0;
  const reporter = new ListenerStatusReporter({
    config,
    clock: () => NOW,
    idFactory: () => REPORT_ID,
    sleep: async (delay) => {
      delays.push(delay);
    },
    async fetchImpl(_url, options) {
      calls += 1;
      bodies.push(Buffer.from(options.body).toString('utf8'));
      timestamps.push(options.headers['X-Live-Timestamp']);
      return calls === 1
        ? new Response(JSON.stringify({
          status: 'rejected',
          reason: 'database_error'
        }), { status: 500 })
        : new Response(JSON.stringify({ status: 'accepted' }), {
          status: 201
        });
    }
  });
  const result = await reporter.report(healthySnapshot());
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(timestamps, ['1700000000', '1700000001']);
  assert.equal(delays.length, 1);
});

test('lost accepted response replay is terminal success while stale is rejected', () => {
  assert.deepEqual(
    classifyStatusAck(409, {
      status: 'rejected',
      reason: 'listener_status_replay'
    }),
    { outcome: 'duplicate', retryable: false }
  );
  assert.deepEqual(
    classifyStatusAck(409, {
      status: 'rejected',
      reason: 'listener_status_stale'
    }),
    {
      outcome: 'stale',
      retryable: false,
      reason: 'listener_status_stale'
    }
  );
});

test('transport mapping is fail closed and never authenticates non-connected states', () => {
  assert.deepEqual(
    transportFromSnapshot({ enabled: false, state: 'disabled' }),
    { transport_state: 'disabled', authenticated: false }
  );
  assert.deepEqual(
    transportFromSnapshot({ enabled: true, state: 'reconnecting' }),
    { transport_state: 'connecting', authenticated: false }
  );
  assert.deepEqual(
    transportFromSnapshot({ enabled: true, state: 'degraded' }),
    { transport_state: 'disconnected', authenticated: false }
  );
  assert.deepEqual(
    transportFromSnapshot({ enabled: true, state: 'configuration_error' }),
    { transport_state: 'unavailable', authenticated: false }
  );
});
