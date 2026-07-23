const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { liveEventAdminQuerySchema } = require('../src/schemas/liveAdminSchemas');
const {
  createLiveAdminRepository,
  createLiveAdminService,
  defaultListenerStatus,
  publicEvent,
  sanitizeListenerStatus
} = require('../src/services/liveAdminService');
const { createLiveControlController } = require('../src/controllers/liveControlController');
const { createLiveControlRouter } = require('../src/routes/liveControl');

const SESSION_ID = '21bf55c8-3b83-4a88-b7f8-fb8af41b2a4d';
const EVENT_REFERENCE_SECRET = 'live-admin-synthetic-reference-secret-0001';
const FORBIDDEN_KEYS = [
  'body',
  'raw_body',
  'raw_payload',
  'headers',
  'signature',
  'authorization',
  'cookie',
  'token',
  'actor_open_id',
  'actor_union_id',
  'event_id',
  'source_message_id',
  'source_session_id',
  'normalized_payload',
  'content_hash',
  'requester_open_id',
  'requester_user_id'
];

function repository(overrides = {}) {
  return {
    async ping() {},
    async listActiveSessions() { return []; },
    async getIngestionSummary() {
      return { total_saved: 0, recent_event_count: 0, last_event_at: null };
    },
    async findSession() { return null; },
    async listSessionOptions() { return []; },
    async listEvents() { return { rows: [], total: 0 }; },
    ...overrides
  };
}

function syntheticEventRow(overrides = {}) {
  return {
    id: 12,
    content_hash: 'a'.repeat(64),
    event_id: 'synthetic:private-upstream-id',
    event_type: 'danmaku',
    site_id: 'synthetic-site',
    room_id: '99000000000000000009',
    mode: 'simulation',
    source_cmd: 'LIVE_OPEN_PLATFORM_DM',
    source_message_id: 'private-source-message',
    source_session_id: 'private-source-session',
    actor_open_id: 'private-open-id',
    actor_union_id: 'private-union-id',
    actor_display_name: 'Synthetic Viewer',
    occurred_at: '2026-07-23T01:00:00.000Z',
    received_at: '2026-07-23T01:00:01.000Z',
    normalized_payload: {
      text: '合成点歌内容',
      hidden: 'must-not-be-returned'
    },
    status: 'recorded',
    created_at: '2026-07-23T01:00:01.500Z',
    request_public_id: 'a1ea2b41-e872-4509-8816-4a8a21e67fb7',
    requested_title: '年轮',
    request_status: 'queued',
    match_method: 'exact',
    request_session_id: 8,
    session_public_id: SESSION_ID,
    session_title: 'Synthetic Session',
    song_title: '年轮',
    ...overrides
  };
}

function recursiveKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    recursiveKeys(child, output);
  }
  return output;
}

