const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../src/cli');
const { createProductionRuntime } = require('../src/productionRuntime');
const { withNetworkGuard } = require('./helpers/networkGuard');

function completeOfficialEnv() {
  return {
    LISTENER_SITE_ID: 'synthetic-e2e-site',
    LISTENER_INSTANCE_ID: 'synthetic-e2e-instance',
    LISTENER_ROOM_ID: '123456',
    LISTENER_BACKEND_URL: 'http://127.0.0.1:49152',
    LIVE_EVENT_INGEST_SECRET: 'synthetic-backend-secret-32-bytes-long',
    BILIBILI_APP_ID: '1000000000001',
    BILIBILI_ACCESS_KEY_ID: 'synthetic-access-key',
    BILIBILI_ACCESS_KEY_SECRET: 'synthetic-official-secret-32-bytes',
    BILIBILI_IDENTITY_CODE: 'synthetic-identity-code'
  };
}

test('official startup E2E fails closed with zero external side effects', async () => {
  const counts = {
    fetch: 0,
    authDiscovery: 0,
    bootstrap: 0,
    backendIngest: 0,
    websocketConstructions: 0,
    socketFactory: 0,
    reconnectSchedules: 0
  };
  const output = { value: '', write(chunk) { this.value += chunk; } };

  const exitCode = await withNetworkGuard(async (networkCalls) => {
    const result = await main(
      ['start', '--source=bilibili-official', '--json'],
      {
        stdout: output,
        env: completeOfficialEnv(),
        productionRuntimeFactory(options) {
          return createProductionRuntime({
            ...options,
            fetchImpl(url) {
              counts.fetch += 1;
              const href = String(url);
              if (href.includes('/v2/app/start')) {
                counts.authDiscovery += 1;
                counts.bootstrap += 1;
              }
              if (href.includes('/api/internal/live-events/v1/ingest')) {
                counts.backendIngest += 1;
              }
              throw new Error('fetch must remain unreachable');
            },
            webSocketImpl: class {
              constructor() {
                counts.socketFactory += 1;
                counts.websocketConstructions += 1;
              }
            },
            setTimer() {
              counts.reconnectSchedules += 1;
            }
          });
        }
      }
    );
    assert.deepEqual(networkCalls, []);
    return result;
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output.value), {
    status: 'failed',
    error_code: 'official_wss_allowlist_unverified'
  });
  assert.deepEqual(counts, {
    fetch: 0,
    authDiscovery: 0,
    bootstrap: 0,
    backendIngest: 0,
    websocketConstructions: 0,
    socketFactory: 0,
    reconnectSchedules: 0
  });
});
