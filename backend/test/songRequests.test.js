const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const {
  normalizeSongText,
  parseSongRequestCommand
} = require('../src/utils/songText');
const { matchSongCatalog } = require('../src/services/songMatcherService');
const {
  canonicalStatus,
  maskDisplayName
} = require('../src/services/songRequestCanonical');
const {
  calculateEta,
  createSongRequestPolicyService,
  loadPolicySettings,
  lockUserAndBindings,
  resolveCapacityBlocked,
  taipeiDayBounds
} = require('../src/services/songRequestPolicyService');
const {
  canSetFulfillmentType,
  canTransitionRequest,
  canTransitionSession
} = require('../src/services/songRequestStateMachine');
const { createSongRequestService } = require('../src/services/songRequestService');
const { createSongRequestController } = require('../src/controllers/songRequestController');
const { createLiveControlController } = require('../src/controllers/liveControlController');
const { createSongRequestRouter } = require('../src/routes/songRequests');
const { createLiveControlRouter } = require('../src/routes/liveControl');

const TARGET = Object.freeze({
  site_id: 'synthetic-site',
  room_id: '900719925474099312345'
});

function song(id, title, artist = 'Synthetic Artist') {
  return { id, playlist_id: 1, title, artist, duration: null };
}

async function createHarness(t, mountPath, router) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  app.use((error, req, res, next) => {
    void error;
    void req;
    void next;
    res.status(500).json({ code: 'unexpected_test_error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${server.address().port}${mountPath}`;
}

test('strict parser accepts only spaced 点歌 and 點歌 commands', () => {
  const accepted = [
    ['点歌 年轮', '年轮'],
    ['點歌 年輪', '年輪'],
    ['点歌　年轮', '年轮'],
    ['點歌     年輪', '年輪'],
    [' \t點歌 年輪　', '年輪']
  ];
  for (const [input, expectedTitle] of accepted) {
    const result = parseSongRequestCommand(input);
    assert.equal(result.matched, true, input);
    assert.equal(result.requested_title, expectedTitle, input);
    assert.equal(result.raw_text, input, input);
  }
});

test('strict parser rejects unspaced, colon, playback, and conversational forms', () => {
  const rejected = [
    '点歌年轮',
    '點歌年輪',
    '点歌：年轮',
    '點歌：年輪',
    '播放 年轮',
    '播放 年輪',
    '播歌 年轮',
    '唱歌 年轮',
    '我想点歌 年轮',
    '可以唱年轮吗',
    '点歌',
    '點歌',
    '点歌机怎么用',
    '这个点歌功能不错'
  ];
  for (const input of rejected) {
    assert.equal(parseSongRequestCommand(input).matched, false, input);
  }
});

test('strict parser rejects multiline, unsafe control, and oversized input', () => {
  assert.equal(parseSongRequestCommand('点歌 年轮\n谢谢').reason, 'multiline_text_not_allowed');
  assert.equal(parseSongRequestCommand('点歌 年\u0000轮').reason, 'unsafe_control_character');
  assert.equal(parseSongRequestCommand(`点歌 ${'年'.repeat(1025)}`).reason, 'text_too_long');
  assert.equal(parseSongRequestCommand('点歌 \t').matched, false);
});

test('normalization preserves raw text while deriving NFKC, whitespace, script, and loose keys', () => {
  const result = normalizeSongText('  ＦＡＮＣＹ　年輪\t ');
  assert.equal(result.raw_text, '  ＦＡＮＣＹ　年輪\t ');
  assert.equal(result.nfkc_text, '  FANCY 年輪\t ');
  assert.equal(result.whitespace_normalized, 'FANCY 年輪');
  assert.equal(result.script_key, 'FANCY 年轮');
  assert.equal(result.loose_candidate_key, 'fancy 年轮');
});

test('Simplified and Traditional titles match without changing stored display text', () => {
  const simplified = matchSongCatalog({ songs: [song(1, '年轮')] }, '年輪');
  assert.equal(simplified.kind, 'matched');
  assert.equal(simplified.match_method, 'script_exact');
  assert.equal(simplified.song.title, '年轮');
  assert.equal(simplified.normalization.raw_text, '年輪');

  const traditional = matchSongCatalog({ songs: [song(2, '後來')] }, '后来');
  assert.equal(traditional.kind, 'matched');
  assert.equal(traditional.match_method, 'script_exact');
  assert.equal(traditional.song.title, '後來');
  assert.equal(traditional.normalization.raw_text, '后来');
});

test('original exact title wins before a Simplified/Traditional collision', () => {
  const songs = [song(1, '後台'), song(2, '后台')];
  const exact = matchSongCatalog({ songs }, '後台');
  assert.equal(exact.kind, 'matched');
  assert.equal(exact.match_method, 'exact');
  assert.equal(exact.song.id, 1);

  const collision = matchSongCatalog({
    songs: [song(3, '後臺'), song(4, '后台')]
  }, '後台');
  assert.equal(collision.kind, 'ambiguous');
  assert.deepEqual(collision.candidates.map(({ id }) => id), [3, 4]);
});

test('aliases support exact and script matching while conflicts stay ambiguous', () => {
  const songs = [song(1, '幸运歌'), song(2, '另一首')];
  const aliases = [{
    id: 1,
    song_id: 1,
    alias: '小幸運',
    normalized_alias: '小幸運',
    script_key: '小幸运',
    loose_candidate_key: '小幸运'
  }];
  assert.equal(matchSongCatalog({ songs, aliases }, '小幸運').match_method, 'alias_exact');
  assert.equal(matchSongCatalog({ songs, aliases }, '小幸运').match_method, 'alias_script');

  const conflictingAliases = [
    ...aliases,
    {
      id: 2,
      song_id: 2,
      alias: '小幸運',
      normalized_alias: '小幸運',
      script_key: '小幸运',
      loose_candidate_key: '小幸运'
    }
  ];
  const conflict = matchSongCatalog({ songs, aliases: conflictingAliases }, '小幸运');
  assert.equal(conflict.kind, 'ambiguous');
  assert.equal(conflict.candidates.length, 2);
});

test('unmatched queries return candidates only when loose matching finds them', () => {
  const songs = [song(1, 'Merry Christmas Mr. Lawrence')];
  const candidate = matchSongCatalog({ songs }, 'merry christmas');
  assert.equal(candidate.kind, 'ambiguous');
  assert.equal(candidate.song, null);
  assert.equal(candidate.candidates[0].id, 1);

  const unmatched = matchSongCatalog({ songs }, '完全不存在');
  assert.equal(unmatched.kind, 'unmatched');
  assert.deepEqual(unmatched.candidates, []);
});

test('fancy and FANCY remain case-sensitive and Fancy is never auto-selected', () => {
  const songs = [song(1, 'fancy'), song(2, 'FANCY')];
  const lower = matchSongCatalog({ songs }, 'fancy');
  const upper = matchSongCatalog({ songs }, 'FANCY');
  const mixed = matchSongCatalog({ songs }, 'Fancy');
  assert.equal(lower.kind, 'matched');
  assert.equal(lower.song.id, 1);
  assert.equal(upper.kind, 'matched');
  assert.equal(upper.song.id, 2);
  assert.equal(mixed.kind, 'ambiguous');
  assert.deepEqual(mixed.candidates.map(({ id }) => id), [1, 2]);
});

test('canonical statuses and public names preserve legacy storage without identity leakage', () => {
  assert.equal(canonicalStatus('observed'), 'pending_review');
  assert.equal(canonicalStatus('needs_match'), 'pending_review');
  assert.equal(canonicalStatus('active'), 'singing');
  assert.equal(canonicalStatus('failed'), 'skipped');
  assert.equal(canonicalStatus('cancelled'), 'withdrawn');
  assert.equal(maskDisplayName('Synthetic Viewer'), 'S***r');
  assert.equal(maskDisplayName('安'), '安***');
});

test('fuzzy matching has a safe length gate and a unique second-place gap', () => {
  const catalog = {
    songs: [
      song(1, 'Synthetic Horizon'),
      song(2, 'Synthetic Harbor')
    ],
    aliases: []
  };
  const matched = matchSongCatalog(catalog, 'Synthetic Horizom');
  assert.equal(matched.kind, 'matched');
  assert.equal(matched.match_method, 'fuzzy');
  assert.equal(matched.song.id, 1);
  assert.notEqual(matchSongCatalog({ songs: [song(1, 'abc')], aliases: [] }, 'abd').kind, 'matched');
  assert.notEqual(
    matchSongCatalog({
      songs: [song(1, 'abcdefg1'), song(2, 'abcdefg2')],
      aliases: []
    }, 'abcdefg3').kind,
    'matched'
  );
});

test('ETA uses range output and Asia Taipei calendar boundaries', () => {
  const eta = calculateEta([
    {
      public_id: 'active',
      status: 'active',
      matched_song_id: 1,
      duration: '04:00',
      duration_override_seconds: null
    },
    {
      public_id: 'waiting',
      status: 'queued',
      matched_song_id: 2,
      duration: null,
      duration_override_seconds: 300
    }
  ], [], {
    default_duration_seconds: 240,
    buffer_seconds: 60,
    eta_paused: false
  });
  assert.equal(eta.waiting_count, 1);
  assert.deepEqual(eta.requests[1].eta, {
    paused: false,
    min_minutes: 4,
    max_minutes: 6
  });
  assert.deepEqual(
    taipeiDayBounds(new Date('2026-07-26T08:00:00.000Z')),
    {
      start: '2026-07-25 16:00:00.000',
      end: '2026-07-26 16:00:00.000'
    }
  );
});

test('website identity lock requires a verified binding and one active request maximum', async () => {
  const queries = [];
  const connection = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM users')) {
        return [[{ id: 42, username: 'Synthetic Viewer' }]];
      }
      if (sql.includes('FROM user_bilibili_bindings')) return [[{ id: 7 }]];
      if (sql.includes('FROM song_requests')) return [[{ id: 9 }]];
      throw new Error('unexpected query');
    }
  };
  await assert.rejects(
    lockUserAndBindings(connection, 42, { requireBinding: true }),
    (error) => error.code === 'user_active_limit'
  );
  assert.equal(queries.every((sql) => /FOR UPDATE/.test(sql)), true);
});

