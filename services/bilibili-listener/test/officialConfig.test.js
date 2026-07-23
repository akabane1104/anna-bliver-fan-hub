const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadOfficialBilibiliConfig
} = require('../src/config');
const { main, parseArguments } = require('../src/cli');
const { createProductionRuntime } = require('../src/productionRuntime');
const { withNetworkGuard } = require('./helpers/networkGuard');

function officialEnv(overrides = {}) {
  return {
    LISTENER_SITE_ID: 'synthetic-site',
    LISTENER_INSTANCE_ID: 'synthetic-instance',
    LISTENER_ROOM_ID: '123456',
    LISTENER_BACKEND_URL: 'http://127.0.0.1:5000',
    LIVE_EVENT_INGEST_SECRET: 'synthetic-backend-secret-32-bytes-long',
    BILIBILI_APP_ID: '1000000000001',
    BILIBILI_ACCESS_KEY_ID: 'synthetic-access-key',
    BILIBILI_ACCESS_KEY_SECRET: 'synthetic-official-secret-32-bytes',
    BILIBILI_IDENTITY_CODE: 'synthetic-identity-code',
    ...overrides
  };
}

test('official config validates explicit env without loading dotenv', () => {
  const config = loadOfficialBilibiliConfig(officialEnv(), {
    expectedRoomId: '123456'
  });
  assert.equal(config.appId, '1000000000001');
  assert.equal(config.roomId, '123456');
  assert.equal(config.apiHeartbeatIntervalMs, 20000);
  assert.equal(config.wsHeartbeatIntervalMs, 20000);
  assert.equal(config.wsHeartbeatTimeoutMs, 30000);
  assert.equal(config.apiHeartbeatFailureThreshold, 2);
});

test('official credentials, placeholders, and cross-protocol secret reuse fail closed', () => {
  for (const patch of [
    { BILIBILI_ACCESS_KEY_ID: '' },
    { BILIBILI_ACCESS_KEY_SECRET: 'replace-me-with-secret' },
    { BILIBILI_IDENTITY_CODE: 'example-code' },
    { BILIBILI_APP_ID: '100' },
    { BILIBILI_APP_ID: '9999999999999999' },
    {
      BILIBILI_ACCESS_KEY_SECRET: 'synthetic-backend-secret-32-bytes-long'
    }
  ]) {
    assert.throws(
      () => loadOfficialBilibiliConfig(officialEnv(patch), {
        expectedRoomId: '123456'
      })
    );
  }
});

test('official heartbeat settings enforce conservative documented bounds', () => {
  assert.throws(
    () => loadOfficialBilibiliConfig(officialEnv({
      BILIBILI_API_HEARTBEAT_INTERVAL_MS: '20001'
    }), { expectedRoomId: '123456' }),
    { code: 'invalid_numeric_config' }
  );
  assert.throws(
    () => loadOfficialBilibiliConfig(officialEnv({
      BILIBILI_WS_HEARTBEAT_INTERVAL_MS: '30000',
      BILIBILI_WS_HEARTBEAT_TIMEOUT_MS: '30000'
    }), { expectedRoomId: '123456' }),
    { code: 'invalid_bilibili_heartbeat_range' }
  );
});

test('official source is explicit opt-in and all credential CLI flags are rejected', () => {
  assert.deepEqual(
    parseArguments(['start', '--source=bilibili-official', '--json']),
    {
      mode: 'start',
      json: true,
      source: 'bilibili-official'
    }
  );
  assert.throws(
    () => parseArguments(['dry-run', '--source=bilibili-official']),
    { code: 'invalid_argument' }
  );
  for (const flag of [
    '--access-key-secret=hidden',
    '--identity-code=hidden',
    '--api-base-url=https://example.com',
    '--wss-url=wss://example.com/sub',
    '--skip-url-validation'
  ]) {
    assert.throws(() => parseArguments(['start', flag]));
  }
});

test('CLI official mode fails at the evidence boundary before config or network', async () => {
  const counts = {
    fetch: 0,
    websocketConstructions: 0,
    reconnectSchedules: 0
  };
  const output = { value: '', write(chunk) { this.value += chunk; } };
  const exitCode = await withNetworkGuard(async (networkCalls) => {
    const result = await main([
      'start',
      '--source=bilibili-official',
      '--json'
    ], {
      stdout: output,
      env: {},
      productionRuntimeFactory(options) {
        return createProductionRuntime({
          ...options,
          fetchImpl() {
            counts.fetch += 1;
            throw new Error('network must not run');
          },
          webSocketImpl: class {
            constructor() {
              counts.websocketConstructions += 1;
            }
          },
          setTimer() {
            counts.reconnectSchedules += 1;
          }
        });
      }
    });
    assert.deepEqual(networkCalls, []);
    return result;
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(counts, {
    fetch: 0,
    websocketConstructions: 0,
    reconnectSchedules: 0
  });
  assert.deepEqual(JSON.parse(output.value), {
    status: 'failed',
    error_code: 'official_wss_allowlist_unverified'
  });
});

test('fixed Node 20 start script enables the built-in WebSocket client', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  assert.equal(
    packageJson.scripts.start,
    'node --experimental-websocket src/cli.js start'
  );
  assert.deepEqual(packageJson.dependencies, undefined);
});

test('complete settings and environment bypass attempts still have zero side effects', () => {
  for (const bypass of [
    {},
    {
      OFFICIAL_WSS_ALLOWLIST_VERIFIED: 'true',
      OFFICIAL_WSS_EVIDENCE_VERIFIED: 'true',
      BILIBILI_WSS_URL: 'wss://synthetic-unverified.invalid/unverified'
    }
  ]) {
    const counts = {
      fetch: 0,
      authDiscovery: 0,
      bootstrap: 0,
      backendIngest: 0,
      websocketConstructions: 0,
      socketFactory: 0,
      reconnectSchedules: 0
    };
    const sensitiveUrl = 'wss://user:secret@synthetic.invalid/unverified?token=hidden';
    assert.throws(
      () => createProductionRuntime({
        source: 'bilibili-official',
        env: officialEnv({
          ...bypass,
          BILIBILI_WSS_URL: bypass.BILIBILI_WSS_URL || sensitiveUrl
        }),
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
      }),
      (error) => {
        assert.equal(error.code, 'official_wss_allowlist_unverified');
        assert.equal(error.fatal, true);
        assert.doesNotMatch(error.message, /synthetic|secret|token|wss/i);
        return true;
      }
    );
    assert.deepEqual(counts, {
      fetch: 0,
      authDiscovery: 0,
      bootstrap: 0,
      backendIngest: 0,
      websocketConstructions: 0,
      socketFactory: 0,
      reconnectSchedules: 0
    });
  }
});

module.exports = {
  officialEnv
};
