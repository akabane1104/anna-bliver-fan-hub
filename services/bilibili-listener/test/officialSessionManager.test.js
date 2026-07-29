const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OfficialSessionManager,
  OFFICIAL_SESSION_STATES
} = require('../src/officialSessionManager');
const {
  createOfficialWssSessionTrust
} = require('../src/officialWssUrl');
const { FakeWebSocket } = require('./helpers/fakeOfficial');

const publicLookup = async () => [{
  address: '93.184.216.34',
  family: 4
}];

function config(overrides = {}) {
  return {
    roomId: '123456',
    initialRecoveryWaitMs: 0,
    duplicateRetryMinMs: 10,
    duplicateRetryMaxMs: 10,
    lockRetryMs: 10,
    wssReconnectInitialMs: 1,
    wssReconnectMaxMs: 10,
    authTimeoutMs: 100,
    apiHeartbeatIntervalMs: 20000,
    apiHeartbeatFailureThreshold: 2,
    wsHeartbeatIntervalMs: 20000,
    wsHeartbeatTimeoutMs: 30000,
    aiCleanupIntervalMs: 3600000,
    ...overrides
  };
}

function startedSession() {
  return {
    roomId: '123456',
    gameId: 'synthetic-game',
    wssTrust: createOfficialWssSessionTrust({
      authBody: '{"synthetic":"auth"}',
      wssLinks: ['wss://session-gateway.example.net/sub']
    })
  };
}

async function waitFor(check, timeoutMs = 500) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition timed out');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createManager({
  apiClient,
  webSocketFactory,
  sleep,
  sessionLock,
  logger
} = {}) {
  return new OfficialSessionManager({
    config: config(),
    apiClient: apiClient || {
      async start() {
        return startedSession();
      },
      async heartbeat() {},
      async end() {}
    },
    sessionLock: sessionLock || {
      async acquire() {
        return true;
      },
      async isHeld() {
        return true;
      },
      async release() {}
    },
    eventProcessor: {
      repository: { async cleanupExpired() {} },
      async process() {},
      snapshot() {
        return {};
      }
    },
    webSocketFactory: webSocketFactory || (() => new FakeWebSocket()),
    logger,
    lookup: publicLookup,
    sleep
  });
}

test('single owner starts one session and graceful shutdown ends it once', async () => {
  const counts = { start: 0, end: 0 };
  const manager = createManager({
    apiClient: {
      async start() {
        counts.start += 1;
        return startedSession();
      },
      async heartbeat() {},
      async end() {
        counts.end += 1;
      }
    }
  });
  await manager.start();
  await waitFor(() => manager.snapshot().state === OFFICIAL_SESSION_STATES.ACTIVE);
  assert.equal(counts.start, 1);
  await assert.rejects(() => manager.start(), {
    code: 'listener_already_started'
  });
  await manager.stop();
  await manager.stop();
  assert.equal(counts.end, 1);
});

test('official_session_duplicate enters healthy waiting without a start loop', async () => {
  let startCalls = 0;
  let endCalls = 0;
  let releaseWait;
  const sleepCalls = [];
  const logRecords = [];
  const waiting = new Promise((resolve) => {
    releaseWait = resolve;
  });
  const manager = createManager({
    apiClient: {
      async start() {
        startCalls += 1;
        const error = new Error('duplicate');
        error.code = 'official_session_duplicate';
        throw error;
      },
      async heartbeat() {},
      async end() {
        endCalls += 1;
      }
    },
    sleep(ms) {
      if (ms === 0) return Promise.resolve(true);
      sleepCalls.push(ms);
      return waiting;
    },
    logger: {
      write(level, code, fields) {
        logRecords.push({ level, code, fields });
      }
    }
  });
  await manager.start();
  await waitFor(() => manager.snapshot().duplicate_responses === 1);
  assert.equal(
    manager.snapshot().state,
    OFFICIAL_SESSION_STATES.WAITING_FOR_OFFICIAL_SESSION
  );
  assert.equal(startCalls, 1);
  assert.equal(endCalls, 0);
  assert.deepEqual(sleepCalls, [10]);
  assert.deepEqual(logRecords.at(-1), {
    level: 'info',
    code: 'official_session_retry_scheduled',
    fields: {
      state: OFFICIAL_SESSION_STATES.WAITING_FOR_OFFICIAL_SESSION,
      result: 'healthy',
      error_code: 'official_session_duplicate',
      retry_attempt: 1,
      duration_ms: 10
    }
  });
  releaseWait(false);
  await manager.stop();
});

test('post-start WSS validation failure ends once and remains healthy waiting', async () => {
  let startCalls = 0;
  let endCalls = 0;
  let releaseWait;
  const waiting = new Promise((resolve) => {
    releaseWait = resolve;
  });
  const manager = createManager({
    apiClient: {
      async start() {
        startCalls += 1;
        return {
          ...startedSession(),
          wssTrust: createOfficialWssSessionTrust({
            authBody: '{"synthetic":"auth"}',
            wssLinks: ['ws://unsafe.example.net/sub']
          })
        };
      },
      async heartbeat() {},
      async end() {
        endCalls += 1;
      }
    },
    sleep(ms) {
      if (ms === 0) return Promise.resolve(true);
      return waiting;
    }
  });
  await manager.start();
  await waitFor(() => endCalls === 1);
  assert.equal(startCalls, 1);
  assert.equal(endCalls, 1);
  assert.equal(
    manager.snapshot().state,
    OFFICIAL_SESSION_STATES.WAITING_FOR_OFFICIAL_SESSION
  );
  assert.equal(manager.snapshot().last_error_code, 'invalid_official_wss_link');
  releaseWait(false);
  await manager.stop();
  assert.equal(endCalls, 1);
});

test('WSS disconnect reconnects with the same session and never calls start again', async () => {
  const sockets = [];
  let startCalls = 0;
  const manager = createManager({
    apiClient: {
      async start() {
        startCalls += 1;
        return startedSession();
      },
      async heartbeat() {},
      async end() {}
    },
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  try {
    await manager.start();
    await waitFor(() => manager.snapshot().state === OFFICIAL_SESSION_STATES.ACTIVE);
    sockets[0].remoteClose();
    await waitFor(() => (
      sockets.length === 2 &&
      manager.snapshot().websocket_authenticated
    ));
    assert.equal(startCalls, 1);
    assert.equal(manager.snapshot().wss_reconnects, 1);
  } finally {
    await manager.stop();
  }
});

test('controlled reconnect preserves the project session and start count', async () => {
  let startCalls = 0;
  const manager = createManager({
    apiClient: {
      async start() {
        startCalls += 1;
        return startedSession();
      },
      async heartbeat() {},
      async end() {}
    }
  });
  await manager.start();
  await waitFor(() => manager.snapshot().state === OFFICIAL_SESSION_STATES.ACTIVE);
  const result = await manager.controlledReconnect();
  assert.deepEqual(result, {
    status: 'reconnected',
    startAttemptsUnchanged: true
  });
  assert.equal(startCalls, 1);
  await manager.stop();
});

test('lock contention prevents all official start requests', async () => {
  let starts = 0;
  let releaseWait;
  const waiting = new Promise((resolve) => {
    releaseWait = resolve;
  });
  const manager = createManager({
    apiClient: {
      async start() {
        starts += 1;
      }
    },
    sessionLock: {
      async acquire() {
        return false;
      },
      async release() {}
    },
    sleep() {
      return waiting;
    }
  });
  await manager.start();
  await waitFor(() => manager.snapshot().lock_contention === 1);
  assert.equal(starts, 0);
  releaseWait(false);
  await manager.stop();
});