async function createHarness(t, router) {
  const app = express();
  app.use(express.json());
  app.use('/api/live-control', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${server.address().port}/api/live-control`;
}

test('live event admin query validates pagination, filters, and time range', () => {
  const valid = liveEventAdminQuerySchema.parse({
    query: '年轮',
    event_type: 'danmaku',
    status: 'recorded',
    source: 'simulation',
    session: SESSION_ID,
    start: '2026-07-23T00:00:00.000Z',
    end: '2026-07-23T02:00:00.000Z',
    page: '2',
    limit: '100'
  });
  assert.equal(valid.page, 2);
  assert.equal(valid.limit, 100);
  for (const invalid of [
    { page: '0' },
    { limit: '101' },
    { event_type: 'unknown' },
    { status: 'accepted' },
    { source: 'remote' },
    { session: 'not-a-uuid' },
    { start: 'not-a-date' },
    {
      start: '2026-07-24T00:00:00.000Z',
      end: '2026-07-23T00:00:00.000Z'
    },
    { query: 'x'.repeat(201) },
    { arbitrary: 'value' }
  ]) {
    assert.equal(liveEventAdminQuerySchema.safeParse(invalid).success, false);
  }
});

test('event DTO recursively excludes raw payload, platform identity, and upstream IDs', () => {
  const dto = publicEvent(
    syntheticEventRow(),
    null,
    { eventReferenceSecret: EVENT_REFERENCE_SECRET }
  );
  const keys = recursiveKeys(dto);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  const serialized = JSON.stringify(dto);
  assert.doesNotMatch(
    serialized,
    /private-open-id|private-union-id|private-source-message|private-upstream-id|must-not-be-returned/
  );
  assert.equal(dto.content.text, null);
  assert.equal(dto.song_request.requested_title, '年轮');
  assert.equal(dto.song_request.queue_assigned, true);
});

test('gift DTO uses a fixed safe summary and has no point-side-effect fields', () => {
  const dto = publicEvent(syntheticEventRow({
    event_type: 'gift',
    normalized_payload: {
      gift_name: 'Synthetic Gift',
      gift_num: 2,
      price: '1000',
      private_note: 'must-not-leak'
    },
    request_public_id: null,
    request_session_id: null
  }), null, { eventReferenceSecret: EVENT_REFERENCE_SECRET });
  assert.equal(dto.content.summary, '礼物事件');
  assert.equal(dto.content.text, null);
  assert.equal(dto.song_request, null);
  assert.doesNotMatch(JSON.stringify(dto), /price|private_note|points|wallet/);
});

test('listener status is strictly allowlisted and cannot carry secrets or URLs', () => {
  const status = sanitizeListenerStatus({
    availability: 'blocked',
    enabled: true,
    configured: true,
    blocked: true,
    adapter_state: 'fatal',
    reason_code: 'official_wss_allowlist_unverified',
    bilibili_api_state: 'disconnected',
    bilibili_wss_state: 'blocked',
    secret: 'must-not-leak',
    url: 'wss://must-not-leak.example'
  });
  assert.deepEqual(Object.keys(status).sort(), Object.keys(defaultListenerStatus()).sort());
  assert.equal(status.availability, 'blocked');
  assert.equal(status.bilibili_wss_state, 'blocked');
  assert.doesNotMatch(JSON.stringify(status), /must-not-leak|wss:/);
});

test('listener disabled, not configured, blocked, and unavailable remain distinct', () => {
  for (const availability of [
    'disabled',
    'not_configured',
    'blocked',
    'unavailable'
  ]) {
    const status = sanitizeListenerStatus({
      availability,
      enabled: availability !== 'disabled',
      configured: !['disabled', 'not_configured'].includes(availability),
      blocked: availability === 'blocked',
      adapter_state: availability === 'blocked' ? 'fatal' : 'stopped',
      reason_code: `listener_${availability}`,
      bilibili_api_state: availability === 'blocked' ? 'blocked' : 'unknown',
      bilibili_wss_state: availability === 'blocked' ? 'blocked' : 'unknown'
    });
    assert.equal(status.availability, availability);
    assert.equal(status.reason_code, `listener_${availability}`);
  }
});

test('status keeps Backend, database, session, listener, and WSS states separate', async () => {
  const service = createLiveAdminService({
    repository: repository({
      async listActiveSessions() {
        return [{
          public_id: SESSION_ID,
          site_id: 'synthetic-site',
          room_id: '99000000000000000009',
          title: 'Synthetic Session',
          status: 'open',
          started_at: '2026-07-23T00:00:00.000Z',
          ended_at: null,
          last_event_at: '2026-07-23T01:00:00.000Z',
          saved_event_count: 3,
          needs_match_count: 1,
          queued_count: 2,
          active_count: 1
        }];
      },
      async getIngestionSummary() {
        return {
          total_saved: 3,
          recent_event_count: 1,
          last_event_at: '2026-07-23T01:00:00.000Z'
        };
      }
    }),
    listenerStatusProvider: async () => ({
      availability: 'blocked',
      enabled: true,
      configured: true,
      blocked: true,
      adapter_state: 'fatal',
      reason_code: 'official_wss_allowlist_unverified',
      bilibili_api_state: 'disconnected',
      bilibili_wss_state: 'blocked'
    }),
    clock: () => new Date('2026-07-23T02:00:00.000Z')
  });
  const result = await service.getStatus();
  assert.equal(result.backend.status, 'available');
  assert.equal(result.database.status, 'available');
  assert.equal(result.sessions.state, 'active');
  assert.equal(result.sessions.items[0].status, 'open');
  assert.equal(result.listener.availability, 'blocked');
  assert.equal(result.bilibili_connection.wss_state, 'blocked');
  assert.equal(result.bilibili_connection.authoritative, false);
  assert.equal(result.ingestion.recent_event_count, 1);
  assert.equal(result.completeness, 'complete');
});

test('zero, one, and multiple active sessions have explicit states', async () => {
  for (const [count, expected] of [[0, 'none'], [1, 'active'], [2, 'conflict']]) {
    const rows = Array.from({ length: count }, (_, index) => ({
      public_id: `${index + 1}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
      site_id: `synthetic-${index}`,
      room_id: String(10000 + index),
      title: `Session ${index}`,
      status: 'open'
    }));
    const result = await createLiveAdminService({
      repository: repository({ async listActiveSessions() { return rows; } }),
      listenerStatusProvider: async () => ({
        availability: 'disabled',
        enabled: false,
        configured: false,
        blocked: false,
        adapter_state: 'stopped',
        bilibili_api_state: 'disconnected',
        bilibili_wss_state: 'disconnected'
      })
    }).getStatus();
    assert.equal(result.sessions.state, expected);
    assert.equal(result.sessions.active_count, count);
  }
});

