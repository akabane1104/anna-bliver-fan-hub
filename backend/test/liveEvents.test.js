const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { createLiveEventRouter, MAX_LIVE_EVENT_BODY_BYTES } = require('../src/routes/liveEvents');
const { createLiveEventService } = require('../src/services/liveEventService');

const FIXED_NOW = Date.parse('2026-07-23T00:00:10.000Z');
const FIXED_TIMESTAMP = String(Math.floor(FIXED_NOW / 1000));
const SECRET = 'phase4b-test-only-key-7d0d17013c797bb3c71c';
const SITE_ID = 'synthetic-site';
const ROOM_ID = '900719925474099312345';
const ENDPOINT = '/api/internal/live-events/v1/ingest';

const ENABLED_ENV = Object.freeze({
  LIVE_EVENT_INGEST_ENABLED: 'true',
  LIVE_EVENT_INGEST_SECRET: SECRET,
  LIVE_EVENT_MAX_SKEW_SECONDS: '300',
  LIVE_EVENT_ALLOWED_TARGETS: `${SITE_ID}:${ROOM_ID}`
});

const COMMANDS = Object.freeze({
  danmaku: 'LIVE_OPEN_PLATFORM_DM',
  gift: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
  super_chat: 'LIVE_OPEN_PLATFORM_SUPER_CHAT',
  guard_buy: 'LIVE_OPEN_PLATFORM_GUARD',
  like: 'LIVE_OPEN_PLATFORM_LIKE',
  room_enter: 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER',
  live_start: 'LIVE_OPEN_PLATFORM_LIVE_START',
  live_end: 'LIVE_OPEN_PLATFORM_LIVE_END'
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function actor() {
  return {
    open_id: 'open_synthetic_actor_001_private',
    union_id: 'union_synthetic_actor_001_private',
    display_name: 'Synthetic Viewer',
    avatar_url: 'https://example.com/avatar.png'
  };
}

function baseEvent(eventType, sequence = 1) {
  const source = {
    platform: 'bilibili_live_open',
    cmd: COMMANDS[eventType],
    message_id: `synthetic-message-${eventType}-${sequence}`,
    session_id: 'synthetic-session-20260723'
  };
  const common = {
    schema_version: '1.0',
    event_id: `synthetic:${eventType}:${sequence}`,
    event_type: eventType,
    site_id: SITE_ID,
    room_id: ROOM_ID,
    mode: 'simulation',
    source,
    actor: actor(),
    occurred_at: '2026-07-23T00:00:00.000Z',
    received_at: '2026-07-23T00:00:01.000Z',
    payload: {},
    delivery: {
      attempt: 1,
      replay: false,
      trace_id: `synthetic-trace-${sequence}`
    }
  };

  switch (eventType) {
    case 'danmaku':
      common.payload = { text: 'Synthetic danmaku content', dm_type: 'text' };
      break;
    case 'gift':
      common.payload = {
        gift_id: 'synthetic-gift-1',
        gift_name: 'Synthetic Gift',
        gift_num: 2,
        paid: true,
        price: '1000',
        r_price: '2000',
        price_unit: 'bilibili_price'
      };
      break;
    case 'super_chat':
      common.payload = {
        message_id: `synthetic-sc-${sequence}`,
        message: 'Synthetic super chat content',
        rmb: '30',
        currency_unit: 'CNY'
      };
      break;
    case 'guard_buy':
      common.payload = {
        guard_level: '3',
        guard_num: 1,
        guard_unit: 'month',
        price: '198000',
        price_unit: 'bilibili_guard_price'
      };
      break;
    case 'like':
      common.payload = { like_count: 1 };
      break;
    case 'room_enter':
      common.payload = {};
      break;
    case 'live_start':
      common.actor = null;
      common.payload = { title: 'Synthetic live', area_name: 'Virtual' };
      break;
    case 'live_end':
      common.actor = null;
      common.payload = { title: 'Synthetic live', area_name: 'Virtual' };
      break;
    default:
      throw new Error(`Unsupported fixture type: ${eventType}`);
  }

  return common;
}

function createMemoryRepository() {
  const records = new Map();
  const writes = [];
  return {
    records,
    writes,
    async insert(record) {
      writes.push({ table: 'live_events', eventId: record.eventId });
      if (records.has(record.eventId)) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      records.set(record.eventId, {
        ...record,
        event_id: record.eventId,
        content_hash: record.contentHash
      });
      return records.size;
    },
    async findByEventId(eventId) {
      return records.get(eventId) || null;
    }
  };
}

function sign(body, timestamp = FIXED_TIMESTAMP, secret = SECRET) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(body)
    .digest('hex');
}

async function createHarness(t, options = {}) {
  const repository = options.repository || createMemoryRepository();
  const service = options.service || createLiveEventService({ repository });
  const logs = [];
  const logger = options.logger || {
    info: (...args) => logs.push(args),
    error: (...args) => logs.push(args)
  };
  const app = express();
  app.use('/api/internal/live-events/v1', createLiveEventRouter({
    env: options.env || ENABLED_ENV,
    service,
    logger,
    now: options.now || (() => FIXED_NOW)
  }));
  app.use((error, req, res, next) => {
    void next;
    res.status(500).json({ status: 'rejected', reason: 'unexpected_test_error' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    logs,
    repository
  };
}

async function sendEvent(harness, event, options = {}) {
  const body = options.body ?? JSON.stringify(event);
  const timestamp = options.timestamp || FIXED_TIMESTAMP;
  const headers = {
    'Content-Type': options.contentType || 'application/json',
    'X-Live-Timestamp': timestamp,
    'X-Live-Signature': options.signature || sign(body, timestamp, options.secret || SECRET),
    ...options.headers
  };
  return fetch(`${harness.baseUrl}${ENDPOINT}`, {
    method: 'POST',
    headers,
    body
  });
}

test('live event ingress is hidden by default', async (t) => {
  const harness = await createHarness(t, {
    env: {
      LIVE_EVENT_INGEST_ENABLED: 'false',
      LIVE_EVENT_INGEST_SECRET: '',
      LIVE_EVENT_ALLOWED_TARGETS: ''
    }
  });
  const response = await sendEvent(harness, baseEvent('danmaku'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
});

test('enabled ingress fails closed when its secret or target configuration is unsafe', async (t) => {
  const harness = await createHarness(t, {
    env: {
      LIVE_EVENT_INGEST_ENABLED: 'true',
      LIVE_EVENT_INGEST_SECRET: '',
      LIVE_EVENT_MAX_SKEW_SECONDS: '300',
      LIVE_EVENT_ALLOWED_TARGETS: `${SITE_ID}:${ROOM_ID}`
    }
  });
  const response = await sendEvent(harness, baseEvent('danmaku'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'rejected', reason: 'ingest_unavailable' });
  assert.equal(harness.repository.records.size, 0);
});

test('signature validation accepts valid HMAC and rejects bad or malformed signatures safely', async (t) => {
  const harness = await createHarness(t);
  const accepted = await sendEvent(harness, baseEvent('danmaku', 10));
  assert.equal(accepted.status, 201);

  const bad = await sendEvent(harness, baseEvent('danmaku', 11), {
    signature: '0'.repeat(64)
  });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).reason, 'invalid_service_signature');

  const wrongLength = await sendEvent(harness, baseEvent('danmaku', 12), {
    signature: 'abcd'
  });
  assert.equal(wrongLength.status, 401);
  assert.equal((await wrongLength.json()).reason, 'invalid_service_signature');

  const missing = await sendEvent(harness, baseEvent('danmaku', 13), {
    headers: { 'X-Live-Signature': '' }
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).reason, 'invalid_service_signature');
  assert.equal(harness.repository.records.size, 1);
});

test('timestamps outside the past or future skew window are rejected', async (t) => {
  const harness = await createHarness(t);
  for (const offset of [-301, 301]) {
    const timestamp = String(Number(FIXED_TIMESTAMP) + offset);
    const response = await sendEvent(harness, baseEvent('danmaku', 20 + offset), { timestamp });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, 'timestamp_out_of_range');
  }
  assert.equal(harness.repository.records.size, 0);
});

test('only uncompressed application/json service requests are accepted', async (t) => {
  const harness = await createHarness(t);
  const nonJson = await sendEvent(harness, baseEvent('danmaku', 30), {
    contentType: 'text/plain'
  });
  assert.equal(nonJson.status, 415);
  assert.equal((await nonJson.json()).reason, 'unsupported_media_type');

  const browser = await sendEvent(harness, baseEvent('danmaku', 31), {
    headers: { Origin: 'https://example.com', Cookie: 'session=synthetic' }
  });
  assert.equal(browser.status, 403);
  assert.equal((await browser.json()).reason, 'service_identity_required');
  assert.equal(harness.repository.records.size, 0);
});

test('malformed JSON and bodies over 64 KiB receive stable errors', async (t) => {
  const harness = await createHarness(t);
  const malformed = await sendEvent(harness, null, { body: '{"schema_version":' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).reason, 'invalid_json');

  const oversizedBody = JSON.stringify({
    event: 'synthetic',
    padding: 'x'.repeat(MAX_LIVE_EVENT_BODY_BYTES)
  });
  const oversized = await sendEvent(harness, null, { body: oversizedBody });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).reason, 'payload_too_large');
  assert.equal(harness.repository.records.size, 0);
});

test('site and room targets must match one explicit allowed pair', async (t) => {
  const harness = await createHarness(t);
  const wrongSite = baseEvent('danmaku', 40);
  wrongSite.site_id = 'other-site';
  const siteResponse = await sendEvent(harness, wrongSite);
  assert.equal(siteResponse.status, 403);
  assert.equal((await siteResponse.json()).reason, 'target_not_allowed');

  const wrongRoom = baseEvent('danmaku', 41);
  wrongRoom.room_id = '123456789';
  const roomResponse = await sendEvent(harness, wrongRoom);
  assert.equal(roomResponse.status, 403);
  assert.equal((await roomResponse.json()).reason, 'target_not_allowed');
  assert.equal(harness.repository.records.size, 0);
});

test('all eight standard event types pass strict synthetic fixtures', async (t) => {
  const harness = await createHarness(t);
  const eventTypes = Object.keys(COMMANDS);
  for (const [index, eventType] of eventTypes.entries()) {
    const response = await sendEvent(harness, baseEvent(eventType, 100 + index));
    assert.equal(response.status, 201, eventType);
    assert.equal((await response.json()).status, 'accepted');
  }
  assert.equal(harness.repository.records.size, 8);
});

test('all eight event types reject a fixture missing a required field', async (t) => {
  const harness = await createHarness(t);
  const cases = [
    ['danmaku', (event) => delete event.actor.open_id],
    ['gift', (event) => delete event.payload.gift_id],
    ['super_chat', (event) => delete event.payload.message],
    ['guard_buy', (event) => delete event.payload.guard_level],
    ['like', (event) => delete event.payload.like_count],
    ['room_enter', (event) => delete event.source.platform],
    ['live_start', (event) => delete event.source.cmd],
    ['live_end', (event) => delete event.occurred_at]
  ];
  for (const [index, [eventType, removeField]] of cases.entries()) {
    const event = baseEvent(eventType, 200 + index);
    removeField(event);
    const response = await sendEvent(harness, event);
    assert.equal(response.status, 422, eventType);
    assert.equal((await response.json()).reason, 'invalid_event_schema');
  }
  assert.equal(harness.repository.records.size, 0);
});

test('unknown types, schema versions, fields, and invalid ISO timestamps are rejected', async (t) => {
  const harness = await createHarness(t);
  const fixtures = [];

  const unknownType = baseEvent('danmaku', 300);
  unknownType.event_type = 'follow';
  fixtures.push(unknownType);

  const wrongVersion = baseEvent('danmaku', 301);
  wrongVersion.schema_version = '2.0';
  fixtures.push(wrongVersion);

  const unknownField = baseEvent('danmaku', 302);
  unknownField.raw_official_packet = { unrestricted: true };
  fixtures.push(unknownField);

  const invalidDate = baseEvent('danmaku', 303);
  invalidDate.occurred_at = 'not-an-iso-date';
  fixtures.push(invalidDate);

  for (const event of fixtures) {
    const response = await sendEvent(harness, event);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).reason, 'invalid_event_schema');
  }
  assert.equal(harness.repository.records.size, 0);
});