test('capacity hysteresis uses strict ETA boundaries and stable song thresholds', () => {
  const openConfig = {
    auto_capacity_blocked: false,
    queue_limit: 12,
    reopen_threshold: 8,
    eta_close_minutes: 60,
    eta_reopen_minutes: 40
  };
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 12, max_eta_minutes: 40 },
    openConfig
  ), true);
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 11, max_eta_minutes: 60 },
    openConfig
  ), false);
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 11, max_eta_minutes: 61 },
    openConfig
  ), true);

  const blockedConfig = { ...openConfig, auto_capacity_blocked: true };
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 8, max_eta_minutes: 39 },
    blockedConfig
  ), false);
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 8, max_eta_minutes: 40 },
    blockedConfig
  ), true);
  assert.equal(resolveCapacityBlocked(
    { waiting_count: 9, max_eta_minutes: 39 },
    blockedConfig
  ), true);
});

test('policy reads stay read-only and partial settings updates preserve omitted values', async () => {
  const values = new Map([
    ['song_request_cooldown_minutes', '90'],
    ['song_request_block_repeat_today', 'true'],
    ['song_request_queue_limit', '12'],
    ['song_request_reopen_threshold', '8'],
    ['song_request_eta_close_minutes', '60'],
    ['song_request_eta_reopen_minutes', '40'],
    ['song_request_default_duration_seconds', '240'],
    ['song_request_buffer_seconds', '60'],
    ['song_request_eta_paused', 'true'],
    ['song_request_active_event_tag_id', '9'],
    ['song_request_settings_revision', '0']
  ]);
  const query = async (sql, params = []) => {
    if (/^SELECT setting_key, setting_value/.test(sql.trim())) {
      return [[...values].map(([setting_key, setting_value]) => ({
        setting_key,
        setting_value
      }))];
    }
    if (/^INSERT IGNORE INTO settings/.test(sql.trim())) {
      if (!values.has(params[0])) values.set(params[0], String(params[1]));
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE settings/.test(sql.trim())) {
      if (params.length === 1) {
        values.set(params[0], String(Number(values.get(params[0])) + 1));
      } else {
        values.set(params[1], params[0]);
      }
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const readCalls = [];
  await loadPolicySettings({
    async query(sql, params) {
      readCalls.push(sql);
      return query(sql, params);
    }
  });
  assert.equal(readCalls.length, 1);
  assert.match(readCalls[0], /^SELECT setting_key, setting_value/);

  const connection = {
    query,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {}
  };
  const service = createSongRequestPolicyService({
    pool: {
      query,
      async getConnection() {
        return connection;
      }
    }
  });
  const updated = await service.updateSettings({
    queue_limit: 14,
    reopen_threshold: 9,
    max_eta_minutes: 70,
    reopen_eta_minutes: 45,
    default_song_seconds: 300,
    buffer_seconds: 75,
    expected_revision: 0
  }, 42);
  assert.equal(updated.cooldown_minutes, 90);
  assert.equal(updated.block_repeat_today, true);
  assert.equal(updated.eta_paused, true);
  assert.equal(updated.active_event_tag_id, 9);
  assert.equal(updated.queue_limit, 14);
  assert.equal(updated.revision, 1);
  const requestService = createSongRequestService({
    pool: {},
    policyService: service
  });
  assert.equal((await requestService.getPolicySettings()).revision, 1);
  await assert.rejects(
    service.updateSettings({
      queue_limit: 15,
      reopen_threshold: 9,
      max_eta_minutes: 70,
      reopen_eta_minutes: 45,
      default_song_seconds: 300,
      buffer_seconds: 75,
      expected_revision: 0
    }, 42),
    (error) => error.code === 'version_conflict'
  );
});

test('song policy partial updates preserve omitted fields and reject stale versions', async () => {
  let policy = {
    song_id: 7,
    temporarily_blocked: 1,
    public_reason: 'Temporary public reason',
    internal_note: 'Private operator note',
    blocked_until: new Date('2026-07-30T00:00:00.000Z'),
    released_at: null,
    special_event_tag_id: 9,
    duration_override_seconds: 330,
    version: 6
  };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      if (/SELECT id FROM songs/.test(sql)) return [[{ id: 7 }]];
      if (/FROM song_request_policies[\s\S]+FOR UPDATE/.test(sql)) return [[policy]];
      if (/INSERT INTO song_request_policies/.test(sql)) {
        policy = {
          ...policy,
          temporarily_blocked: params[1],
          public_reason: params[2],
          internal_note: params[3],
          blocked_until: params[4],
          special_event_tag_id: params[5],
          duration_override_seconds: params[6],
          version: policy.version + 1
        };
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  const service = createSongRequestPolicyService({
    pool: {
      async getConnection() {
        return connection;
      },
      async query(sql) {
        if (/FROM song_request_policies/.test(sql)) return [[policy]];
        throw new Error(`unexpected query: ${sql}`);
      }
    }
  });

  const updated = await service.setPolicy(7, {
    blocked: false,
    public_reason: null,
    expected_version: 6
  }, 42);
  assert.equal(updated.blocked, false);
  assert.equal(updated.public_reason, null);
  assert.equal(updated.internal_note, 'Private operator note');
  assert.equal(updated.special_event_tag_id, 9);
  assert.equal(updated.duration_override_seconds, 330);
  assert.equal(updated.version, 7);
  await assert.rejects(
    service.setPolicy(7, {
      blocked: true,
      expected_version: 6
    }, 42),
    (error) => error.code === 'version_conflict'
  );
});

test('rerequest preserves the original target for matched and unmatched history', async () => {
  const service = createSongRequestService({
    pool: {
      async query() {
        return [[{
          id: 11,
          public_id: '11111111-1111-4111-8111-111111111111',
          requester_user_id: 42,
          site_id: 'synthetic-site',
          room_id: '10001',
          status: 'rejected',
          requested_title: 'Synthetic Song',
          matched_song_id: null,
          match_method: 'unmatched',
          version: 1
        }]];
      }
    },
    policyService: {}
  });
  let captured = null;
  service.createWebsiteRequest = async (input) => {
    captured = input;
    return { duplicate: false, request: { public_id: 'new-request' } };
  };
  await service.rerequest(
    '11111111-1111-4111-8111-111111111111',
    42,
    'synthetic-rerequest-key'
  );
  assert.deepEqual(captured, {
    site_id: 'synthetic-site',
    room_id: '10001',
    song_id: undefined,
    query: 'Synthetic Song'
  });
});

test('session and request state machines allow only documented transitions', () => {
  assert.equal(canTransitionSession('draft', 'open'), true);
  assert.equal(canTransitionSession('open', 'paused'), true);
  assert.equal(canTransitionSession('paused', 'open'), true);
  assert.equal(canTransitionSession('closed', 'open'), false);
  assert.equal(canTransitionRequest('observed', 'queued'), true);
  assert.equal(canTransitionRequest('queued', 'active'), true);
  assert.equal(canTransitionRequest('active', 'completed'), true);
  assert.equal(canTransitionRequest('completed', 'active'), false);
  assert.equal(canTransitionRequest('failed', 'queued'), true);
  assert.equal(canSetFulfillmentType('queued'), true);
  assert.equal(canSetFulfillmentType('active'), true);
  assert.equal(canSetFulfillmentType('completed'), false);
});

test('non-danmaku and ordinary danmaku never create song requests', async () => {
  const service = createSongRequestService({ pool: {} });
  const connection = {
    query() {
      throw new Error('database access was not expected');
    }
  };
  const nonDanmaku = await service.observeAcceptedDanmaku({
    event_type: 'gift'
  }, { connection });
  assert.equal(nonDanmaku.status, 'ignored');

  const ordinary = await service.observeAcceptedDanmaku({
    event_type: 'danmaku',
    payload: { text: '这个点歌功能不错' }
  }, { connection });
  assert.equal(ordinary.status, 'ignored');
});

test('website request API requires authentication and a valid Idempotency-Key', async (t) => {
  const deniedController = createSongRequestController({
    service: {
      async createWebsiteRequest() {
        throw new Error('service must not run');
      }
    }
  });
  const deniedBaseUrl = await createHarness(t, '/api/song-requests', createSongRequestRouter({
    controller: deniedController,
    authenticate: (req, res) => res.status(401).json({ message: 'Authentication required' })
  }));
  const unauthenticated = await fetch(deniedBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...TARGET, query: '年轮' })
  });
  assert.equal(unauthenticated.status, 401);

  let called = false;
  const controller = createSongRequestController({
    service: {
      async createWebsiteRequest() {
        called = true;
      }
    }
  });
  const baseUrl = await createHarness(t, '/api/song-requests', createSongRequestRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    }
  }));
  const missingKey = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...TARGET, query: '年轮' })
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).code, 'invalid_idempotency_key');
  assert.equal(called, false);
});

