const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  DeliveryClient,
  MAX_ACK_BYTES,
  classifyAck,
  prepareEvent,
  signRawBody
} = require('../src/deliveryClient');
const {
  signRawBody: phase4dSignRawBody
} = require('../../../tools/live-event-simulator/src/signer');
const { mapSourceEvent } = require('../src/eventMapper');
const { syntheticDanmaku } = require('../src/syntheticFixtures');
const { testConfig } = require('./helpers/testConfig');

function response(status, value) {
  const text = JSON.stringify(value);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function preparedFixture(config = testConfig()) {
  return prepareEvent(
    mapSourceEvent(
      syntheticDanmaku('phase4e-delivery-fixture'),
      config
    ).event
  );
}

test('HMAC exactly matches the Phase 4D and Phase 4B raw-byte contract', () => {
  const secret = crypto.randomBytes(48).toString('base64url');
  const timestamp = '1784764800';
  const rawBody = Buffer.from('{"synthetic":true}', 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
  assert.equal(
    signRawBody({ secret, timestamp, rawBody }),
    expected
  );
  assert.equal(
    signRawBody({ secret, timestamp, rawBody }),
    phase4dSignRawBody({ secret, timestamp, rawBody })
  );
});

test('prepared delivery serializes and hashes validated event bytes once', () => {
  const prepared = preparedFixture();
  assert.equal(
    prepared.bodyHash,
    crypto.createHash('sha256').update(prepared.rawBody).digest('hex')
  );
  assert.equal(JSON.parse(prepared.rawBody).event_id, prepared.eventId);
});

test('ACK classifier matches accepted, duplicate, conflict, transient, and permanent contracts', () => {
  assert.equal(classifyAck(201, { status: 'accepted' }).outcome, 'accepted');
  assert.equal(classifyAck(200, { status: 'duplicate' }).outcome, 'duplicate');
  assert.equal(classifyAck(409, {
    status: 'rejected',
    reason: 'event_id_conflict'
  }).outcome, 'conflict');
  assert.equal(classifyAck(500, {
    status: 'rejected',
    reason: 'database_error'
  }).retryable, true);
  assert.equal(classifyAck(500, {
    status: 'rejected',
    reason: 'unexpected_internal_error'
  }).retryable, true);
  assert.equal(classifyAck(599, {
    status: 'rejected',
    reason: 'unknown_server_error'
  }).retryable, true);
  assert.equal(classifyAck(503, {
    status: 'rejected',
    reason: 'ingest_unavailable'
  }).retryable, false);
  assert.equal(classifyAck(422, {
    status: 'rejected',
    reason: 'invalid_event_schema'
  }).retryable, false);
  assert.equal(classifyAck(422, {
    status: 'rejected',
    reason: 'secret=value must not enter health'
  }).reason, 'schema_invalid');
});

test('201, 200, and 409 terminate without retries', async () => {
  for (const [status, ack, outcome] of [
    [201, { status: 'accepted' }, 'accepted'],
    [200, { status: 'duplicate' }, 'duplicate'],
    [409, { status: 'rejected', reason: 'event_id_conflict' }, 'conflict']
  ]) {
    let calls = 0;
    const client = new DeliveryClient({
      config: testConfig(),
      fetchImpl: async () => {
        calls += 1;
        return response(status, ack);
      }
    });
    const result = await client.deliverPrepared(preparedFixture());
    assert.equal(result.outcome, outcome);
    assert.equal(calls, 1);
  }
});

test('temporary failures retry finitely with stable body and event id', async () => {
  const config = testConfig();
  const prepared = preparedFixture(config);
  const attempts = [];
  const client = new DeliveryClient({
    config,
    clock: () => 1784764800000,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      attempts.push({
        url: String(url),
        body: Buffer.from(options.body),
        timestamp: options.headers['X-Live-Timestamp'],
        signature: options.headers['X-Live-Signature'],
        redirect: options.redirect
      });
      return attempts.length === 1
        ? response(500, { status: 'rejected', reason: 'database_error' })
        : response(201, { status: 'accepted' });
    }
  });
  const result = await client.deliverPrepared(prepared);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.retries, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.equals(attempts[1].body), true);
  assert.equal(JSON.parse(attempts[0].body).event_id, prepared.eventId);
  assert.notEqual(attempts[0].timestamp, attempts[1].timestamp);
  assert.notEqual(attempts[0].signature, attempts[1].signature);
  assert.deepEqual(new Set(attempts.map((item) => item.redirect)), new Set(['error']));
});