test('database and ingestion failures return partial status without a stack trace', async () => {
  const result = await createLiveAdminService({
    repository: repository({
      async ping() { throw new Error('private database detail'); },
      async listActiveSessions() { throw new Error('private session detail'); },
      async getIngestionSummary() { throw new Error('private event detail'); }
    })
  }).getStatus();
  assert.equal(result.completeness, 'partial');
  assert.equal(result.backend.status, 'available');
  assert.equal(result.database.status, 'unavailable');
  assert.equal(result.sessions.state, 'none');
  assert.equal(result.ingestion.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private .* detail|stack/i);
});

test('listener timeout becomes unavailable and never fails the whole status page', async () => {
  const result = await createLiveAdminService({
    repository: repository(),
    listenerStatusProvider: () => new Promise(() => {}),
    listenerStatusTimeoutMs: 5
  }).getStatus();
  assert.equal(result.completeness, 'partial');
  assert.equal(result.listener.availability, 'unavailable');
  assert.equal(result.listener.reason_code, 'listener_status_timeout');
  assert.equal(result.bilibili_connection.wss_state, 'unknown');
});

test('event query is parameterized, paginated, and uses stable fixed sorting', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(DISTINCT')) return [[{ count: 1 }]];
      return [[syntheticEventRow()]];
    }
  };
  const repositoryInstance = createLiveAdminRepository({ pool });
  const input = {
    query: "%' OR 1=1 --",
    event_type: 'danmaku',
    status: 'recorded',
    source: 'simulation',
    start: '2026-07-23T00:00:00.000Z',
    end: '2026-07-24T00:00:00.000Z',
    page: 2,
    limit: 20
  };
  const result = await repositoryInstance.listEvents(input);
  assert.equal(result.total, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(({ sql }) => sql.includes("OR 1=1")), false);
  assert.ok(calls.every(({ params }) => params.includes("%\\%' OR 1=1 --%")));
  assert.match(calls[1].sql, /ORDER BY le\.received_at DESC, le\.id DESC/);
  assert.deepEqual(calls[1].params.slice(-2), [20, 20]);
});

test('session event filter uses a parameterized target and bounded time window', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(DISTINCT')) return [[{ count: 0 }]];
      return [[]];
    }
  };
  const session = {
    public_id: SESSION_ID,
    site_id: 'synthetic-site',
    room_id: '99000000000000000009',
    title: 'Synthetic Session',
    started_at: '2026-07-23 00:00:00.000',
    ended_at: '2026-07-23 02:00:00.000',
    created_at: '2026-07-22 23:59:00.000'
  };
  await createLiveAdminRepository({ pool }).listEvents({
    page: 1,
    limit: 20
  }, session);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /le\.site_id = \? AND le\.room_id = \?/);
  assert.ok(calls[0].params.includes(session.site_id));
  assert.ok(calls[0].params.includes(session.ended_at));
  assert.doesNotMatch(calls[0].sql, /synthetic-site|99000000000000000009/);
});

