const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createLiveAdminRepository,
  createLiveAdminService,
  publicEvent
} = require('../src/services/liveAdminService');
const {
  createLiveEventService
} = require('../src/services/liveEventService');
const {
  createLiveEventReference
} = require('../src/utils/liveEventReference');

const SYNTHETIC_EVENT_REF_SECRET = 'r4-synthetic-event-reference-secret-0001';
const SECRET_SENTINEL = 'r4-secret-sentinel-must-not-cross-admin-dto';

function syntheticEventRow(overrides = {}) {
  return {
    id: 41,
    content_hash: 'b'.repeat(64),
    event_id: 'synthetic:r4:private-event-id',
    event_type: 'danmaku',
    site_id: 'synthetic-r4-site',
    room_id: '99000000000000000404',
    mode: 'simulation',
    source_cmd: 'SYNTHETIC_R4_DANMAKU',
    actor_display_name: 'Synthetic R4 Viewer',
    occurred_at: '2026-07-24T01:00:00.000Z',
    received_at: '2026-07-24T01:00:01.000Z',
    normalized_payload: {
      text: SECRET_SENTINEL,
      nested: {
        body: SECRET_SENTINEL,
        raw_payload: {
          authorization: SECRET_SENTINEL
        }
      }
    },
    body: { secret: SECRET_SENTINEL },
    raw_body: SECRET_SENTINEL,
    headers: { cookie: SECRET_SENTINEL },
    signature: SECRET_SENTINEL,
    token: SECRET_SENTINEL,
    status: 'recorded',
    created_at: '2026-07-24T01:00:01.500Z',
    request_public_id: null,
    requested_title: null,
    request_status: null,
    match_method: null,
    request_session_id: null,
    session_public_id: null,
    session_title: null,
    song_title: null,
    ...overrides
  };
}

test('admin event DTO excludes nested event body and unknown-row sentinels', () => {
  const dto = publicEvent(
    syntheticEventRow(),
    null,
    { eventReferenceSecret: SYNTHETIC_EVENT_REF_SECRET }
  );
  const serialized = JSON.stringify(dto);
  assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL));
  assert.equal(dto.content.text, null);
});