test('timeout covers ACK body streaming after response headers arrive', async () => {
  const client = new DeliveryClient({
    config: {
      ...testConfig(),
      deliveryTimeoutMs: 5,
      deliveryMaxAttempts: 1
    },
    fetchImpl: async () => new Response(new ReadableStream({
      start() {
        // The response headers arrive, but the synthetic body never completes.
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  });
  assert.deepEqual(await client.deliverPrepared(preparedFixture()), {
    outcome: 'failed',
    reason: 'delivery_timeout',
    attempts: 1,
    retries: 0
  });
});

test('streamed ACK without Content-Length is rejected before exceeding 16 KiB', async () => {
  let calls = 0;
  const client = new DeliveryClient({
    config: testConfig(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_ACK_BYTES));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const result = await client.deliverPrepared(preparedFixture());
  assert.equal(result.outcome, 'permanent_failure');
  assert.equal(result.reason, 'ack_too_large');
  assert.equal(calls, 1);
});

test('disabled ingest is classified distinctly and is not blindly retried', async () => {
  let calls = 0;
  const client = new DeliveryClient({
    config: testConfig(),
    fetchImpl: async () => {
      calls += 1;
      return response(503, {
        status: 'rejected',
        reason: 'ingest_unavailable'
      });
    }
  });
  const result = await client.deliverPrepared(preparedFixture());
  assert.equal(result.outcome, 'ingest_disabled');
  assert.equal(calls, 1);
});

test('temporary failure stops after the configured maximum attempts', async () => {
  let calls = 0;
  const client = new DeliveryClient({
    config: { ...testConfig(), deliveryMaxAttempts: 2 },
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return response(500, {
        status: 'rejected',
        reason: 'database_error'
      });
    }
  });
  const result = await client.deliverPrepared(preparedFixture());
  assert.deepEqual(result, {
    outcome: 'failed',
    reason: 'database_error',
    attempts: 2,
    retries: 1
  });
  assert.equal(calls, 2);
});

test('shutdown abort cancels a pending delivery retry timer', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new DeliveryClient({
    config: testConfig(),
    fetchImpl: async () => {
      calls += 1;
      return response(500, {
        status: 'rejected',
        reason: 'database_error'
      });
    }
  });
  const pending = client.deliverPrepared(preparedFixture(), {
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'delivery_aborted');
  assert.equal(calls, 1);
});

test('network timeout is finite and exposes only a stable reason', async () => {
  const client = new DeliveryClient({
    config: { ...testConfig(), deliveryTimeoutMs: 5, deliveryMaxAttempts: 1 },
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      void url;
      void resolve;
      options.signal.addEventListener('abort', () => reject(new Error('private response body')));
    })
  });
  const result = await client.deliverPrepared(preparedFixture());
  assert.deepEqual(result, {
    outcome: 'failed',
    reason: 'delivery_timeout',
    attempts: 1,
    retries: 0
  });
  assert.doesNotMatch(JSON.stringify(result), /private response body/);
});

test('remote redirect targets cannot be supplied or followed', async () => {
  assert.throws(
    () => new DeliveryClient({
      config: {
        ...testConfig(),
        backendUrl: 'https://preview.chengzhisweety.com'
      }
    }),
    { code: 'remote_backend_rejected' }
  );
  let redirectMode;
  const client = new DeliveryClient({
    config: testConfig(),
    fetchImpl: async (url, options) => {
      void url;
      redirectMode = options.redirect;
      throw new TypeError('redirect rejected');
    }
  });
  await client.deliverPrepared(preparedFixture());
  assert.equal(redirectMode, 'error');
});