test('nested unknown fields, numeric UID substitution, and unbounded values are rejected', async (t) => {
  const harness = await createHarness(t);
  const fixtures = [];

  const unknownSource = baseEvent('danmaku', 320);
  unknownSource.source.auth_body = 'not-allowed';
  fixtures.push(unknownSource);

  const unknownDelivery = baseEvent('danmaku', 321);
  unknownDelivery.delivery.raw_packet = {};
  fixtures.push(unknownDelivery);

  const numericUid = baseEvent('danmaku', 322);
  delete numericUid.actor.open_id;
  numericUid.actor.uid = '123456789';
  fixtures.push(numericUid);

  const oversizedText = baseEvent('danmaku', 323);
  oversizedText.payload.text = 'x'.repeat(501);
  fixtures.push(oversizedText);

  const unexpectedArray = baseEvent('room_enter', 324);
  unexpectedArray.payload = { values: [] };
  fixtures.push(unexpectedArray);

  const invalidAvatar = baseEvent('danmaku', 325);
  invalidAvatar.actor.avatar_url = 'not-a-valid-url';
  fixtures.push(invalidAvatar);

  const paddedOpenId = baseEvent('danmaku', 326);
  paddedOpenId.actor.open_id = ' padded-open-id ';
  fixtures.push(paddedOpenId);

  const paddedUnionId = baseEvent('danmaku', 327);
  paddedUnionId.actor.union_id = ' padded-union-id ';
  fixtures.push(paddedUnionId);

  for (const event of fixtures) {
    const response = await sendEvent(harness, event);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).reason, 'invalid_event_schema');
  }
  assert.equal(harness.repository.records.size, 0);
});

