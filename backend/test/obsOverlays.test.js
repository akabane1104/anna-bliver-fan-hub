const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  createEventSchema,
  snapshotQuerySchema
} = require('../src/schemas/obsOverlaySchemas');
const {
  createObsOverlayEventService
} = require('../src/services/obsOverlayEventService');
const {
  createObsOverlayRealtime
} = require('../src/services/obsOverlayRealtime');
const {
  activityForOverlay,
  createObsOverlayStateRepository,
  createObsOverlayService
} = require('../src/services/obsOverlayService');
const {
  createObsOverlayController
} = require('../src/controllers/obsOverlayController');
const { createLiveControlController } = require('../src/controllers/liveControlController');

function requestFixture(overrides = {}) {
  return {
    display_key: 'masked-request-key',
    canonical_song: { title: 'Synthetic Song', artist: 'Synthetic Artist' },
    masked_display_name: 'S***r',
    status: 'queued',
    queue_order: '9',
    position: 1,
    eta: { display_text: '约 4 分钟' },
    ...overrides
  };
}

test('public OBS snapshot reuses masked song DTOs and exposes no private request fields', async () => {
  const realtime = createObsOverlayRealtime();
  realtime.publish('test');
  const service = createObsOverlayService({
    clock: () => Date.parse('2026-07-24T12:05:00.000Z'),
    realtime,
    stateRepository: {
      async getSongState() {
        return {
          current: requestFixture({ status: 'singing' }),
          next: requestFixture({ display_key: 'next-key' }),
          queue: [requestFixture({ display_key: 'next-key' })],
          todayRequestCount: 3
        };
      }
    },
    liveHomeService: {
      async getAdminHome() {
        return {
          control: {
            activity: {
              enabled: true,
              title: 'Synthetic Activity',
              content: 'Safe public copy',
              starts_at: '2026-07-24T12:00:00.000Z',
              ends_at: '2026-07-24T12:10:00.000Z'
            }
          }
        };
      }
    },
    eventService: {
      async listActive() {
        return [{
          publicId: 'd42ae51a-ae15-4a69-b56d-a44da466b2b8',
          sequence: '4',
          eventType: 'notice',
          source: 'simulator',
          payload: { text: 'Synthetic notice', style: 'info' },
          displayDurationMs: 4000
        }];
      }
    }
  });

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.todayRequestCount, 3);
  assert.equal(snapshot.currentSong.requester, 'S***r');
  assert.equal(snapshot.currentSong.title, 'Synthetic Song');
  assert.equal(snapshot.activity.status, 'active');
  assert.equal(snapshot.activity.progress, 0.5);
  const serialized = JSON.stringify(snapshot);
  for (const privateField of [
    'requester_user_id',
    'requester_open_id',
    'raw_request_text',
    'internal_note',
    'email',
    'token',
    'points'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateField, 'i'));
  }
});

test('activity overlay hides invalid windows and reports upcoming and ended states', () => {
  const activity = {
    enabled: true,
    title: 'Window',
    content: '',
    starts_at: '2026-07-24T12:00:00.000Z',
    ends_at: '2026-07-24T13:00:00.000Z'
  };
  assert.equal(
    activityForOverlay(activity, Date.parse('2026-07-24T11:00:00.000Z')).status,
    'upcoming'
  );
  assert.equal(
    activityForOverlay(activity, Date.parse('2026-07-24T14:00:00.000Z')).status,
    'ended'
  );
  assert.equal(activityForOverlay({ ...activity, ends_at: null }, Date.now()), null);
});

test('today request count uses the Beijing calendar day and only valid queue states', async () => {
  const queries = [];
  const repository = createObsOverlayStateRepository({
    clock: () => Date.parse('2026-07-24T16:05:00.000Z'),
    pool: {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (queries.length === 1) return [[]];
        return [[{ request_count: 4 }]];
      }
    }
  });

  const state = await repository.getSongState();
  assert.equal(state.todayRequestCount, 4);
  assert.match(
    queries[1].sql,
    /status IN \('needs_match','queued','active','completed'\)/
  );
  assert.match(queries[1].sql, /requested_at >= \? AND requested_at < \?/);
  assert.deepEqual(queries[1].params, [
    '2026-07-24 16:00:00.000',
    '2026-07-25 16:00:00.000'
  ]);
});

