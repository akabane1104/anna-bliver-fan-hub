const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OfficialBilibiliAdapter
} = require('../src/officialBilibiliAdapter');
const {
  OPERATIONS,
  encodePacket
} = require('../src/officialProtocol');
const {
  createOfficialWssSessionTrust,
  validateOfficialWssLinks
} = require('../src/officialWssUrl');
const {
  FakeWebSocket,
  danmakuCommand
} = require('./helpers/fakeOfficial');

function adapterConfig() {
  return {
    roomId: '123456',
    authTimeoutMs: 100,
    apiHeartbeatIntervalMs: 20000,
    wsHeartbeatIntervalMs: 20000,
    wsHeartbeatTimeoutMs: 30000,
    apiHeartbeatFailureThreshold: 2,
    endTimeoutMs: 100
  };
}

function trust(authBody = '{"synthetic":"auth"}') {
  return createOfficialWssSessionTrust({
    authBody,
    wssLinks: ['wss://session-gateway.example.net/sub']
  });
}

const publicLookup = async () => [{
  address: '93.184.216.34',
  family: 4
}];

test('Adapter starts, validates DNS twice, authenticates, and ends once', async () => {
  const counts = {
    start: 0,
    heartbeat: 0,
    end: 0,
    lookup: 0,
    socket: 0
  };
  let socket;
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {
      async start() {
        counts.start += 1;
        return {
          roomId: '123456',
          gameId: 'synthetic-game-1',
          wssTrust: trust()
        };
      },
      async heartbeat() {
        counts.heartbeat += 1;
      },
      async end() {
        counts.end += 1;
      }
    },
    async lookup() {
      counts.lookup += 1;
      return publicLookup();
    },
    webSocketFactory() {
      counts.socket += 1;
      socket = new FakeWebSocket();
      return socket;
    }
  });

  await adapter.connect({ roomId: '123456' });
  assert.equal(adapter.snapshot().source_state, 'connected');
  assert.equal(adapter.snapshot().websocket_authenticated, true);
  assert.equal(adapter.snapshot().wss_link_attempts, 1);
  assert.equal(counts.start, 1);
  assert.equal(counts.lookup, 2);
  assert.equal(counts.socket, 1);
  assert.equal(socket.sent.length, 1);

  await adapter.disconnect();
  await adapter.disconnect();
  assert.equal(counts.end, 1);
  assert.equal(adapter.snapshot().source_state, 'stopped');
});

test('private DNS from a valid start response fails before socket creation', async () => {
  const counts = { start: 0, end: 0, socket: 0 };
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {
      async start() {
        counts.start += 1;
        return {
          roomId: '123456',
          gameId: 'synthetic-game-1',
          wssTrust: trust()
        };
      },
      async heartbeat() {},
      async end() {
        counts.end += 1;
      }
    },
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    webSocketFactory() {
      counts.socket += 1;
      return new FakeWebSocket();
    }
  });
  await assert.rejects(
    () => adapter.connect({ roomId: '123456' }),
    (error) => {
      assert.equal(error.code, 'official_wss_non_public_address');
      assert.equal(error.fatal, true);
      return true;
    }
  );
  assert.deepEqual(counts, { start: 1, end: 1, socket: 0 });
});

test('low-level socket connect rejects a link from another session', async () => {
  const first = trust('{"session":1}');
  const second = trust('{"session":2}');
  const [link] = await validateOfficialWssLinks(first, {
    lookup: publicLookup
  });
  let socketCalls = 0;
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {},
    lookup: publicLookup,
    webSocketFactory() {
      socketCalls += 1;
      return new FakeWebSocket();
    }
  });
  await assert.rejects(
    () => adapter._connectSocket(
      link,
      1,
      new AbortController().signal,
      second
    ),
    { code: 'official_wss_cross_session_rejected' }
  );
  assert.equal(socketCalls, 0);
});

test('new sessions reset REST heartbeat failures before applying the threshold', async () => {
  let socket;
  let disconnects = 0;
  const timers = [];
  const adapter = new OfficialBilibiliAdapter({
    config: {
      ...adapterConfig(),
      apiHeartbeatIntervalMs: 5000
    },
    apiClient: {
      async start() {
        return {
          roomId: '123456',
          gameId: 'synthetic-game-1',
          wssTrust: trust()
        };
      },
      async heartbeat() {
        throw new Error('synthetic transient heartbeat failure');
      },
      async end() {}
    },
    lookup: publicLookup,
    webSocketFactory() {
      socket = new FakeWebSocket();
      return socket;
    },
    setTimer(handler, delay) {
      const timer = { handler, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    }
  });
  adapter.onDisconnect(() => {
    disconnects += 1;
  });
  adapter.apiHeartbeatFailures = 1;
  adapter.lastApiHeartbeatSuccessAt = '2026-07-25T00:00:00.000Z';
  adapter.lastWsHeartbeatReplyAt = '2026-07-25T00:00:00.000Z';
  const connecting = adapter.connect({ roomId: '123456' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await connecting;
  assert.equal(adapter.lastApiHeartbeatSuccessAt, null);
  assert.equal(adapter.lastWsHeartbeatReplyAt, null);
  const heartbeatTimer = timers.find(
    (timer) => timer.delay === 5000 && !timer.cleared
  );
  assert.ok(heartbeatTimer);
  await heartbeatTimer.handler();
  assert.equal(adapter.apiHeartbeatFailures, 1);
  assert.equal(disconnects, 0);
  assert.equal(socket.closeCount, 0);
  await adapter.disconnect();
});

test('REST heartbeat keeps a fixed cadence after request latency', async () => {
  let now = 1000;
  const timers = [];
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {
      async heartbeat() {
        now += 3000;
      }
    },
    lookup: publicLookup,
    webSocketFactory() {
      return new FakeWebSocket({ autoOpen: false });
    },
    clock: () => now,
    setTimer(handler, delay) {
      const timer = { handler, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    }
  });
  adapter.generation = 1;
  adapter.state = 'connected';
  adapter.session = { gameId: 'synthetic-game-1' };

  adapter._scheduleApiHeartbeat(1);
  assert.equal(timers[0].delay, 20000);
  await timers[0].handler();
  assert.equal(timers[1].delay, 17000);
});

test('AUTH reply and first event in one frame are both processed', async () => {
  const events = [];
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {},
    lookup: publicLookup,
    webSocketFactory() {
      return new FakeWebSocket({ autoOpen: false });
    }
  });
  adapter.generation = 1;
  adapter.state = 'authenticating';
  adapter.session = { gameId: 'synthetic-game-1' };
  adapter.authWaiter = {
    resolve() {},
    reject() {}
  };
  adapter.onEvent((event) => events.push(event));

  await adapter._handleSocketData(Buffer.concat([
    encodePacket({
      operation: OPERATIONS.AUTH_REPLY,
      body: Buffer.from('{"code":0}')
    }),
    encodePacket({
      operation: OPERATIONS.MESSAGE,
      body: Buffer.from(JSON.stringify(danmakuCommand()))
    })
  ]), 1);

  assert.equal(adapter.state, 'authenticated');
  assert.equal(events.length, 1);
  assert.equal(events[0].provider_event_id, 'synthetic-dm-1');
});