test('room_id remains an exact string beyond JavaScript safe integer range', async (t) => {
  const harness = await createHarness(t);
  const event = baseEvent('like', 400);
  const response = await sendEvent(harness, event);
  assert.equal(response.status, 201);
  assert.equal(harness.repository.records.get(event.event_id).roomId, ROOM_ID);
  assert.equal(typeof harness.repository.records.get(event.event_id).roomId, 'string');
});

test('actor open_id is mandatory for viewer events but live_start may use a null actor', async (t) => {
  const harness = await createHarness(t);
  const danmaku = baseEvent('danmaku', 410);
  delete danmaku.actor.open_id;
  const rejected = await sendEvent(harness, danmaku);
  assert.equal(rejected.status, 422);

  const liveStart = baseEvent('live_start', 411);
  assert.equal(liveStart.actor, null);
  const accepted = await sendEvent(harness, liveStart);
  assert.equal(accepted.status, 201);
  assert.equal(harness.repository.records.size, 1);
});

test('accepted, duplicate, and event_id conflict ACKs are deterministic', async (t) => {
  const harness = await createHarness(t);
  const original = baseEvent('gift', 500);
  const accepted = await sendEvent(harness, original);
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), {
    status: 'accepted',
    event_id: original.event_id
  });

  const duplicate = await sendEvent(harness, clone(original));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), {
    status: 'duplicate',
    event_id: original.event_id
  });

  const conflictEvent = clone(original);
  conflictEvent.payload.gift_num = 3;
  const conflict = await sendEvent(harness, conflictEvent);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    status: 'rejected',
    reason: 'event_id_conflict',
    event_id: original.event_id
  });
  assert.equal(harness.repository.records.size, 1);
});