test('website request identity and fulfillment fields cannot be forged', async (t) => {
  let called = false;
  const controller = createSongRequestController({
    service: {
      async createWebsiteRequest() {
        called = true;
      }
    }
  });
  const baseUrl = await createHarness(t, '/api/song-requests', createSongRequestRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    }
  }));

  for (const forged of [
    { requester_user_id: 99 },
    { requester_open_id: 'synthetic-private-open-id' },
    { fulfillment_type: 'played' },
    { role: 'admin' },
    { query: '年\n轮' },
    { query: '年\u0000轮' }
  ]) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `synthetic-key-${Object.keys(forged)[0]}`
      },
      body: JSON.stringify({ ...TARGET, query: '年轮', ...forged })
    });
    assert.equal(response.status, 422);
  }
  assert.equal(called, false);
});

test('website request API uses server identity and reports accepted or duplicate', async (t) => {
  const calls = [];
  let duplicate = false;
  const safeRequest = {
    public_id: 'fa07f1fd-8041-4e5c-a822-c556255a7cd8',
    requested_title: '年轮',
    status: 'queued',
    fulfillment_type: 'undecided'
  };
  const controller = createSongRequestController({
    service: {
      async createWebsiteRequest(input, identity) {
        calls.push({ input, identity });
        return { duplicate, request: safeRequest };
      },
      async getRequest() {
        return safeRequest;
      },
      async getPublicRequest() {
        return safeRequest;
      }
    }
  });
  const baseUrl = await createHarness(t, '/api/song-requests', createSongRequestRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    }
  }));
  const send = () => fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'synthetic-request-key'
    },
    body: JSON.stringify({ ...TARGET, query: '年轮' })
  });

  let response = await send();
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, 'accepted');
  duplicate = true;
  response = await send();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'duplicate');
  assert.deepEqual(calls.map(({ identity }) => identity), [
    { userId: 42, idempotencyKey: 'synthetic-request-key' },
    { userId: 42, idempotencyKey: 'synthetic-request-key' }
  ]);
});