test('queue maxItems accepts 1 to 10 and safely falls back to five', () => {
  assert.equal(snapshotQuerySchema.parse({ maxItems: 1 }).maxItems, 1);
  assert.equal(snapshotQuerySchema.parse({ maxItems: 10 }).maxItems, 10);
  assert.equal(snapshotQuerySchema.parse({ maxItems: 0 }).maxItems, 5);
  assert.equal(snapshotQuerySchema.parse({ maxItems: 11 }).maxItems, 5);
  assert.equal(snapshotQuerySchema.parse({ maxItems: 'unsafe' }).maxItems, 5);
});

test('overlay event service keeps payload allowlists and source idempotency', async () => {
  const realtime = createObsOverlayRealtime();
  let publishes = 0;
  realtime.subscribe(() => {
    publishes += 1;
  });
  const stored = [];
  const repository = {
    async create(input) {
      stored.push(input);
      return {
        duplicate: stored.length > 1,
        row: {
          sequence: 7,
          public_id: '4d632ef5-1073-4b23-adf6-b93ea30f03c4',
          event_type: input.eventType,
          source: input.source,
          payload_json: input.payload,
          display_duration_ms: input.displayDurationMs,
          created_at: '2026-07-24T12:00:00.000Z',
          replay_until: '2026-07-24T12:00:04.000Z',
          dismissed_at: null
        }
      };
    }
  };
  const service = createObsOverlayEventService({ repository, realtime });
  const input = {
    eventType: 'gift_thanks',
    source: 'simulator',
    displayDurationMs: 4000,
    idempotencyKey: 'synthetic-gift-0001',
    payload: {
      displayName: 'Synthetic Viewer',
      giftName: 'Synthetic Gift',
      count: 2
    }
  };
  assert.equal((await service.create(input, 1)).duplicate, false);
  assert.equal((await service.create(input, 1)).duplicate, true);
  assert.equal(publishes, 1);
  assert.deepEqual(Object.keys(stored[0].payload).sort(), [
    'count',
    'displayName',
    'giftName'
  ]);
});

test('manual event validation rejects production sources, markup, and unknown payload keys', () => {
  const base = {
    eventType: 'notice',
    source: 'manual',
    displayDurationMs: 4000,
    idempotencyKey: 'synthetic-notice-0001',
    payload: { text: 'Plain text', style: 'info' }
  };
  assert.equal(createEventSchema.safeParse(base).success, true);
  assert.equal(createEventSchema.safeParse({ ...base, source: 'bilibili' }).success, false);
  assert.equal(createEventSchema.safeParse({
    ...base,
    payload: { ...base.payload, text: '<script>alert(1)</script>' }
  }).success, false);
  assert.equal(createEventSchema.safeParse({
    ...base,
    payload: { ...base.payload, privateNote: 'must not pass' }
  }).success, false);
});

test('the future AI service accepts completed plain text without any model integration', async () => {
  let captured;
  const service = createObsOverlayEventService({
    realtime: { publish() {} },
    repository: {
      async create(input) {
        captured = input;
        return {
          duplicate: false,
          row: {
            sequence: 8,
            public_id: '9c9ba45a-0268-44bc-942f-1c240452f48e',
            event_type: input.eventType,
            source: input.source,
            payload_json: input.payload,
            display_duration_ms: input.displayDurationMs,
            idempotency_key: input.idempotencyKey,
            created_at: '2026-07-24T12:00:00.000Z',
            replay_until: '2026-07-24T12:00:06.000Z',
            dismissed_at: null
          }
        };
      }
    }
  });
  await service.publishAiBubble({
    text: 'Synthetic completed sentence',
    persona: 'normal',
    idempotencyKey: 'synthetic-ai-0001'
  });
  assert.equal(captured.source, 'ai');
  assert.deepEqual(captured.payload, {
    text: 'Synthetic completed sentence',
    persona: 'normal'
  });
});