test('missing stable message identity is rejected with an explicit safe reason', async () => {
  const records = [];
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {},
    lookup: publicLookup,
    logger: {
      write(level, code, fields) {
        records.push({ level, code, fields });
      }
    },
    webSocketFactory() {
      return new FakeWebSocket({ autoOpen: false });
    }
  });
  const message = danmakuCommand();
  delete message.data.msg_id;
  adapter.generation = 1;
  adapter.state = 'connected';
  adapter.session = { gameId: 'synthetic-game-1' };

  await adapter._handleSocketData(encodePacket({
    operation: OPERATIONS.MESSAGE,
    body: Buffer.from(JSON.stringify(message))
  }), 1);

  assert.equal(adapter.snapshot().invalid, 1);
  assert.deepEqual(records, [{
    level: 'warn',
    code: 'official_event_invalid',
    fields: {
      state: 'connected',
      room_id: '123456',
      error_code: 'unstable_provider_event_id',
      result: 'invalid'
    }
  }]);
});

test('AUTH rejection is fatal and still ends the created session once', async () => {
  let endCalls = 0;
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {
      async start() {
        return {
          roomId: '123456',
          gameId: 'synthetic-game-1',
          wssTrust: trust()
        };
      },
      async heartbeat() {},
      async end() {
        endCalls += 1;
      }
    },
    lookup: publicLookup,
    webSocketFactory() {
      return new FakeWebSocket({ authCode: 1 });
    }
  });

  await assert.rejects(
    () => adapter.connect({ roomId: '123456' }),
    (error) => {
      assert.equal(error.code, 'official_auth_rejected');
      assert.equal(error.fatal, true);
      return true;
    }
  );
  assert.equal(endCalls, 1);
});

test('authenticated socket close distinguishes normal and abnormal reasons', async (t) => {
  for (const [name, closeCode, expectedReason] of [
    ['normal', 1000, 'official_wss_closed_normal'],
    ['abnormal', 1006, 'official_wss_closed_abnormal']
  ]) {
    await t.test(name, async () => {
      let socket;
      let disconnectReason = null;
      const adapter = new OfficialBilibiliAdapter({
        config: adapterConfig(),
        apiClient: {
          async start() {
            return {
              roomId: '123456',
              gameId: `synthetic-game-${name}`,
              wssTrust: trust()
            };
          },
          async heartbeat() {},
          async end() {}
        },
        lookup: publicLookup,
        webSocketFactory() {
          socket = new FakeWebSocket();
          return socket;
        }
      });
      adapter.onDisconnect(({ code }) => {
        disconnectReason = code;
      });

      await adapter.connect({ roomId: '123456' });
      socket.remoteClose(closeCode);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(disconnectReason, expectedReason);
      await adapter.disconnect();
    });
  }
});

test('interaction end signals one classified disconnect without emitting an event', async () => {
  const events = [];
  const disconnects = [];
  const adapter = new OfficialBilibiliAdapter({
    config: adapterConfig(),
    apiClient: {},
    lookup: publicLookup,
    webSocketFactory() {
      return new FakeWebSocket({ autoOpen: false });
    }
  });
  adapter.generation = 1;
  adapter.state = 'connected';
  adapter.session = { gameId: 'synthetic-game-1' };
  adapter.onEvent((event) => events.push(event));
  adapter.onDisconnect((value) => disconnects.push(value));

  await adapter._handleSocketData(encodePacket({
    operation: OPERATIONS.MESSAGE,
    body: Buffer.from(JSON.stringify({
      cmd: 'LIVE_OPEN_PLATFORM_INTERACTION_END',
      data: { game_id: 'synthetic-game-1' }
    }))
  }), 1);

  assert.deepEqual(events, []);
  assert.deepEqual(disconnects, [{ code: 'official_interaction_end' }]);
  assert.equal(adapter.snapshot().disconnect_notifications, 1);
});