test('event_ref cannot be recomputed with the legacy unkeyed public algorithm', () => {
  const row = syntheticEventRow();
  const legacyReference = crypto
    .createHash('sha256')
    .update(`phase4g-b:${row.id}:${row.content_hash}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  const dto = publicEvent(
    row,
    null,
    { eventReferenceSecret: SYNTHETIC_EVENT_REF_SECRET }
  );
  assert.notEqual(dto.event_ref, legacyReference);
  assert.match(dto.event_ref, /^ler:v1:[a-f0-9]{64}$/);
});

test('event_ref is stable per identity, keyed, versioned, and fails closed without a valid key', () => {
  const row = syntheticEventRow();
  const first = createLiveEventReference(row, SYNTHETIC_EVENT_REF_SECRET);
  const repeated = createLiveEventReference(
    { ...row },
    SYNTHETIC_EVENT_REF_SECRET
  );
  const differentIdentity = createLiveEventReference(
    { ...row, id: 42 },
    SYNTHETIC_EVENT_REF_SECRET
  );
  const differentSecret = createLiveEventReference(
    row,
    'r4-second-synthetic-event-reference-secret'
  );

  assert.equal(first, repeated);
  assert.notEqual(first, differentIdentity);
  assert.notEqual(first, differentSecret);
  assert.match(first, /^ler:v1:[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /synthetic|41|bbbbbbbb/);
  assert.throws(
    () => createLiveEventReference(row, ''),
    (error) => error.code === 'event_ref_secret_missing' && error.status === 503
  );
  assert.throws(
    () => createLiveEventReference(row, 'too-short'),
    (error) => error.code === 'event_ref_secret_invalid' && error.status === 503
  );
});

test('event list fails closed at the serializer boundary when the ref key is absent', async () => {
  const service = createLiveAdminService({
    repository: {
      async findSession() { return null; },
      async listEvents() {
        return { rows: [syntheticEventRow()], total: 1 };
      },
      async listSessionOptions() { return []; }
    },
    eventReferenceSecret: ''
  });
  await assert.rejects(
    service.listEvents({ page: 1, limit: 20 }),
    (error) => error.code === 'event_ref_secret_missing' && error.status === 503
  );
});

test('legacy and current event replay still use event_id idempotency and conflict semantics', async () => {
  let stored = null;
  let insertCount = 0;
  const repository = {
    async insert(record) {
      if (stored) {
        const error = new Error('synthetic duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      insertCount += 1;
      stored = { event_id: record.eventId, content_hash: record.contentHash };
      return 1;
    },
    async findByEventId(eventId) {
      return stored?.event_id === eventId ? stored : null;
    }
  };
  const service = createLiveEventService({ repository });
  const event = {
    schema_version: '1.0',
    event_id: 'synthetic:r4:legacy-replay',
    event_type: 'danmaku',
    site_id: 'synthetic-r4-site',
    room_id: '99000000000000000404',
    mode: 'replay',
    source: {
      provider: 'synthetic',
      cmd: 'SYNTHETIC_R4_DANMAKU',
      message_id: 'synthetic-message',
      session_id: 'synthetic-session'
    },
    actor: {
      open_id: 'synthetic-r4-open-id',
      union_id: null,
      display_name: 'Synthetic R4 Viewer'
    },
    occurred_at: '2026-07-24T01:00:00.000Z',
    received_at: '2026-07-24T01:00:01.000Z',
    payload: { text: 'synthetic replay message' },
    delivery: { attempt: 1, replay: true, trace_id: 'synthetic-r4-trace' }
  };

  assert.equal((await service.record(event)).status, 'accepted');
  assert.equal((await service.record(structuredClone(event))).status, 'duplicate');
  const conflict = structuredClone(event);
  conflict.payload.text = 'synthetic changed message';
  const conflictResult = await service.record(conflict);
  assert.equal(conflictResult.status, 'rejected');
  assert.equal(conflictResult.reason, 'event_id_conflict');
  assert.equal(insertCount, 1);
});

test('live status repository uses fixed grouped aggregation and stable bounded recency lookup', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('active_sessions')) return [[]];
      return [[{
        total_saved: 0,
        recent_event_count: 0,
        last_event_at: null
      }]];
    }
  };
  const repository = createLiveAdminRepository({ pool });
  await repository.listActiveSessions();
  await repository.getIngestionSummary();

  assert.equal(calls.length, 2);
  assert.match(calls[0], /WITH\s+active_sessions/i);
  assert.doesNotMatch(calls[0], /\(\s*SELECT\s+(?:MAX|COUNT)\(/i);
  assert.match(
    calls[1],
    /ORDER BY\s+received_at\s+DESC\s*,\s*id\s+DESC\s+LIMIT\s+1/i
  );
  assert.match(
    calls[1],
    /WHERE\s+received_at\s+>=\s+UTC_TIMESTAMP\(3\)\s*-\s*INTERVAL\s+5\s+MINUTE/i
  );
});

test('event repository never selects normalized payload into the DTO row projection', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('COUNT(DISTINCT')) return [[{ count: 0 }]];
      return [[]];
    }
  };
  await createLiveAdminRepository({ pool }).listEvents({
    page: 1,
    limit: 20
  });
  assert.equal(calls.length, 2);
  const projection = calls[1].slice(0, calls[1].indexOf('FROM live_events'));
  assert.doesNotMatch(projection, /normalized_payload|raw_body|headers|signature/i);
});

test('default listener status path performs zero network calls and accepts no URL input', async (t) => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must remain unreachable');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const repository = {
    async ping() {},
    async listActiveSessions() { return []; },
    async getIngestionSummary() {
      return { total_saved: 0, recent_event_count: 0, last_event_at: null };
    }
  };
  const result = await createLiveAdminService({ repository }).getStatus({
    provider_url: 'http://169.254.169.254/latest/meta-data'
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.listener.availability, 'unavailable');
  assert.equal(result.listener.reason_code, 'listener_status_not_reported');
});
