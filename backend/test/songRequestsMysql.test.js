const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const {
  createLiveEventService,
  createMysqlLiveEventRepository
} = require('../src/services/liveEventService');
const { validateLiveEvent } = require('../src/schemas/liveEventSchema');
const { createLiveHomeRepository } = require('../src/services/liveHomeService');
const { createLiveSessionService } = require('../src/services/liveSessionService');
const { matchSongInPlaylist } = require('../src/services/songMatcherService');
const { createSongRequestService } = require('../src/services/songRequestService');
const { SongRequestError } = require('../src/utils/songRequestError');

const CONFIRMATION = 'phase4c-isolated-song-requests';
const integrationEnabled = process.env.PHASE4C_TEST_DB_CONFIRM === CONFIRMATION;
const SITE_ID = 'phase4c-test';
const ROOM_ID = '900719925474099312345';
const TARGET = Object.freeze({ site_id: SITE_ID, room_id: ROOM_ID });

function liveEvent(eventId, text, options = {}) {
  const eventType = options.eventType || 'danmaku';
  const parsed = validateLiveEvent({
    schema_version: '1.0',
    event_id: eventId,
    event_type: eventType,
    site_id: options.siteId || SITE_ID,
    room_id: options.roomId || ROOM_ID,
    mode: options.mode || 'simulation',
    source: {
      platform: 'bilibili_live_open',
      cmd: eventType === 'danmaku'
        ? 'LIVE_OPEN_PLATFORM_DM'
        : 'LIVE_OPEN_PLATFORM_SEND_GIFT',
      message_id: `${eventId}:message`,
      session_id: 'phase4c-isolated-session'
    },
    actor: {
      open_id: 'phase4c_synthetic_open_id_private',
      display_name: 'Synthetic Viewer'
    },
    occurred_at: '2026-07-23T00:00:00.000Z',
    received_at: '2026-07-23T00:00:01.000Z',
    payload: eventType === 'danmaku'
      ? { text, dm_type: 'text' }
      : {
        gift_id: 'synthetic-gift',
        gift_name: 'Synthetic Gift',
        gift_num: 1,
        paid: true,
        price: '1000',
        r_price: '1000',
        price_unit: 'bilibili_price'
      },
    delivery: {
      attempt: 1,
      replay: options.mode === 'replay'
    }
  });
  assert.equal(parsed.success, true);
  return parsed.data;
}

async function expectServiceError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function tableCount(pool, table) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
  return Number(rows[0].count);
}

async function snapshotCounts(pool, tables) {
  const snapshot = new Map();
  for (const table of tables) snapshot.set(table, await tableCount(pool, table));
  return snapshot;
}

