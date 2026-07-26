const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { once } = require('node:events');
const {
  LIVE_FRESH_MS,
  LIVE_GRACE_MS,
  SETTING_KEYS,
  createLiveHomeRepository,
  createLiveHomeService,
  currentActivity,
  publicSupport,
  resolveLiveMode,
  safeRoomUrl
} = require('../src/services/liveHomeService');
const {
  areSongRequestsOpen,
  ensureSongRequestsOpenSetting
} = require('../src/services/songRequestService');
const {
  createLiveEventService
} = require('../src/services/liveEventService');
const { createLiveEventRouter } = require('../src/routes/liveEvents');

const NOW = Date.parse('2026-07-26T04:00:00.000Z');
const SECRET = 'phase4h-test-only-secret-2ab2699077cf740e1cd8';
const SITE_ID = 'synthetic-site';
const ROOM_ID = '123456789';
const ENV = Object.freeze({
  LIVE_EVENT_INGEST_ENABLED: 'true',
  LIVE_EVENT_INGEST_SECRET: SECRET,
  LIVE_EVENT_MAX_SKEW_SECONDS: '300',
  LIVE_EVENT_ALLOWED_TARGETS: `${SITE_ID}:${ROOM_ID}`
});

function settings(values = {}) {
  return new Map(Object.entries(values));
}

function stateSettings({
  official = 'live',
  transport = 'connected',
  authenticated = 'true',
  reportedAt = new Date(NOW).toISOString(),
  override = 'auto',
  expiresAt = ''
} = {}) {
  return settings({
    [SETTING_KEYS.officialState]: official,
    [SETTING_KEYS.transportState]: transport,
    [SETTING_KEYS.transportAuthenticated]: authenticated,
    [SETTING_KEYS.transportReportedAt]: reportedAt,
    [SETTING_KEYS.overrideMode]: override,
    [SETTING_KEYS.overrideExpiresAt]: expiresAt
  });
}

test('live state honors override, official end, freshness, grace, and expiry boundaries', () => {
  assert.equal(resolveLiveMode(stateSettings(), NOW).mode, 'live');
  assert.equal(resolveLiveMode(stateSettings({
    reportedAt: new Date(NOW - LIVE_FRESH_MS).toISOString()
  }), NOW).mode, 'live');
  assert.equal(resolveLiveMode(stateSettings({
    transport: 'disconnected',
    authenticated: 'false',
    reportedAt: new Date(NOW - LIVE_FRESH_MS - 1).toISOString()
  }), NOW).mode, 'syncing');
  assert.equal(resolveLiveMode(stateSettings({
    transport: 'disconnected',
    authenticated: 'false',
    reportedAt: new Date(NOW - LIVE_GRACE_MS - 1).toISOString()
  }), NOW).mode, 'offline');
  assert.equal(resolveLiveMode(stateSettings({ official: 'offline' }), NOW).mode, 'offline');
  assert.equal(resolveLiveMode(stateSettings({
    override: 'force_live',
    expiresAt: new Date(NOW + 1000).toISOString(),
    official: 'offline'
  }), NOW).mode, 'live');
  assert.equal(resolveLiveMode(stateSettings({
    override: 'force_live',
    expiresAt: new Date(NOW).toISOString(),
    official: 'offline'
  }), NOW).mode, 'offline');
});

test('activity is evaluated at read time and remains safe across UTC boundaries', () => {
  const value = settings({
    [SETTING_KEYS.activityEnabled]: 'true',
    [SETTING_KEYS.activityTitle]: '今晚歌回',
    [SETTING_KEYS.activityContent]: '一起听歌',
    [SETTING_KEYS.activityStartsAt]: '2026-07-26T03:59:59.000Z',
    [SETTING_KEYS.activityEndsAt]: '2026-07-26T04:00:01.000Z'
  });
  assert.equal(currentActivity(value, NOW).title, '今晚歌回');
  assert.equal(currentActivity(value, NOW + 1000), null);
  assert.equal(currentActivity(value, NOW - 2000), null);
});

test('room link only uses one validated numeric room id', () => {
  assert.equal(safeRoomUrl('123456'), 'https://live.bilibili.com/123456');
  assert.equal(safeRoomUrl(''), null);
  assert.equal(safeRoomUrl('123/path'), null);
});

