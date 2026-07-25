const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProductionRuntime
} = require('../src/productionRuntime');
const {
  OPERATIONS,
  encodePacket,
  parsePackets
} = require('../src/officialProtocol');
const {
  FakeWebSocket,
  danmakuCommand,
  giftCommand,
  officialResponse,
  validStartData
} = require('./helpers/fakeOfficial');
const { FakeTimers } = require('./helpers/fakeTimers');
const { withNetworkGuard } = require('./helpers/networkGuard');

function completeOfficialEnv(dataDir) {
  return {
    LISTENER_SITE_ID: 'synthetic-e2e-site',
    LISTENER_INSTANCE_ID: 'synthetic-e2e-instance',
    LISTENER_ROOM_ID: '123456',
    LISTENER_BACKEND_URL: 'http://127.0.0.1:49152',
    LISTENER_DATA_DIR: dataDir,
    LISTENER_DELIVERY_RETRY_INITIAL_MS: '10',
    LISTENER_DELIVERY_RETRY_MAX_MS: '10',
    LIVE_EVENT_INGEST_SECRET: 'synthetic-backend-secret-32-bytes-long',
    LIVE_EVENT_INGEST_ENABLED: 'true',
    BILIBILI_LISTENER_ENABLED: 'true',
    BILIBILI_OFFICIAL_API_ENABLED: 'true',
    BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
    BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'false',
    BILIBILI_APP_ID: '1000000000001',
    BILIBILI_ACCESS_KEY_ID: 'synthetic-access-key',
    BILIBILI_ACCESS_KEY_SECRET: 'synthetic-official-secret-32-bytes',
    BILIBILI_IDENTITY_CODE: 'synthetic-identity-code',
    BILIBILI_API_HEARTBEAT_INTERVAL_MS: '5000',
    BILIBILI_WS_HEARTBEAT_INTERVAL_MS: '5000',
    BILIBILI_WS_HEARTBEAT_TIMEOUT_MS: '6000'
  };
}

function messagePacket(value) {
  return encodePacket({
    operation: OPERATIONS.MESSAGE,
    body: Buffer.from(JSON.stringify(value), 'utf8')
  });
}

async function waitFor(predicate, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('synthetic runtime did not reach the expected state');
}

test('official runtime completes REST/WSS lifecycle and durable delivery offline', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-official-e2e-')
  );
  const timers = new FakeTimers();
  const calls = {
    start: 0,
    heartbeat: 0,
    end: 0,
    ingest: 0,
    lookup: 0
  };
  const accepted = new Map();
  const sockets = [];
  class OfflineWebSocket extends FakeWebSocket {
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
  }

  try {
    await withNetworkGuard(async (networkCalls) => {
      const runtime = createProductionRuntime({
        source: 'bilibili-official',
        env: completeOfficialEnv(dataDir),
        clock: timers.clock,
        setTimer: timers.setTimeout,
        clearTimer: timers.clearTimeout,
        lookup: async () => {
          calls.lookup += 1;
          return [{ address: '93.184.216.34', family: 4 }];
        },
        webSocketImpl: OfflineWebSocket,
        async fetchImpl(url, options) {
          const parsed = new URL(url);
          if (parsed.origin === 'https://live-open.biliapi.com') {
            if (parsed.pathname === '/v2/app/start') {
              calls.start += 1;
              return officialResponse(validStartData({
                links: ['wss://session-gateway.example.net/sub']
              }));
            }
            if (parsed.pathname === '/v2/app/heartbeat') {
              calls.heartbeat += 1;
              return officialResponse({});
            }
            if (parsed.pathname === '/v2/app/end') {
              calls.end += 1;
              return officialResponse({});
            }
          }
          if (
            parsed.origin === 'http://127.0.0.1:49152' &&
            parsed.pathname === '/api/internal/live-events/v1/ingest'
          ) {
            calls.ingest += 1;
            const event = JSON.parse(Buffer.from(options.body).toString('utf8'));
            const body = Buffer.from(options.body).toString('utf8');
            if (accepted.has(event.event_id)) {
              return new Response(JSON.stringify({
                status: accepted.get(event.event_id) === body
                  ? 'duplicate'
                  : 'rejected',
                ...(accepted.get(event.event_id) === body
                  ? {}
                  : { reason: 'event_id_conflict' })
              }), {
                status: accepted.get(event.event_id) === body ? 200 : 409
              });
            }
            accepted.set(event.event_id, body);
            return new Response(JSON.stringify({ status: 'accepted' }), {
              status: 201
            });
          }
          throw new Error('unexpected synthetic URL');
        }
      });

      await runtime.start();
      assert.equal(sockets.length, 1);
      sockets[0].receive(messagePacket(danmakuCommand({
        msgId: 'synthetic-e2e-dm',
        message: '点歌 年轮'
      })));
      sockets[0].receive(messagePacket(giftCommand({
        msgId: 'synthetic-e2e-gift'
      })));
      await waitFor(() => runtime.snapshot().accepted === 2);
      sockets[0].receive(messagePacket(danmakuCommand({
        msgId: 'synthetic-e2e-dm',
        message: '点歌 年轮'
      })));
      await waitFor(() => runtime.snapshot().duplicate === 1);
      assert.equal(runtime.snapshot().spool.pending_count, 0);
      assert.equal(accepted.size, 2);

      await timers.advance(5000);
      await new Promise((resolve) => setImmediate(resolve));
      await timers.flush();
      const snapshot = runtime.snapshot();
      assert.equal(snapshot.source.api_heartbeat_success, 1);
      assert.equal(snapshot.source.ws_heartbeat_reply, 1);
      assert.equal(snapshot.source.websocket_authenticated, true);
      assert.equal(calls.lookup, 2);

      const outboundOperations = sockets[0].sent.flatMap((frame) => (
        parsePackets(frame).map((packet) => packet.operation)
      ));
      assert.deepEqual(
        new Set(outboundOperations),
        new Set([OPERATIONS.AUTH, OPERATIONS.HEARTBEAT])
      );

      await runtime.stop();
      assert.equal(calls.start, 1);
      assert.equal(calls.heartbeat, 1);
      assert.equal(calls.end, 1);
      assert.equal(calls.ingest, 3);
      assert.deepEqual(networkCalls, []);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