test('canonical hashing ignores JSON object key order', async (t) => {
  const harness = await createHarness(t);
  const event = baseEvent('super_chat', 510);
  const reverseObjectKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseObjectKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).reverse().reduce((result, key) => {
      result[key] = reverseObjectKeys(value[key]);
      return result;
    }, {});
  };

  const first = await sendEvent(harness, event);
  assert.equal(first.status, 201);
  const reordered = await sendEvent(harness, null, {
    body: JSON.stringify(reverseObjectKeys(event))
  });
  assert.equal(reordered.status, 200);
  assert.equal((await reordered.json()).status, 'duplicate');
  assert.equal(harness.repository.records.size, 1);
});

test('replay mode keeps the listener-provided event_id unchanged', async (t) => {
  const harness = await createHarness(t);
  const event = baseEvent('room_enter', 520);
  event.mode = 'replay';
  event.delivery.replay = true;
  event.delivery.attempt = 2;
  const response = await sendEvent(harness, event);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).event_id, event.event_id);
  assert.equal(harness.repository.records.get(event.event_id).mode, 'replay');
});

test('audit logs exclude message text, platform identifiers, secrets, and signatures', async (t) => {
  const harness = await createHarness(t);
  const event = baseEvent('danmaku', 530);
  event.payload.text = 'SYNTHETIC_DANMAKU_TEXT_MUST_NOT_BE_LOGGED';
  const body = JSON.stringify(event);
  const signature = sign(body);
  const response = await sendEvent(harness, event, { body, signature });
  assert.equal(response.status, 201);

  const serializedLogs = JSON.stringify(harness.logs);
  assert.equal(serializedLogs.includes(event.payload.text), false);
  assert.equal(serializedLogs.includes(event.actor.open_id), false);
  assert.equal(serializedLogs.includes(event.actor.union_id), false);
  assert.equal(serializedLogs.includes(SECRET), false);
  assert.equal(serializedLogs.includes(signature), false);
  assert.match(serializedLogs, /synthetic:danmaku:530/);
});