test('isolated MySQL validates unified song requests, transactions, ordering, and history', {
  skip: !integrationEnabled,
  timeout: 120000
}, async () => {
  const host = process.env.PHASE4C_TEST_DB_HOST;
  const port = Number(process.env.PHASE4C_TEST_DB_PORT);
  const internalDockerTarget = (
    process.env.PHASE4C_TEST_DB_INTERNAL_NETWORK_CONFIRM ===
      'phase4c-guid-internal-network' &&
    /^afh4h-mysql-[a-f0-9]{12}$/.test(host) &&
    port === 3306
  );
  const isolatedLoopbackTarget = (
    host === '127.0.0.1' &&
    Number.isInteger(port) &&
    port > 0 &&
    port !== 3306
  );
  if (!internalDockerTarget && !isolatedLoopbackTarget) {
    throw new Error('Refusing integration test without an isolated loopback or GUID internal Docker target');
  }

  const pool = mysql.createPool({
    host,
    port,
    user: 'root',
    password: '',
    database: 'anna_bliver_fan_hub',
    connectionLimit: 12,
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  try {
    const [tableRows] = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
       ORDER BY table_name`
    );
    assert.equal(tableRows.length, 29);
    const tableNames = new Set(tableRows.map((row) => row.TABLE_NAME || row.table_name));
    for (const name of [
      'live_events',
      'live_sessions',
      'song_requests',
      'song_request_history',
      'song_aliases',
      'song_request_policies',
      'song_request_details'
    ]) {
      assert.equal(tableNames.has(name), true, name);
    }

    const legacyTables = [
      'permissions',
      'user_bilibili_bindings',
      'point_wallets',
      'point_accounts',
      'point_account_transactions',
      'bilibili_point_events',
      'prizes',
      'prize_orders',
      'marshmallows'
    ];
    const legacyBefore = await snapshotCounts(pool, legacyTables);

    const [userResult] = await pool.query(
      `INSERT INTO users (username, email, password, role)
       VALUES ('phase4c-admin', 'phase4c-admin@example.com', 'synthetic-not-used', 'admin')`
    );
    const actorUserId = userResult.insertId;
    const [playlistResult] = await pool.query(
      `INSERT INTO playlists (title, description, created_by)
       VALUES ('Phase 4C Synthetic Playlist', 'Isolated test data', ?)`,
      [actorUserId]
    );
    const playlistId = playlistResult.insertId;
    const [otherPlaylistResult] = await pool.query(
      `INSERT INTO playlists (title, description, created_by)
       VALUES ('Phase 4C Other Playlist', 'Isolated test data', ?)`,
      [actorUserId]
    );
    const otherPlaylistId = otherPlaylistResult.insertId;
    const seedSongs = [
      ['年轮', 'Synthetic Artist'],
      ['後來', 'Synthetic Artist'],
      ['fancy', 'Synthetic Artist'],
      ['FANCY', 'Synthetic Artist'],
      ['後臺', 'Synthetic Artist'],
      ['后台', 'Synthetic Artist']
    ];
    const songIds = {};
    for (const [title, artist] of seedSongs) {
      const [result] = await pool.query(
        `INSERT INTO songs (playlist_id, title, artist)
         VALUES (?, ?, ?)`,
        [playlistId, title, artist]
      );
      songIds[title] = result.insertId;
    }
    const [otherSongResult] = await pool.query(
      `INSERT INTO songs (playlist_id, title, artist)
       VALUES (?, 'Other Playlist Song', 'Synthetic Artist')`,
      [otherPlaylistId]
    );

    const [titlesBefore] = await pool.query(
      'SELECT id, title, artist FROM songs ORDER BY id'
    );
    const sessionService = createLiveSessionService({ pool });
    const testPolicy = {
      async resolveBoundUserByOpenId() {
        return { id: actorUserId, username: 'phase4c-admin' };
      },
      async lockUserAndBindings() {
        return {
          user: { id: actorUserId, username: 'phase4c-admin' },
          bindings: [{ id: 1 }]
        };
      },
      async assertSongPolicy(connection) {
        const [rows] = await connection.query(
          `SELECT setting_value FROM settings
           WHERE setting_key = 'live_home_song_requests_open' LIMIT 1`
        );
        if (rows[0]?.setting_value === 'false') {
          throw new SongRequestError(409, 'requests_closed', 'synthetic closed gate');
        }
        return {};
      }
    };
    const requestService = createSongRequestService({ pool, policy: testPolicy });
    const liveService = createLiveEventService({
      repository: createMysqlLiveEventRepository(pool),
      acceptedEventObserver: requestService.observeAcceptedDanmaku.bind(requestService)
    });

    const firstConcurrentDraft = await sessionService.createDraft({
      site_id: 'phase4c-concurrency',
      room_id: '10001',
      playlist_id: playlistId,
      title: 'Concurrent A'
    }, actorUserId);
    const secondConcurrentPublicId = '00000000-0000-4000-8000-000000000042';
    await pool.query(
      `INSERT INTO live_sessions (
         public_id, site_id, room_id, playlist_id, title, status,
         created_by_user_id
       ) VALUES (?, 'phase4c-concurrency', '10001', ?, 'Concurrent B', 'draft', ?)`,
      [secondConcurrentPublicId, playlistId, actorUserId]
    );
    const secondConcurrentDraft = await sessionService.getByPublicId(
      secondConcurrentPublicId
    );
    const activeResults = await Promise.allSettled([
      sessionService.transition(firstConcurrentDraft.public_id, 'open', 0),
      sessionService.transition(secondConcurrentDraft.public_id, 'open', 0)
    ]);
    assert.deepEqual(
      activeResults.map(({ status }) => status).sort(),
      ['fulfilled', 'rejected']
    );
    const rejectedActive = activeResults.find(({ status }) => status === 'rejected');
    assert.equal(rejectedActive.reason.code, 'active_session_exists');
    const openedConcurrent = activeResults.find(({ status }) => status === 'fulfilled').value;
    await sessionService.transition(
      openedConcurrent.public_id,
      'closed',
      openedConcurrent.version
    );
    const remainingDraft = firstConcurrentDraft.public_id === openedConcurrent.public_id
      ? secondConcurrentDraft
      : firstConcurrentDraft;
    await sessionService.transition(remainingDraft.public_id, 'closed', 0);

    let lifecycle = await sessionService.createDraft({
      site_id: 'phase4c-lifecycle',
      room_id: '10002',
      playlist_id: playlistId,
      title: 'Lifecycle'
    }, actorUserId);
    lifecycle = await sessionService.transition(lifecycle.public_id, 'open', lifecycle.version);
    lifecycle = await sessionService.transition(lifecycle.public_id, 'paused', lifecycle.version);
    lifecycle = await sessionService.transition(lifecycle.public_id, 'open', lifecycle.version);
    lifecycle = await sessionService.transition(lifecycle.public_id, 'closed', lifecycle.version);
    await expectServiceError(
      sessionService.transition(lifecycle.public_id, 'open', lifecycle.version),
      'invalid_session_transition'
    );

    let session = await sessionService.createDraft({
      site_id: SITE_ID,
      room_id: ROOM_ID,
      playlist_id: playlistId,
      title: 'Main Synthetic Session'
    }, actorUserId);
    session = await sessionService.transition(session.public_id, 'open', session.version);

    const prefix = `phase4c:${Date.now()}`;
    const [policyUserResult] = await pool.query(
      `INSERT INTO users (username, email, password, role)
       VALUES (?, ?, 'synthetic-not-used', 'user')`,
      [`phase4i-viewer-${Date.now()}`, `phase4i-${Date.now()}@example.com`]
    );
    const policyUserId = policyUserResult.insertId;
    await pool.query(
      `INSERT INTO user_bilibili_bindings (
         user_id, bilibili_uid, bilibili_open_id, bilibili_uname, status
       ) VALUES (?, ?, ?, 'phase4i-viewer', 'verified')`,
      [policyUserId, `9${String(Date.now()).slice(-12)}`, `${prefix}:bound-open-id`]
    );
    const productionPolicyService = createSongRequestService({ pool });
    const policyResults = await Promise.allSettled([
      productionPolicyService.createWebsiteRequest({
        ...TARGET,
        song_id: songIds['後臺']
      }, {
        userId: policyUserId,
        idempotencyKey: `${prefix}:policy-a`
      }),
      productionPolicyService.createWebsiteRequest({
        ...TARGET,
        song_id: songIds['后台']
      }, {
        userId: policyUserId,
        idempotencyKey: `${prefix}:policy-b`
      })
    ]);
    assert.deepEqual(
      policyResults.map(({ status }) => status).sort(),
      ['fulfilled', 'rejected']
    );
    assert.equal(
      policyResults.find(({ status }) => status === 'rejected').reason.code,
      'user_active_limit'
    );
    const firstPolicyRequest = policyResults.find(({ status }) => status === 'fulfilled').value;
    const skippedPolicyRequest = await productionPolicyService.transitionRequest(
      firstPolicyRequest.request.public_id,
      'skipped',
      { expected_version: firstPolicyRequest.request.version },
      actorUserId
    );
    const replacementSongId = Object.values(songIds)
      .find((songId) => Number(songId) !== Number(skippedPolicyRequest.matched_song_id));
    assert.ok(replacementSongId);
    await productionPolicyService.createWebsiteRequest({
      ...TARGET,
      song_id: replacementSongId
    }, {
      userId: policyUserId,
      idempotencyKey: `${prefix}:policy-replacement`
    });
    await expectServiceError(
      productionPolicyService.transitionRequest(
        skippedPolicyRequest.public_id,
        'queued',
        { expected_version: skippedPolicyRequest.version },
        actorUserId
      ),
      'user_active_limit'
    );
    const [policyRequests] = await pool.query(
      'SELECT id FROM song_requests WHERE requester_user_id = ?',
      [policyUserId]
    );
    assert.equal(policyRequests.length, 2);
    await pool.query(
      `DELETE FROM song_request_history
       WHERE request_id IN (
         SELECT id FROM song_requests WHERE requester_user_id = ?
       )`,
      [policyUserId]
    );
    await pool.query(
      'DELETE FROM song_requests WHERE requester_user_id = ?',
      [policyUserId]
    );
    await pool.query(
      'DELETE FROM user_bilibili_bindings WHERE user_id = ?',
      [policyUserId]
    );
    await pool.query('DELETE FROM users WHERE id = ?', [policyUserId]);

    const productionPolicyLiveService = createLiveEventService({
      repository: createMysqlLiveEventRepository(pool),
      acceptedEventObserver: productionPolicyService.observeAcceptedDanmaku.bind(
        productionPolicyService
      )
    });
    const requestsBeforeUnknownIdentity = await tableCount(pool, 'song_requests');
    const unknownIdentity = await productionPolicyLiveService.record(
      liveEvent(`${prefix}:unknown-identity`, '点歌 年轮')
    );
    assert.equal(unknownIdentity.status, 'accepted');
    assert.deepEqual(unknownIdentity.observation, {
      status: 'ignored',
      reason: 'identity_binding_required'
    });
    assert.equal(await tableCount(pool, 'song_requests'), requestsBeforeUnknownIdentity);

    const firstEvent = liveEvent(`${prefix}:first`, '點歌 年輪');
    const firstResult = await liveService.record(firstEvent);
    assert.equal(firstResult.status, 'accepted');
    assert.equal(firstResult.observation.status, 'created');
    assert.equal(firstResult.observation.request.status, 'queued');
    assert.equal(firstResult.observation.request.match_method, 'script_exact');
    assert.equal(firstResult.observation.request.requested_title, '年輪');
    assert.equal((await liveService.record(firstEvent)).status, 'duplicate');
    const conflict = await liveService.record(liveEvent(`${prefix}:first`, '點歌 後來'));
    assert.equal(conflict.status, 'rejected');
    assert.equal(conflict.reason, 'event_id_conflict');
    assert.equal(await tableCount(pool, 'song_requests'), 1);

    const concurrentEvent = liveEvent(`${prefix}:concurrent`, '点歌 年轮');
    const concurrentResults = await Promise.all([
      liveService.record(concurrentEvent),
      liveService.record(concurrentEvent)
    ]);
    assert.deepEqual(
      concurrentResults.map(({ status }) => status).sort(),
      ['accepted', 'duplicate']
    );
    const [concurrentRequestRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM song_requests WHERE source_event_id = ?',
      [concurrentEvent.event_id]
    );
    assert.equal(Number(concurrentRequestRows[0].count), 1);

    const ordinary = await liveService.record(
      liveEvent(`${prefix}:ordinary`, '这个点歌功能不错')
    );
    assert.equal(ordinary.status, 'accepted');
    assert.equal(ordinary.observation.status, 'ignored');
    const gift = await liveService.record(
      liveEvent(`${prefix}:gift`, '', { eventType: 'gift' })
    );
    assert.equal(gift.status, 'accepted');
    assert.equal(gift.observation.status, 'ignored');

    const replay = await liveService.record(
      liveEvent(`${prefix}:replay`, '点歌 後來', { mode: 'replay' })
    );
    assert.equal(replay.status, 'accepted');
    const [replayRows] = await pool.query(
      `SELECT source, source_event_id, requester_user_id, requester_open_id
       FROM song_requests WHERE source_event_id = ?`,
      [`${prefix}:replay`]
    );
    assert.equal(replayRows[0].source, 'replay');
    assert.equal(replayRows[0].source_event_id, `${prefix}:replay`);
    assert.equal(Number(replayRows[0].requester_user_id), actorUserId);
    assert.equal(replayRows[0].requester_open_id, 'phase4c_synthetic_open_id_private');

    session = await sessionService.getByPublicId(session.public_id);
    session = await sessionService.transition(session.public_id, 'paused', session.version);
    const requestsBeforePausedEvent = await tableCount(pool, 'song_requests');
    const pausedEvent = await liveService.record(
      liveEvent(`${prefix}:paused`, '点歌 年轮')
    );
    assert.equal(pausedEvent.status, 'accepted');
    assert.deepEqual(pausedEvent.observation, {
      status: 'ignored',
      reason: 'requests_closed'
    });
    assert.equal(await tableCount(pool, 'song_requests'), requestsBeforePausedEvent);
    session = await sessionService.transition(session.public_id, 'open', session.version);

    const alias = await requestService.addAlias(songIds['年轮'], '圈圈歌', actorUserId);
    assert.equal((await matchSongInPlaylist(pool, playlistId, '圈圈歌')).match_method, 'alias_exact');
    await requestService.addAlias(songIds['年轮'], '小幸運', actorUserId);
    assert.equal((await matchSongInPlaylist(pool, playlistId, '小幸运')).match_method, 'alias_script');
    await expectServiceError(
      requestService.addAlias(songIds['後來'], '小幸運', actorUserId),
      'equivalent_alias_exists'
    );
    assert.equal((await matchSongInPlaylist(pool, playlistId, '小幸运')).song.id, songIds['年轮']);
    assert.equal(await tableCount(pool, 'song_aliases'), 2);

    const exactLower = await matchSongInPlaylist(pool, playlistId, 'fancy');
    const exactUpper = await matchSongInPlaylist(pool, playlistId, 'FANCY');
    const mixedCase = await matchSongInPlaylist(pool, playlistId, 'Fancy');
    assert.equal(exactLower.song.id, songIds.fancy);
    assert.equal(exactUpper.song.id, songIds.FANCY);
    assert.equal(mixedCase.kind, 'ambiguous');
    assert.deepEqual(
      mixedCase.candidates.map(({ title }) => title).sort(),
      ['FANCY', 'fancy']
    );
    const scriptCollision = await matchSongInPlaylist(pool, playlistId, '後台');
    assert.equal(scriptCollision.kind, 'ambiguous');

    const websiteInput = { ...TARGET, query: 'fancy' };
    const website = await requestService.createWebsiteRequest(websiteInput, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-website-request'
    });
    assert.equal(website.duplicate, false);
    assert.equal(website.request.requester_user_id, actorUserId);
    assert.equal(website.request.fulfillment_type, 'undecided');
    const websiteDuplicate = await requestService.createWebsiteRequest(websiteInput, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-website-request'
    });
    assert.equal(websiteDuplicate.duplicate, true);
    const websiteBySongId = await requestService.createWebsiteRequest({
      song_id: songIds['年轮']
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4g-website-song-id'
    });
    assert.equal(websiteBySongId.duplicate, false);
    assert.equal(websiteBySongId.request.source, 'website');
    assert.equal(websiteBySongId.request.matched_song_id, songIds['年轮']);
    await expectServiceError(
      requestService.createWebsiteRequest({ ...TARGET, query: 'FANCY' }, {
        userId: actorUserId,
        idempotencyKey: 'phase4c-website-request'
      }),
      'idempotency_key_conflict'
    );
    await expectServiceError(
      requestService.createWebsiteRequest({
        ...TARGET,
        song_id: otherSongResult.insertId
      }, {
        userId: actorUserId,
        idempotencyKey: 'phase4c-wrong-playlist'
      }),
      'song_not_in_session_playlist'
    );
    await expectServiceError(
      requestService.createWebsiteRequest({
        site_id: 'phase4c-no-session',
        room_id: '10003',
        query: '年轮'
      }, {
        userId: actorUserId,
        idempotencyKey: 'phase4c-no-session-request'
      }),
      'no_open_session'
    );

    const manual = await requestService.createManualRequest({
      ...TARGET,
      session_public_id: session.public_id,
      query: '年輪'
    }, actorUserId);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.status, 'queued');
    assert.equal(manual.requester_display_name, '人工点歌');
    assert.equal(manual.fulfillment_type, 'undecided');

    const rejectedSource = await requestService.createWebsiteRequest({
      ...TARGET,
      query: 'Phase 4I unmatched review request'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-rejected'
    });
    assert.equal(rejectedSource.request.status, 'needs_match');
    const rejected = await requestService.transitionRequest(
      rejectedSource.request.public_id,
      'rejected',
      { expected_version: 0, reason: 'synthetic rejection' },
      actorUserId
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.queue_order, null);

    const cancelledSource = await requestService.createWebsiteRequest({
      ...TARGET,
      query: '年轮'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-cancelled'
    });
    const cancelled = await requestService.transitionRequest(
      cancelledSource.request.public_id,
      'cancelled',
      { expected_version: 0, reason: 'synthetic cancellation' },
      actorUserId
    );
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.queue_order, null);

    const concurrentWebsite = await Promise.all(
      Array.from({ length: 6 }, (_, index) => requestService.createWebsiteRequest(
        { ...TARGET, query: index % 2 ? '年轮' : '後來' },
        {
          userId: actorUserId,
          idempotencyKey: `phase4c-concurrent-request-${index}`
        }
      ))
    );
    assert.equal(new Set(concurrentWebsite.map(({ request }) => request.queue_order)).size, 6);

    const unmatched = await requestService.createWebsiteRequest({
      ...TARGET,
      query: '不存在的合成歌曲'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-unmatched'
    });
    assert.equal(unmatched.request.status, 'needs_match');
    const acceptedUnmatched = await requestService.acceptUnmatched(
      unmatched.request.public_id,
      { expected_version: 0, reason: 'synthetic manual acceptance' },
      actorUserId
    );
    assert.equal(acceptedUnmatched.status, 'queued');
    assert.equal(acceptedUnmatched.match_method, 'manual');

    const ambiguous = await requestService.createWebsiteRequest({
      ...TARGET,
      query: 'Fancy'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-ambiguous'
    });
    assert.equal(ambiguous.request.status, 'needs_match');
    await expectServiceError(
      requestService.transitionRequest(
        ambiguous.request.public_id,
        'queued',
        { expected_version: 0 },
        actorUserId
      ),
      'match_confirmation_required'
    );
    const manuallyMatched = await requestService.setManualMatch(
      ambiguous.request.public_id,
      {
        song_id: songIds.FANCY,
        expected_version: 0,
        reason: 'synthetic exact choice'
      },
      actorUserId
    );
    assert.equal(manuallyMatched.status, 'queued');
    assert.equal(manuallyMatched.matched_song_id, songIds.FANCY);

    let stateRequest = await requestService.getRequest(website.request.public_id);
    stateRequest = await requestService.transitionRequest(
      stateRequest.public_id,
      'active',
      { expected_version: stateRequest.version },
      actorUserId
    );
    assert.equal(stateRequest.queue_order, null);
    await expectServiceError(
      requestService.transitionRequest(
        stateRequest.public_id,
        'completed',
        { expected_version: stateRequest.version },
        actorUserId
      ),
      'fulfillment_type_required'
    );
    stateRequest = await requestService.setFulfillmentType(
      stateRequest.public_id,
      {
        expected_version: stateRequest.version,
        fulfillment_type: 'sung',
        reason: 'synthetic fulfillment'
      },
      actorUserId
    );
    stateRequest = await requestService.transitionRequest(
      stateRequest.public_id,
      'completed',
      { expected_version: stateRequest.version },
      actorUserId
    );
    assert.equal(stateRequest.status, 'completed');
    await expectServiceError(
      requestService.transitionRequest(
        stateRequest.public_id,
        'active',
        { expected_version: stateRequest.version },
        actorUserId
      ),
      'invalid_request_transition'
    );
    await expectServiceError(
      requestService.setFulfillmentType(
        stateRequest.public_id,
        {
          expected_version: stateRequest.version,
          fulfillment_type: 'played'
        },
        actorUserId
      ),
      'fulfillment_type_locked'
    );

    const skippedSource = await requestService.createWebsiteRequest({
      ...TARGET,
      query: '年轮'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-skipped'
    });
    const skipped = await requestService.transitionRequest(
      skippedSource.request.public_id,
      'skipped',
      { expected_version: 0 },
      actorUserId
    );
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.fulfillment_type, 'undecided');

    const failedSource = await requestService.createWebsiteRequest({
      ...TARGET,
      query: '後來'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-failed'
    });
    let failed = await requestService.transitionRequest(
      failedSource.request.public_id,
      'active',
      { expected_version: 0 },
      actorUserId
    );
    failed = await requestService.transitionRequest(
      failed.public_id,
      'failed',
      { expected_version: failed.version },
      actorUserId
    );
    failed = await requestService.transitionRequest(
      failed.public_id,
      'queued',
      { expected_version: failed.version },
      actorUserId
    );
    assert.equal(failed.status, 'queued');
    assert.notEqual(failed.queue_order, null);

    const currentBeforeReorder = await requestService.getSessionRequests(session.public_id);
    const reorderable = currentBeforeReorder.requests
      .filter(({ status }) => ['needs_match', 'queued'].includes(status))
      .map(({ public_id }) => public_id);
    assert.ok(reorderable.length > 4);
    const reorderVersion = currentBeforeReorder.session.version;
    const reorderedIds = [...reorderable].reverse();
    const reordered = await requestService.reorder(
      session.public_id,
      {
        expected_version: reorderVersion,
        request_public_ids: reorderedIds
      },
      actorUserId
    );
    assert.deepEqual(reordered.request_public_ids, reorderedIds);
    await expectServiceError(
      requestService.reorder(
        session.public_id,
        {
          expected_version: reorderVersion,
          request_public_ids: reorderedIds
        },
        actorUserId
      ),
      'version_conflict'
    );
    const afterReorder = await requestService.getSessionRequests(session.public_id);
    const [latestUndoRows] = await pool.query(
      `SELECT h.id, h.action,
              JSON_CONTAINS_PATH(h.metadata, 'one', '$.before') AS has_before,
              TIMESTAMPDIFF(SECOND, h.created_at, UTC_TIMESTAMP(3)) AS age_seconds
       FROM song_request_history h
       INNER JOIN song_requests sr ON sr.id = h.request_id
       INNER JOIN live_sessions ls ON ls.id = sr.session_id
       WHERE ls.public_id = ?
       ORDER BY h.id DESC
       LIMIT 1`,
      [session.public_id]
    );
    assert.equal(latestUndoRows[0].action, 'reordered');
    assert.equal(Number(latestUndoRows[0].has_before), 1);
    assert.ok(Number(latestUndoRows[0].age_seconds) <= 30);
    assert.equal(afterReorder.undo.available, true);
    const [newerHistoryResult] = await pool.query(
      `INSERT INTO song_request_history (
         request_id, action, actor_user_id, metadata
       ) SELECT id, 'synthetic_newer_change', ?, JSON_OBJECT()
         FROM song_requests
         WHERE public_id = ?`,
      [actorUserId, reorderable[0]]
    );
    await expectServiceError(
      requestService.undoLatest(afterReorder.undo.expected_revision, actorUserId),
      'undo_conflict'
    );
    await pool.query(
      'DELETE FROM song_request_history WHERE id = ?',
      [newerHistoryResult.insertId]
    );
    await requestService.undoLatest(afterReorder.undo.expected_revision, actorUserId);
    const afterReorderUndo = await requestService.getSessionRequests(session.public_id);
    assert.deepEqual(
      afterReorderUndo.requests
        .filter(({ status }) => ['pending_review', 'queued'].includes(status))
        .map(({ public_id }) => public_id),
      reorderable
    );

    let foreignSession = await sessionService.createDraft({
      site_id: 'phase4c-foreign',
      room_id: '10004',
      playlist_id: playlistId,
      title: 'Foreign Session'
    }, actorUserId);
    foreignSession = await sessionService.transition(
      foreignSession.public_id,
      'open',
      foreignSession.version
    );
    const foreignRequest = await requestService.createWebsiteRequest({
      site_id: foreignSession.site_id,
      room_id: foreignSession.room_id,
      query: '年轮'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-foreign-request'
    });
    const currentSession = await sessionService.getByPublicId(session.public_id);
    await expectServiceError(
      requestService.reorder(
        session.public_id,
        {
          expected_version: currentSession.version,
          request_public_ids: [...reorderedIds, foreignRequest.request.public_id]
        },
        actorUserId
      ),
      'invalid_reorder_set'
    );
    foreignSession = await sessionService.getByPublicId(foreignSession.public_id);
    await sessionService.transition(
      foreignSession.public_id,
      'closed',
      foreignSession.version
    );

    const concurrentActiveQueue = await requestService.getSessionRequests(session.public_id);
    const concurrentActiveCandidates = concurrentActiveQueue.requests
      .filter(({ status }) => status === 'queued')
      .slice(0, 2);
    assert.equal(concurrentActiveCandidates.length, 2);
    const concurrentActiveResults = await Promise.allSettled(
      concurrentActiveCandidates.map((candidate) => requestService.transitionRequest(
        candidate.public_id,
        'active',
        { expected_version: candidate.version },
        actorUserId
      ))
    );
    assert.deepEqual(
      concurrentActiveResults.map(({ status }) => status).sort(),
      ['fulfilled', 'rejected']
    );
    assert.equal(
      concurrentActiveResults.find(({ status }) => status === 'rejected').reason.code,
      'active_request_exists'
    );
    const concurrentlyActivated = concurrentActiveResults
      .find(({ status }) => status === 'fulfilled').value;
    await requestService.transitionRequest(
      concurrentlyActivated.public_id,
      'skipped',
      { expected_version: concurrentlyActivated.version },
      actorUserId
    );

    const beforeActiveMix = await requestService.getSessionRequests(session.public_id);
    const activeCandidate = beforeActiveMix.requests.find(({ status }) => status === 'queued');
    const activated = await requestService.transitionRequest(
      activeCandidate.public_id,
      'active',
      { expected_version: activeCandidate.version },
      actorUserId
    );
    const afterActiveMix = await requestService.getSessionRequests(session.public_id);
    const currentReorderable = afterActiveMix.requests
      .filter(({ status }) => ['needs_match', 'queued'].includes(status))
      .map(({ public_id }) => public_id);
    await expectServiceError(
      requestService.reorder(
        session.public_id,
        {
          expected_version: afterActiveMix.session.version,
          request_public_ids: [...currentReorderable, activated.public_id]
        },
        actorUserId
      ),
      'invalid_reorder_set'
    );

    const publicQueue = await requestService.getCurrentQueue(SITE_ID, ROOM_ID);
    const publicSerialized = JSON.stringify(publicQueue);
    assert.doesNotMatch(publicSerialized, /requester_open_id|requester_user_id|email/);
    assert.doesNotMatch(publicSerialized, /phase4c_synthetic_open_id_private/);
    assert.ok(publicQueue.requests.every(({ public_id }) => public_id === undefined));
    assert.ok(publicQueue.requests.every(({ display_key }) => typeof display_key === 'string'));

    const liveHomeQueue = await createLiveHomeRepository({
      pool,
      siteId: SITE_ID,
      roomId: ROOM_ID
    }).getQueue();
    const expectedWaitingCount = afterActiveMix.requests
      .filter(({ status }) => ['needs_match', 'queued'].includes(status))
      .length;
    assert.equal(liveHomeQueue.current.public_id, activated.public_id);
    assert.equal(liveHomeQueue.waitingCount, expectedWaitingCount);
    assert.equal(liveHomeQueue.waiting.length, expectedWaitingCount);
    assert.equal(liveHomeQueue.next.public_id, liveHomeQueue.waiting[0].public_id);

    const beforeAdvance = await requestService.getSessionRequests(session.public_id);
    const activeBeforeAdvance = beforeAdvance.requests.find(({ status }) => status === 'singing');
    const queuedBeforeAdvance = beforeAdvance.requests.find(({ status }) => status === 'queued');
    assert.ok(activeBeforeAdvance);
    assert.ok(queuedBeforeAdvance);
    const advanced = await requestService.advanceCurrent(
      activeBeforeAdvance.public_id,
      {
        expected_version: activeBeforeAdvance.version,
        outcome: 'completed',
        activate_next: true
      },
      actorUserId
    );
    assert.equal(advanced.previous.status, 'completed');
    assert.equal(advanced.previous.fulfillment_type, 'sung');
    assert.equal(advanced.current.public_id, queuedBeforeAdvance.public_id);
    assert.equal(advanced.current.status, 'active');

    const concurrentAdvance = await Promise.allSettled([
      requestService.advanceCurrent(
        advanced.current.public_id,
        {
          expected_version: advanced.current.version,
          outcome: 'completed',
          activate_next: false
        },
        actorUserId
      ),
      requestService.advanceCurrent(
        advanced.current.public_id,
        {
          expected_version: advanced.current.version,
          outcome: 'skipped',
          activate_next: false
        },
        actorUserId
      )
    ]);
    assert.deepEqual(
      concurrentAdvance.map(({ status }) => status).sort(),
      ['fulfilled', 'rejected']
    );
    const [activeCountRows] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM song_requests
       WHERE session_id = (
         SELECT id FROM live_sessions WHERE public_id = ?
       ) AND status = 'active'`,
      [session.public_id]
    );
    assert.equal(Number(activeCountRows[0].count), 0);

    const [requestCountBeforeClose] = await pool.query(
      'SELECT COUNT(*) AS count FROM song_requests'
    );
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value)
       VALUES ('live_home_song_requests_open', 'false')
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`
    );
    await expectServiceError(
      requestService.createWebsiteRequest({
        ...TARGET,
        query: '年轮'
      }, {
        userId: actorUserId,
        idempotencyKey: 'phase4c-closed-website'
      }),
      'requests_closed'
    );
    await expectServiceError(
      requestService.createManualRequest({
        ...TARGET,
        query: '年轮'
      }, actorUserId),
      'requests_closed'
    );
    const closedDm = await liveService.record(
      liveEvent(`${prefix}:closed-gate`, '点歌 年轮')
    );
    assert.equal(closedDm.status, 'accepted');
    assert.equal(closedDm.observation.reason, 'requests_closed');
    const [requestCountAfterClose] = await pool.query(
      'SELECT COUNT(*) AS count FROM song_requests'
    );
    assert.equal(
      Number(requestCountAfterClose[0].count),
      Number(requestCountBeforeClose[0].count)
    );
    await pool.query(
      `UPDATE settings
       SET setting_value = 'true'
       WHERE setting_key = 'live_home_song_requests_open'`
    );

    const historyCount = await requestService.getHistoryCount(stateRequest.public_id);
    assert.ok(historyCount >= 4);
    const historyPage = await requestService.getHistory({
      query: '年轮',
      source: 'website',
      page: 1,
      limit: 5
    });
    assert.ok(historyPage.requests.length > 0);
    assert.ok(historyPage.requests.length <= 5);
    assert.equal(historyPage.pagination.page, 1);
    const [reorderHistory] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM song_request_history
       WHERE action = 'reordered'`
    );
    assert.ok(Number(reorderHistory[0].count) > 0);

    const aliasRequest = await requestService.createWebsiteRequest({
      ...TARGET,
      query: '圈圈歌'
    }, {
      userId: actorUserId,
      idempotencyKey: 'phase4c-alias-request'
    });
    assert.equal(aliasRequest.request.matched_song_id, songIds['年轮']);
    await requestService.deleteAlias(alias.id);
    const aliasRequestAfterDelete = await requestService.getRequest(aliasRequest.request.public_id);
    assert.equal(aliasRequestAfterDelete.matched_song.id, songIds['年轮']);

    const rollbackEvent = liveEvent(`${prefix}:rollback`, '点歌 年轮');
    const rollbackService = createLiveEventService({
      repository: createMysqlLiveEventRepository(pool),
      acceptedEventObserver: async () => {
        throw new Error('synthetic observer failure');
      }
    });
    await assert.rejects(rollbackService.record(rollbackEvent), /synthetic observer failure/);
    const [rollbackRows] = await pool.query(
      'SELECT COUNT(*) AS count FROM live_events WHERE event_id = ?',
      [rollbackEvent.event_id]
    );
    assert.equal(Number(rollbackRows[0].count), 0);

    let closedSession = await sessionService.createDraft({
      site_id: 'phase4c-closed',
      room_id: '10005',
      playlist_id: playlistId,
      title: 'Closed Session'
    }, actorUserId);
    closedSession = await sessionService.transition(
      closedSession.public_id,
      'closed',
      closedSession.version
    );
    const closedTargetEvent = liveEvent(`${prefix}:closed`, '点歌 年轮', {
      siteId: closedSession.site_id,
      roomId: closedSession.room_id
    });
    const closedResult = await liveService.record(closedTargetEvent);
    assert.equal(closedResult.observation.status, 'ignored');
    assert.equal(closedResult.observation.reason, 'requests_closed');

    const [orders] = await pool.query(
      `SELECT queue_order
       FROM song_requests
       WHERE session_id = (
         SELECT id FROM live_sessions WHERE public_id = ?
       ) AND queue_order IS NOT NULL`,
      [session.public_id]
    );
    assert.equal(
      new Set(orders.map(({ queue_order }) => String(queue_order))).size,
      orders.length
    );

    const [titlesAfter] = await pool.query(
      'SELECT id, title, artist FROM songs ORDER BY id'
    );
    assert.deepEqual(titlesAfter, titlesBefore);
    assert.equal(await tableCount(pool, 'song_aliases'), 1);

    for (const table of legacyTables) {
      assert.equal(await tableCount(pool, table), legacyBefore.get(table), table);
    }
  } finally {
    await pool.end();
  }
});