test('gift and guard public DTOs expose only bounded display fields', () => {
  const gift = publicSupport({
    event_type: 'gift',
    actor_display_name: `Viewer\u0000${'x'.repeat(150)}`,
    occurred_at: '2026-07-26T04:00:00.000Z',
    normalized_payload: JSON.stringify({
      gift_name: '辣条',
      gift_num: 2,
      open_id: 'must-not-leak',
      raw_payload: 'must-not-leak'
    })
  });
  const guard = publicSupport({
    event_type: 'guard_buy',
    actor_display_name: 'Captain',
    occurred_at: '2026-07-26T04:00:00.000Z',
    normalized_payload: JSON.stringify({
      guard_level: '3',
      guard_num: 1,
      guard_unit: '月',
      union_id: 'must-not-leak'
    })
  });
  assert.deepEqual(Object.keys(gift), [
    'type', 'display_name', 'item_name', 'count', 'occurred_at'
  ]);
  assert.equal(gift.display_name.length, 100);
  assert.equal(JSON.stringify([gift, guard]).includes('must-not-leak'), false);
  assert.equal(guard.item_name, '舰长');
});

function memoryRepository(initial = {}) {
  const stored = settings(initial);
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {}
  };
  return {
    stored,
    pool: {
      async getConnection() {
        return connection;
      }
    },
    async loadSettings() {
      return new Map(stored);
    },
    async putSettings(queryable, entries) {
      void queryable;
      for (const [key, value] of entries) stored.set(key, value);
    },
    async getQueue() {
      const next = {
        public_id: 'request-next',
        requested_title: '下一首',
        song_title: null,
        song_artist: null,
        status: 'queued',
        version: 2
      };
      return {
        current: {
          public_id: 'request-current',
          requested_title: '当前歌曲',
          song_title: null,
          song_artist: null,
          status: 'active',
          version: 3
        },
        next,
        waiting: [next],
        waitingCount: 1
      };
    },
    async getRecentSupport() {
      return [];
    }
  };
}

test('aggregate uses one queue projection and hides manual override details publicly', async () => {
  const repository = memoryRepository({
    [SETTING_KEYS.officialState]: 'live',
    [SETTING_KEYS.transportState]: 'connected',
    [SETTING_KEYS.transportAuthenticated]: 'true',
    [SETTING_KEYS.transportReportedAt]: new Date(NOW).toISOString(),
    [SETTING_KEYS.songRequestsOpen]: 'false'
  });
  const service = createLiveHomeService({
    repository,
    clock: () => NOW,
    roomId: ''
  });
  const result = await service.getPublicHome();
  assert.equal(result.mode, 'live');
  assert.equal(result.room_url, null);
  assert.equal(result.song_requests.open, false);
  assert.equal(result.song_requests.queue_count, 1);
  assert.equal(result.song_requests.current.title, '当前歌曲');
  assert.equal(Object.hasOwn(result, 'control'), false);
  assert.equal(JSON.stringify(result).includes('open_id'), false);
});

test('admin aggregate exposes one bounded safe queue projection', async () => {
  const repository = memoryRepository();
  const service = createLiveHomeService({
    repository,
    clock: () => NOW,
    roomId: ROOM_ID
  });
  const result = await service.getAdminHome();
  assert.deepEqual(result.control.queue, {
    current: {
      public_id: 'request-current',
      version: 3,
      status: 'active',
      title: '当前歌曲',
      artist: null
    },
    waiting: [{
      public_id: 'request-next',
      version: 2,
      status: 'queued',
      title: '下一首',
      artist: null
    }],
    waiting_count: 1
  });
  assert.equal(JSON.stringify(result.control.queue).includes('requester'), false);
});

test('recent support is scoped to the configured site and room', async () => {
  const calls = [];
  const repository = createLiveHomeRepository({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return [[]];
      }
    },
    siteId: SITE_ID,
    roomId: ROOM_ID
  });
  await repository.getRecentSupport();
  assert.match(calls[0].sql, /AND site_id = \? AND room_id = \?/);
  assert.deepEqual(calls[0].params, [SITE_ID, ROOM_ID]);
});

test('older live state events cannot replace the latest official state', async () => {
  const repository = memoryRepository({
    [SETTING_KEYS.officialState]: 'offline',
    [SETTING_KEYS.officialEventAt]: new Date(NOW).toISOString()
  });
  const service = createLiveHomeService({ repository, clock: () => NOW });
  const result = await service.observeAcceptedEvent({
    event_type: 'live_start',
    occurred_at: new Date(NOW - 1).toISOString(),
    received_at: new Date(NOW).toISOString()
  }, { connection: {} });
  assert.deepEqual(result, {
    status: 'ignored',
    reason: 'stale_live_state_event'
  });
  assert.equal(repository.stored.get(SETTING_KEYS.officialState), 'offline');
});

