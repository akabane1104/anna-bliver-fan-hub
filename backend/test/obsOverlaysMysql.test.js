const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mysql = require('mysql2/promise');
const {
  createObsOverlayController
} = require('../src/controllers/obsOverlayController');
const {
  createLiveControlController
} = require('../src/controllers/liveControlController');
const {
  createObsOverlayEventRepository,
  createObsOverlayEventService
} = require('../src/services/obsOverlayEventService');
const {
  createObsOverlayRealtime
} = require('../src/services/obsOverlayRealtime');
const {
  createObsOverlayService,
  createObsOverlayStateRepository
} = require('../src/services/obsOverlayService');
const {
  createSongRequestService
} = require('../src/services/songRequestService');

const CONFIRMATION = 'phase4j-isolated-obs-overlays';
const integrationEnabled = process.env.PHASE4J_TEST_DB_CONFIRM === CONFIRMATION;

function integrationConfig() {
  const host = process.env.PHASE4J_TEST_DB_HOST;
  const port = Number(process.env.PHASE4J_TEST_DB_PORT);
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port <= 0 || port === 3306) {
    throw new Error('isolated_database_target_required');
  }
  return {
    host,
    port,
    user: process.env.PHASE4J_TEST_DB_USER || 'root',
    password: process.env.PHASE4J_TEST_DB_PASSWORD || '',
    database: 'anna_bliver_fan_hub',
    connectionLimit: 4,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true
  };
}

async function seedSongState(pool) {
  await pool.query(`
    INSERT INTO users (username, email, password, role)
    VALUES ('phase4j-admin', 'phase4j-admin@example.test', 'synthetic', 'admin');
    SET @actor_id = LAST_INSERT_ID();
    INSERT INTO playlists (title, description, created_by)
    VALUES ('Phase 4J Playlist', 'Synthetic integration data', @actor_id);
    SET @playlist_id = LAST_INSERT_ID();
    INSERT INTO songs (playlist_id, title, artist, song_order)
    VALUES
      (@playlist_id, 'Current Integration Song', 'Synthetic Artist', 1),
      (@playlist_id, 'Next Integration Song', 'Synthetic Artist', 2);
    SET @current_song_id = LAST_INSERT_ID();
    SET @next_song_id = LAST_INSERT_ID() + 1;
    INSERT INTO live_sessions (
      public_id, site_id, room_id, playlist_id, title, status,
      created_by_user_id, started_at
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      'phase4j-test', '90071992547409930001', @playlist_id,
      'Phase 4J Session', 'open', @actor_id, UTC_TIMESTAMP(3)
    );
    SET @session_id = LAST_INSERT_ID();
    INSERT INTO song_requests (
      public_id, session_id, site_id, room_id, source, requester_user_id,
      requester_display_name, raw_request_text, requested_title,
      normalized_query, matched_song_id, match_method, match_confidence,
      status, fulfillment_type, queue_order, requested_at
    ) VALUES
      (
        '20000000-0000-4000-8000-000000000001',
        @session_id, 'phase4j-test', '90071992547409930001', 'manual', @actor_id,
        'Synthetic Current Requester', 'Synthetic Current Request',
        'Current Integration Song', 'current integration song', @current_song_id,
        'manual', 1.0000, 'active', 'undecided', NULL,
        DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)
      ),
      (
        '20000000-0000-4000-8000-000000000002',
        @session_id, 'phase4j-test', '90071992547409930001', 'manual', @actor_id,
        'Synthetic Next Requester', 'Synthetic Next Request',
        'Next Integration Song', 'next integration song', @next_song_id,
        'manual', 1.0000, 'queued', 'undecided', 10,
        DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE)
      );
    INSERT INTO song_request_details (request_id, canonical_match_method)
    SELECT id, 'manual'
    FROM song_requests;
  `);
}

async function readSseSnapshot(reader, decoder, carry) {
  let buffer = carry.value;
  while (true) {
    const boundary = buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      carry.value = buffer;
      const event = frame.match(/^event: ([^\n]+)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (event === 'snapshot' && data) return JSON.parse(data);
      continue;
    }
    const { done, value } = await reader.read();
    if (done) throw new Error('sse_stream_closed_before_snapshot');
    buffer += decoder.decode(value, { stream: true });
  }
}