test('SSE sends an initial snapshot, reacts to invalidation, and cleans up listeners', async () => {
  const realtime = createObsOverlayRealtime();
  let reads = 0;
  const controller = createObsOverlayController({
    realtime,
    heartbeatMs: 60000,
    overlayService: {
      async getSnapshot() {
        reads += 1;
        return { schemaVersion: '1', revision: realtime.getRevision(), events: [] };
      }
    }
  });
  const req = new EventEmitter();
  req.query = {};
  const res = new EventEmitter();
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.chunks = [];
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };

  await controller.stream(req, res);
  realtime.publish('test_update');
  await new Promise((resolve) => setImmediate(resolve));
  req.emit('close');
  realtime.publish('ignored_after_close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reads, 2);
  assert.equal(res.chunks.filter((chunk) => chunk.startsWith('event: snapshot')).length, 2);
});

test('SSE emits heartbeat comments without serializing private state', async () => {
  const realtime = createObsOverlayRealtime();
  const controller = createObsOverlayController({
    realtime,
    heartbeatMs: 5,
    overlayService: {
      async getSnapshot() {
        return { schemaVersion: '1', revision: 0, events: [] };
      }
    }
  });
  const req = new EventEmitter();
  req.query = {};
  const res = new EventEmitter();
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.chunks = [];
  res.write = (chunk) => res.chunks.push(chunk);
  await controller.stream(req, res);
  await new Promise((resolve) => setTimeout(resolve, 12));
  req.emit('close');
  assert.ok(res.chunks.includes(': heartbeat\n\n'));
});

test('complete-and-advance publishes OBS state only after the service transaction returns', async () => {
  const order = [];
  const controller = createLiveControlController({
    requestService: {
      async advanceCurrent() {
        order.push('transaction_returned');
        return {
          previous: { public_id: 'previous' },
          current: { public_id: 'current' }
        };
      },
      async getRequest(publicId) {
        return { public_id: publicId };
      }
    },
    realtime: {
      publish() {
        order.push('published');
      }
    }
  });
  const req = {
    params: { publicId: 'f8b1f957-d0d9-4115-bd31-b79f73438a12' },
    body: { expected_version: 1, outcome: 'completed', activate_next: true },
    userId: 2
  };
  const res = {
    json(value) {
      order.push('responded');
      return value;
    },
    status() {
      return this;
    }
  };
  await controller.advanceCurrent(req, res);
  assert.deepEqual(order, ['transaction_returned', 'published', 'responded']);
});

test('public reads stay anonymous while event writes keep backend permission checks', () => {
  const root = path.resolve(__dirname, '..', 'src');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const liveControl = fs.readFileSync(path.join(root, 'routes', 'liveControl.js'), 'utf8');
  const marshmallows = fs.readFileSync(path.join(root, 'routes', 'marshmallows.js'), 'utf8');
  const eventService = fs.readFileSync(
    path.join(root, 'services', 'obsOverlayEventService.js'),
    'utf8'
  );
  assert.match(server, /app\.use\('\/api\/public\/obs-overlay', createObsOverlayRouter\(\)\)/);
  assert.ok(
    liveControl.indexOf('controlRouter.use(authorize)')
      < liveControl.indexOf("controlRouter.post('/obs-overlay/events'")
  );
  assert.match(
    marshmallows,
    /post\('\/:id\/obs', authMiddleware, requirePermission\(PERMISSIONS\.MARSHMALLOW_MANAGE\)/
  );
  assert.doesNotMatch(
    eventService,
    /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:live_events|bilibili_point_events|point_)/i
  );
});
