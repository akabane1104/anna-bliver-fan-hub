const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialBilibiliAdapter } = require('../src/officialBilibiliAdapter');
const { ListenerSupervisor } = require('../src/listenerSupervisor');
const { testConfig } = require('./helpers/testConfig');

function adapterConfig() {
  return {
    roomId: '123456',
    authTimeoutMs: 100,
    apiHeartbeatIntervalMs: 1000,
    wsHeartbeatIntervalMs: 1000,
    wsHeartbeatTimeoutMs: 1500,
    apiHeartbeatFailureThreshold: 2,
    endTimeoutMs: 100
  };
}

function zeroSideEffectAdapter() {
  const counts = {
    authDiscovery: 0,
    bootstrap: 0,
    apiHeartbeat: 0,
    apiEnd: 0,
    socketFactory: 0
  };
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {
      async start() {
        counts.authDiscovery += 1;
        counts.bootstrap += 1;
        return {
          roomId: '123456',
          gameId: 'synthetic-unreachable-game',
          authBody: '{"synthetic":"unreachable"}',
          wssLinks: ['wss://synthetic-unverified.invalid/unverified']
        };
      },
      async heartbeat() {
        counts.apiHeartbeat += 1;
      },
      async end() {
        counts.apiEnd += 1;
      }
    },
    webSocketFactory() {
      counts.socketFactory += 1;
      throw new Error('socket factory must remain unreachable');
    }
  });
  return { adapter, counts };
}

function assertBoundaryError(error) {
  assert.equal(error.code, 'official_wss_allowlist_unverified');
  assert.equal(error.fatal, true);
  assert.equal(error.message, 'Listener operation failed');
  return true;
}

test('direct Adapter connect fails before auth discovery, bootstrap, or socket factory', async () => {
  const { adapter, counts } = zeroSideEffectAdapter();
  await assert.rejects(
    () => adapter.connect({ roomId: '123456' }),
    assertBoundaryError
  );
  assert.deepEqual(counts, {
    authDiscovery: 0,
    bootstrap: 0,
    apiHeartbeat: 0,
    apiEnd: 0,
    socketFactory: 0
  });
  assert.equal(adapter.snapshot().wss_link_attempts, 0);
  assert.equal(adapter.snapshot().source_state, 'idle');
});

test('direct low-level socket method cannot bypass the evidence boundary', async () => {
  const { adapter, counts } = zeroSideEffectAdapter();
  await assert.rejects(
    () => adapter._connectSocket(
      new URL('wss://synthetic-unverified.invalid/unverified'),
      1,
      new AbortController().signal
    ),
    assertBoundaryError
  );
  assert.equal(counts.socketFactory, 0);
  assert.equal(adapter.snapshot().wss_link_attempts, 0);
});

test('Supervisor treats the boundary as fatal without delivery or reconnect', async () => {
  const { adapter, counts } = zeroSideEffectAdapter();
  const sideEffects = {
    backendPrepare: 0,
    backendIngest: 0,
    reconnectSchedules: 0
  };
  const supervisor = new ListenerSupervisor({
    config: testConfig({
      roomId: '123456',
      connectTimeoutMs: 100,
      reconnectInitialMs: 50,
      reconnectMaxMs: 50
    }),
    adapter,
    deliveryClient: {
      prepare() {
        sideEffects.backendPrepare += 1;
      },
      async deliverPrepared() {
        sideEffects.backendIngest += 1;
      }
    },
    logger: { write() {} }
  });
  const originalScheduleReconnect = supervisor._scheduleReconnect.bind(supervisor);
  supervisor._scheduleReconnect = (...args) => {
    sideEffects.reconnectSchedules += 1;
    return originalScheduleReconnect(...args);
  };

  const snapshot = await supervisor.start();
  assert.equal(snapshot.state, 'fatal');
  assert.equal(snapshot.reconnect_count, 0);
  assert.deepEqual(counts, {
    authDiscovery: 0,
    bootstrap: 0,
    apiHeartbeat: 0,
    apiEnd: 0,
    socketFactory: 0
  });
  assert.deepEqual(sideEffects, {
    backendPrepare: 0,
    backendIngest: 0,
    reconnectSchedules: 0
  });
  await supervisor.stop();
});