test('isolated MySQL and HTTP exercise OBS snapshot, event SSE, and complete-and-advance', {
  skip: !integrationEnabled,
  timeout: 60000
}, async () => {
  const pool = mysql.createPool(integrationConfig());
  const realtime = createObsOverlayRealtime();
  const eventService = createObsOverlayEventService({
    realtime,
    repository: createObsOverlayEventRepository({ pool })
  });
  const overlayService = createObsOverlayService({
    realtime,
    stateRepository: createObsOverlayStateRepository({ pool }),
    eventService,
    liveHomeService: {
      async getAdminHome() {
        return { control: { activity: null } };
      }
    }
  });
  const requestService = createSongRequestService({ pool });
  const overlayController = createObsOverlayController({
    overlayService,
    eventService,
    realtime,
    heartbeatMs: 1000
  });
  const liveControlController = createLiveControlController({
    requestService,
    realtime
  });
  const app = express();
  app.use(express.json());
  app.get('/api/public/obs-overlay/state', overlayController.snapshot);
  app.get('/api/public/obs-overlay/stream', overlayController.stream);
  app.post('/api/live-control/obs-overlay/events', (req, res) => {
    req.userId = 1;
    return overlayController.createEvent(req, res);
  });
  app.post('/api/live-control/requests/:publicId/advance', (req, res) => {
    req.userId = 1;
    return liveControlController.advanceCurrent(req, res);
  });

  let server;
  let reader;
  const abort = new AbortController();
  try {
    await seedSongState(pool);
    const [[beforePoints]] = await pool.query(
      'SELECT COUNT(*) AS count FROM point_account_transactions'
    );
    const [[beforeLiveEvents]] = await pool.query(
      'SELECT COUNT(*) AS count FROM live_events'
    );
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initialResponse = await fetch(`${baseUrl}/api/public/obs-overlay/state`);
    assert.equal(initialResponse.status, 200);
    assert.match(initialResponse.headers.get('cache-control'), /no-store/);
    const initial = await initialResponse.json();
    assert.equal(initial.currentSong.title, 'Current Integration Song');
    assert.equal(initial.nextSong.title, 'Next Integration Song');
    assert.equal(initial.queue.length, 1);
    assert.equal(initial.todayRequestCount, 2);
    assert.equal(initial.currentSong.requester, 'S***r');
    assert.doesNotMatch(JSON.stringify(initial), /requester_user_id|raw_request_text|email/i);

    const streamResponse = await fetch(
      `${baseUrl}/api/public/obs-overlay/stream`,
      { signal: abort.signal }
    );
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type'), /^text\/event-stream/);
    reader = streamResponse.body.getReader();
    const carry = { value: '' };
    const decoder = new TextDecoder();
    const firstSnapshot = await readSseSnapshot(reader, decoder, carry);
    assert.equal(firstSnapshot.currentSong.title, 'Current Integration Song');

    const eventInput = {
      eventType: 'notice',
      source: 'simulator',
      payload: { text: 'Phase 4J integration notice', style: 'info' },
      displayDurationMs: 5000,
      idempotencyKey: 'phase4j-integration-notice-0001'
    };
    const createdResponse = await fetch(
      `${baseUrl}/api/live-control/obs-overlay/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventInput)
      }
    );
    assert.equal(createdResponse.status, 201);
    const eventSnapshot = await readSseSnapshot(reader, decoder, carry);
    assert.equal(eventSnapshot.events.length, 1);
    assert.equal(eventSnapshot.events[0].payload.text, eventInput.payload.text);

    const duplicateResponse = await fetch(
      `${baseUrl}/api/live-control/obs-overlay/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventInput)
      }
    );
    assert.equal(duplicateResponse.status, 200);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.status, 'duplicate');

    const advanceResponse = await fetch(
      `${baseUrl}/api/live-control/requests/20000000-0000-4000-8000-000000000001/advance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expected_version: 0,
          outcome: 'completed',
          activate_next: true
        })
      }
    );
    assert.equal(advanceResponse.status, 200);
    const advancedSnapshot = await readSseSnapshot(reader, decoder, carry);
    assert.equal(advancedSnapshot.currentSong.title, 'Next Integration Song');
    assert.equal(advancedSnapshot.nextSong, null);
    assert.deepEqual(advancedSnapshot.queue, []);
    assert.equal(advancedSnapshot.todayRequestCount, 2);

    const [[eventCount]] = await pool.query(
      'SELECT COUNT(*) AS count FROM obs_overlay_events'
    );
    const [[afterPoints]] = await pool.query(
      'SELECT COUNT(*) AS count FROM point_account_transactions'
    );
    const [[afterLiveEvents]] = await pool.query(
      'SELECT COUNT(*) AS count FROM live_events'
    );
    assert.equal(Number(eventCount.count), 1);
    assert.equal(Number(afterPoints.count), Number(beforePoints.count));
    assert.equal(Number(afterLiveEvents.count), Number(beforeLiveEvents.count));
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
  }
});