test('current queue projection excludes platform and website identity fields', async () => {
  let call = 0;
  const pool = {
    async query() {
      call += 1;
      if (call === 1) {
        return [[{
          id: 10,
          public_id: 'e77a274f-ec55-4a62-9060-22fc18b5e067',
          title: 'Synthetic Session',
          status: 'open'
        }]];
      }
      return [[{
        public_id: 'fa07f1fd-8041-4e5c-a822-c556255a7cd8',
        requested_title: '年轮',
        requester_display_name: 'Synthetic Viewer',
        requester_open_id: 'must-not-leak',
        requester_user_id: 42,
        email: 'must-not-leak@example.com',
        status: 'queued',
        fulfillment_type: 'undecided',
        queue_order: '1',
        requested_at: new Date('2026-07-23T00:00:00Z'),
        song_title: '年轮',
        song_artist: 'Synthetic Artist',
        song_duration: null
      }]];
    }
  };
  const result = await createSongRequestService({ pool }).getCurrentQueue(
    TARGET.site_id,
    TARGET.room_id
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /open_id|user_id|email|must-not-leak/);
  assert.equal(result.requests[0].matched_song.title, '年轮');
});

test('live-control routes require authorization and expose no history mutation route', async (t) => {
  let controllerCalled = false;
  const controller = new Proxy({}, {
    get() {
      return async (req, res) => {
        void req;
        controllerCalled = true;
        res.json({ status: 'accepted' });
      };
    }
  });
  const deniedBaseUrl = await createHarness(t, '/api/live-control', createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    },
    authorize: (req, res) => res.status(403).json({ message: 'Permission denied' })
  }));
  const denied = await fetch(`${deniedBaseUrl}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(denied.status, 403);
  assert.equal(controllerCalled, false);

  const allowedBaseUrl = await createHarness(t, '/api/live-control', createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));
  const historyMutation = await fetch(`${allowedBaseUrl}/history/1`, {
    method: 'DELETE'
  });
  assert.equal(historyMutation.status, 404);
});

test('catalog policy and alias writes require playlist permission', async (t) => {
  let controllerCalls = 0;
  const controller = new Proxy({}, {
    get() {
      return async (req, res) => {
        void req;
        controllerCalls += 1;
        res.json({ status: 'accepted' });
      };
    }
  });
  const baseUrl = await createHarness(t, '/api/live-control', createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next(),
    authorizeCatalog: (req, res) => res.status(403).json({ message: 'Permission denied' })
  }));

  const policy = await fetch(`${baseUrl}/songs/7/policy`);
  assert.equal(policy.status, 403);
  const aliasSavingMatch = await fetch(`${baseUrl}/requests/request-id/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ save_alias: true })
  });
  assert.equal(aliasSavingMatch.status, 403);
  assert.equal(controllerCalls, 0);

  const oneOffMatch = await fetch(`${baseUrl}/requests/request-id/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ save_alias: false })
  });
  assert.equal(oneOffMatch.status, 200);
  assert.equal(controllerCalls, 1);
});

test('recoverable sessions route returns only the service-selected authority state', async (t) => {
  const recovered = {
    public_id: '14770010-286b-4324-bff5-3908af212b47',
    site_id: TARGET.site_id,
    room_id: TARGET.room_id,
    playlist_id: 1,
    title: 'Synthetic Draft',
    status: 'draft',
    version: 2
  };
  let calls = 0;
  const controller = createLiveControlController({
    sessionService: {
      async listRecoverable() {
        calls += 1;
        return [recovered];
      }
    }
  });
  const baseUrl = await createHarness(t, '/api/live-control', createLiveControlRouter({
    controller,
    authenticate: (req, res, next) => next(),
    authorize: (req, res, next) => next()
  }));

  const response = await fetch(`${baseUrl}/sessions/recoverable`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessions: [recovered] });
  assert.equal(calls, 1);
});

test('new song-request modules do not call points, legacy bot, OBS, or player controls', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = [
    '../src/services/songRequestService.js',
    '../src/services/liveSessionService.js',
    '../src/services/songMatcherService.js',
    '../src/controllers/songRequestController.js',
    '../src/controllers/liveControlController.js'
  ];
  const source = files
    .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /pointsService|botEventBridge|point_wallets|point_accounts/i);
  assert.doesNotMatch(source, /\bOBS\b|酷狗|kugou/i);
});