test('new event modules remain isolated from points and queue code', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [
    path.join(root, 'routes', 'liveEvents.js'),
    path.join(root, 'controllers', 'liveEventController.js'),
    path.join(root, 'services', 'liveEventService.js')
  ];
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /pointsService|point_accounts|point_wallets|queue/i);
  assert.equal(require.cache[require.resolve('../src/services/pointsService')], undefined);
});

test('accepted, duplicate, and conflict paths write only through the live_events repository', async (t) => {
  const repository = createMemoryRepository();
  const harness = await createHarness(t, { repository });
  const event = baseEvent('gift', 540);

  assert.equal((await sendEvent(harness, event)).status, 201);
  assert.equal((await sendEvent(harness, clone(event))).status, 200);
  const conflict = clone(event);
  conflict.payload.price = '2000';
  assert.equal((await sendEvent(harness, conflict)).status, 409);

  assert.deepEqual(new Set(repository.writes.map((write) => write.table)), new Set(['live_events']));
  assert.equal(repository.records.size, 1);
});

test('database failure is never acknowledged as accepted', async (t) => {
  const service = {
    async record() {
      const error = new Error('synthetic database failure');
      error.code = 'SYNTHETIC_DB_FAILURE';
      throw error;
    }
  };
  const harness = await createHarness(t, { service });
  const response = await sendEvent(harness, baseEvent('gift', 550));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    status: 'rejected',
    reason: 'database_error'
  });
});

test('concurrent delivery of one event_id stores exactly one record', async (t) => {
  const harness = await createHarness(t);
  const event = baseEvent('like', 560);
  const responses = await Promise.all([
    sendEvent(harness, clone(event)),
    sendEvent(harness, clone(event))
  ]);
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 201]);
  assert.equal(harness.repository.records.size, 1);
});
