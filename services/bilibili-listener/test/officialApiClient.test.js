const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_OFFICIAL_RESPONSE_BYTES,
  OFFICIAL_API_ORIGIN,
  OFFICIAL_API_PATHS,
  OfficialApiClient,
  classifyOfficialCode
} = require('../src/officialApiClient');
const {
  getOfficialWssAuthBody,
  validateOfficialWssLinks
} = require('../src/officialWssUrl');
const {
  officialResponse,
  validStartData
} = require('./helpers/fakeOfficial');

function clientOptions(overrides = {}) {
  return {
    accessKeyId: 'synthetic-access-key',
    accessKeySecret: 'synthetic-access-secret-32-bytes!!',
    appId: '1000000000001',
    identityCode: 'synthetic-identity-code',
    expectedRoomId: '123456',
    timeoutMs: 100,
    clock: () => 1624594467000,
    nonce: () => 'ad184c09-095f-91c3-0849-230dd3744045',
    ...overrides
  };
}

test('official client fixes origin, path, method, headers, and exact body bytes', async () => {
  const calls = [];
  const client = new OfficialApiClient(clientOptions({
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return officialResponse(validStartData());
    }
  }));
  const session = await client.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, `${OFFICIAL_API_ORIGIN}${OFFICIAL_API_PATHS.start}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[0].options.body).toString('utf8')),
    { code: 'synthetic-identity-code', app_id: 1000000000001 }
  );
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.match(calls[0].options.headers.Authorization, /^[a-f0-9]{64}$/);
  assert.equal(session.roomId, '123456');
  const links = await validateOfficialWssLinks(session.wssTrust, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(links.length, 1);
  assert.equal(
    getOfficialWssAuthBody(session.wssTrust, links[0]),
    '{"key":"synthetic-auth-body"}'
  );
  assert.equal('authBody' in session, false);
  assert.equal('wssLinks' in session, false);
});

test('heartbeat and end preserve documented wire types and use new nonces', async () => {
  const bodies = [];
  const nonces = ['synthetic-nonce-0001', 'synthetic-nonce-0002'];
  const client = new OfficialApiClient(clientOptions({
    nonce: () => nonces.shift(),
    async fetchImpl(url, options) {
      bodies.push({
        path: url.pathname,
        body: JSON.parse(Buffer.from(options.body).toString('utf8')),
        nonce: options.headers['x-bili-signature-nonce']
      });
      return officialResponse({});
    }
  }));
  await client.heartbeat('synthetic-game-1');
  await client.end('synthetic-game-1');
  assert.deepEqual(bodies, [
    {
      path: OFFICIAL_API_PATHS.heartbeat,
      body: { game_id: 'synthetic-game-1' },
      nonce: 'synthetic-nonce-0001'
    },
    {
      path: OFFICIAL_API_PATHS.end,
      body: { app_id: 1000000000001, game_id: 'synthetic-game-1' },
      nonce: 'synthetic-nonce-0002'
    }
  ]);
});

test('start preserves room for Adapter binding and rejects unsafe official int64 values', async () => {
  const mismatch = new OfficialApiClient(clientOptions({
    fetchImpl: async () => officialResponse(validStartData({ roomId: 123457 }))
  }));
  assert.equal((await mismatch.start()).roomId, '123457');

  const unsafe = new OfficialApiClient(clientOptions({
    fetchImpl: async () => officialResponse(validStartData({
      roomId: Number.MAX_SAFE_INTEGER + 1
    }))
  }));
  await assert.rejects(
    () => unsafe.start(),
    { code: 'invalid_official_start_response' }
  );
});

test('known and unknown official errors are normalized without response bodies', async () => {
  assert.deepEqual(classifyOfficialCode(7001), {
    code: 'official_session_cooling_down',
    transient: true
  });
  assert.deepEqual(classifyOfficialCode(9999), {
    code: 'official_unknown_error',
    transient: false
  });
  const client = new OfficialApiClient(clientOptions({
    fetchImpl: async () => officialResponse({}, {
      code: 4002,
      message: 'synthetic response detail'
    })
  }));
  await assert.rejects(
    () => client.heartbeat('synthetic-game-1'),
    (error) => {
      assert.equal(error.code, 'official_signature_error');
      assert.equal(error.transient, false);
      assert.doesNotMatch(error.message, /synthetic response detail/);
      return true;
    }
  );
});

test('client does not retry transient codes and enforces response size', async () => {
  let calls = 0;
  const transient = new OfficialApiClient(clientOptions({
    async fetchImpl() {
      calls += 1;
      return officialResponse({}, { code: 5001 });
    }
  }));
  await assert.rejects(
    () => transient.heartbeat('synthetic-game-1'),
    { code: 'official_service_timeout' }
  );
  assert.equal(calls, 1);

  const oversized = new OfficialApiClient(clientOptions({
    fetchImpl: async () => new Response('x', {
      status: 200,
      headers: {
        'Content-Length': String(MAX_OFFICIAL_RESPONSE_BYTES + 1)
      }
    })
  }));
  await assert.rejects(
    () => oversized.heartbeat('synthetic-game-1'),
    { code: 'official_response_too_large' }
  );
});

test('timeout covers the response body and AbortSignal cancels safely', async () => {
  const timeout = new OfficialApiClient(clientOptions({
    timeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({
      start() {}
    }), { status: 200 })
  }));
  await assert.rejects(
    () => timeout.heartbeat('synthetic-game-1'),
    { code: 'official_request_timeout' }
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = new OfficialApiClient(clientOptions({
    fetchImpl: async (_url, options) => {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return officialResponse({});
    }
  }));
  await assert.rejects(
    () => aborted.heartbeat('synthetic-game-1', { signal: controller.signal }),
    { code: 'official_request_aborted' }
  );
});