test('event service returns empty pagination and safe session options', async () => {
  const service = createLiveAdminService({
    repository: repository({
      async listSessionOptions() {
        return [{
          public_id: SESSION_ID,
          site_id: 'synthetic-site',
          room_id: '99000000000000000009',
          title: 'Synthetic Session',
          status: 'closed',
          started_at: '2026-07-23T00:00:00.000Z',
          ended_at: '2026-07-23T02:00:00.000Z'
        }];
      }
    })
  });
  const result = await service.listEvents({ page: 1, limit: 20 });
  assert.deepEqual(result.events, []);
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.totalPages, 1);
  assert.equal(result.filters.session_options[0].public_id, SESSION_ID);
  assert.doesNotMatch(JSON.stringify(result), /user_id|open_id|event_id|normalized_payload/);
});

test('unknown session filter returns stable 404', async () => {
  const service = createLiveAdminService({ repository: repository() });
  await assert.rejects(
    service.listEvents({ session: SESSION_ID, page: 1, limit: 20 }),
    (error) => error.status === 404 && error.code === 'session_not_found'
  );
});

test('live admin routes require authentication and authorization', async (t) => {
  const controller = new Proxy({}, {
    get() {
      return async (req, res) => res.json({ should_not_run: true });
    }
  });
  const unauthenticated = await createHarness(t, createLiveControlRouter({
    controller,
    authenticate: (req, res) => res.status(401).json({ message: 'Authentication required' }),
    authorize: (req, res, next) => next()
  }));
  assert.equal((await fetch(`${unauthenticated}/status`)).status, 401);

  const unauthorized = await createHarness(t, createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res) => res.status(403).json({ message: 'Permission denied' })
  }));
  assert.equal((await fetch(`${unauthorized}/events`)).status, 403);
});

test('admin status and event routes use the read-only service and reject invalid query', async (t) => {
  const calls = [];
  const controller = createLiveControlController({
    liveAdminService: {
      async getStatus() {
        calls.push('status');
        return { completeness: 'partial' };
      },
      async listEvents(input) {
        calls.push(input);
        return { events: [], pagination: { page: input.page, limit: input.limit, total: 0 } };
      }
    }
  });
  const baseUrl = await createHarness(t, createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));
  let response = await fetch(`${baseUrl}/status`);
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/events?page=2&limit=50&event_type=gift`);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[1], {
    event_type: 'gift',
    page: 2,
    limit: 50
  });
  response = await fetch(`${baseUrl}/events?limit=101`);
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.code, 'invalid_live_event_query');
  assert.doesNotMatch(JSON.stringify(error), /stack|Zod|exception/i);
});

test('admin event HTTP response and failures never expose payload sentinels', async (t) => {
  const sentinel = 'synthetic-r4-http-secret-sentinel';
  const service = createLiveAdminService({
    repository: repository({
      async listEvents() {
        return {
          rows: [syntheticEventRow({
            normalized_payload: {
              text: sentinel,
              nested: { raw_body: sentinel }
            },
            raw_body: sentinel,
            headers: { authorization: sentinel }
          })],
          total: 1
        };
      }
    }),
    eventReferenceSecret: EVENT_REFERENCE_SECRET
  });
  const baseUrl = await createHarness(t, createLiveControlRouter({
    controller: createLiveControlController({ liveAdminService: service }),
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));
  const response = await fetch(`${baseUrl}/events`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel));
  assert.match(body.events[0].event_ref, /^ler:v1:[a-f0-9]{64}$/);
  assert.equal(body.events[0].content.text, null);

  const failingBaseUrl = await createHarness(t, createLiveControlRouter({
    controller: createLiveControlController({
      liveAdminService: createLiveAdminService({
        repository: repository({
          async listEvents() {
            throw new Error(sentinel);
          }
        }),
        eventReferenceSecret: EVENT_REFERENCE_SECRET
      })
    }),
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));
  const failure = await fetch(`${failingBaseUrl}/events`);
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), new RegExp(sentinel));
});

test('live status and events expose GET-only read paths', async (t) => {
  const controller = new Proxy({}, {
    get() {
      return async (req, res) => res.json({ ok: true });
    }
  });
  const baseUrl = await createHarness(t, createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));
  assert.equal((await fetch(`${baseUrl}/status`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${baseUrl}/events`, { method: 'DELETE' })).status, 404);
});