test('listener status rejects replayed and stale reports transactionally', async () => {
  const repository = memoryRepository();
  const service = createLiveHomeService({ repository, clock: () => NOW });
  const first = {
    report_id: '11111111-1111-4111-8111-111111111111',
    site_id: SITE_ID,
    room_id: ROOM_ID,
    transport_state: 'connected',
    authenticated: true,
    reported_at: new Date(NOW).toISOString()
  };
  assert.equal((await service.recordTransportStatus(first)).status, 'accepted');
  await assert.rejects(
    service.recordTransportStatus(first),
    (error) => error.code === 'listener_status_replay'
  );
  await assert.rejects(
    service.recordTransportStatus({
      ...first,
      report_id: '22222222-2222-4222-8222-222222222222',
      reported_at: new Date(NOW - 1).toISOString()
    }),
    (error) => error.code === 'listener_status_stale'
  );
});

test('song request gate creates a lockable default row and preserves a closed value', async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT setting_value')) {
        return [[{ setting_value: 'false' }]];
      }
      return [{ affectedRows: 0 }];
    }
  };
  await ensureSongRequestsOpenSetting(connection);
  assert.equal(await areSongRequestsOpen(connection, { forUpdate: true }), false);
  assert.match(calls[0], /INSERT IGNORE INTO settings/);
  assert.match(calls[1], /FOR UPDATE/);
});

test('observer duplicate errors are not mis-acknowledged as duplicate events', async () => {
  const repository = {
    queryable: {},
    async insert() {
      return 1;
    },
    async findByEventId() {
      throw new Error('duplicate lookup must not run');
    }
  };
  const duplicate = new Error('observer constraint');
  duplicate.code = 'ER_DUP_ENTRY';
  const service = createLiveEventService({
    repository,
    acceptedEventObserver: async () => {
      throw duplicate;
    }
  });
  await assert.rejects(
    service.record({
      schema_version: '1.0',
      event_id: 'synthetic:observer:1',
      event_type: 'gift',
      site_id: SITE_ID,
      room_id: ROOM_ID,
      mode: 'simulation',
      source: {
        cmd: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
        message_id: 'message-1'
      },
      actor: { open_id: 'private' },
      occurred_at: new Date(NOW).toISOString(),
      received_at: new Date(NOW).toISOString(),
      payload: {},
      delivery: { attempt: 1, replay: false }
    }),
    (error) => error === duplicate
  );
});

function sign(rawBody, timestamp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

test('internal listener status reuses HMAC auth and rejects replay safely', async (t) => {
  const accepted = new Set();
  const statusService = {
    async recordTransportStatus(report) {
      if (accepted.has(report.report_id)) {
        const error = new Error('replay');
        error.status = 409;
        error.code = 'listener_status_replay';
        throw error;
      }
      accepted.add(report.report_id);
      return { status: 'accepted', report_id: report.report_id };
    }
  };
  const app = express();
  app.use('/api/internal/live-events/v1', createLiveEventRouter({
    env: ENV,
    service: { async record() { throw new Error('not used'); } },
    now: () => NOW,
    logger: { info() {}, error() {} },
    statusService
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const rawBody = Buffer.from(JSON.stringify({
    report_id: '33333333-3333-4333-8333-333333333333',
    site_id: SITE_ID,
    room_id: ROOM_ID,
    transport_state: 'connected',
    authenticated: true,
    reported_at: new Date(NOW).toISOString()
  }));
  const timestamp = String(Math.floor(NOW / 1000));
  const url = `http://127.0.0.1:${server.address().port}/api/internal/live-events/v1/status`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Live-Timestamp': timestamp,
    'X-Live-Signature': sign(rawBody, timestamp)
  };
  const acceptedResponse = await fetch(url, { method: 'POST', headers, body: rawBody });
  assert.equal(acceptedResponse.status, 201);
  const replayResponse = await fetch(url, { method: 'POST', headers, body: rawBody });
  assert.equal(replayResponse.status, 409);
  assert.deepEqual(await replayResponse.json(), {
    status: 'rejected',
    reason: 'listener_status_replay'
  });
});
