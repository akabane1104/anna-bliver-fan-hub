const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const CONFIRMATION = 'phase4g-isolated-song-ui';
const integrationEnabled = process.env.PHASE4G_E2E_CONFIRM === CONFIRMATION;
const repositoryRoot = path.resolve(__dirname, '../..');
const composeFile = path.resolve(
  repositoryRoot,
  'tools/live-event-simulator/test/fixtures/docker-compose.yml'
);
const backendHelper = path.resolve(
  repositoryRoot,
  'tools/live-event-simulator/test/helpers/isolatedBackend.js'
);
const schemaPath = path.resolve(repositoryRoot, 'backend/src/config/schema.sql');
const simulatorCli = path.resolve(
  repositoryRoot,
  'tools/live-event-simulator/src/cli.js'
);
const SITE_ID = 'phase4d-phase4g-synthetic';
const ROOM_ID = '99000000000000000009';

function dockerEnvironment(rootPassword, databasePassword) {
  return {
    ...process.env,
    PHASE4D_DB_ROOT_PASSWORD: rootPassword,
    PHASE4D_DB_PASSWORD: databasePassword
  };
}

function runDocker(args, context, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    env: context.env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const error = new Error('isolated_docker_command_failed');
    error.code = result.error?.code || `docker_exit_${result.status}`;
    throw error;
  }
  return result;
}

function waitForBackend(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('isolated_backend_timeout')), 15000);
    child.once('message', (message) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timeout);
      resolve(message.port);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`isolated_backend_exit_${code}`));
    });
  });
}

async function closeBackend(child) {
  if (!child || child.exitCode !== null) return;
  child.send({ type: 'shutdown' });
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null) child.kill('SIGTERM');
}

async function request(baseUrl, route, {
  method = 'GET',
  token,
  headers = {},
  body
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  const text = await response.text();
  if (text) data = JSON.parse(text);
  return { status: response.status, data };
}

async function login(baseUrl, email, password) {
  const result = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  assert.equal(result.status, 200);
  assert.equal(typeof result.data.token, 'string');
  return result.data.token;
}

function runSimulator(baseUrl, secret, scenario) {
  const result = spawnSync(process.execPath, [
    simulatorCli,
    'run',
    '--base-url',
    baseUrl,
    '--scenario',
    scenario,
    '--site-id',
    SITE_ID,
    '--room-id',
    ROOM_ID,
    '--run-id',
    `p4g-${scenario}-${crypto.randomBytes(4).toString('hex')}`,
    '--json'
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LIVE_EVENT_INGEST_SECRET: secret
    },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout.trim() || 'simulator_failed');
  return JSON.parse(result.stdout.trim());
}

async function tableCount(pool, table) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
  return Number(row.count);
}

function assertSafeLiveAdminPayload(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /actor_open_id|actor_union_id|source_event_id|provider_event_id|normalized_payload|content_hash|requester_user_id|requester_open_id|email|password|cookie|token|signature/i
  );
}

test('Phase 4G isolated HTTP flow preserves one unified queue and safe DTOs', {
  skip: !integrationEnabled,
  timeout: 120000
}, async () => {
  const projectName = `phase4g-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const rootPassword = crypto.randomBytes(24).toString('base64url');
  const databasePassword = crypto.randomBytes(24).toString('base64url');
  const jwtSecret = crypto.randomBytes(40).toString('base64url');
  const liveSecret = crypto.randomBytes(40).toString('base64url');
  const viewerPassword = crypto.randomBytes(18).toString('base64url');
  const adminPassword = crypto.randomBytes(18).toString('base64url');
  const composeArgs = ['compose', '-p', projectName, '-f', composeFile];
  const dockerContext = {
    env: dockerEnvironment(rootPassword, databasePassword)
  };
  let pool;
  let backend;

  try {
    console.log('[phase4g-e2e] starting exact isolated MySQL project');
    runDocker([
      ...composeArgs,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'mysql'
    ], dockerContext);
    const portOutput = runDocker([
      ...composeArgs,
      'port',
      'mysql',
      '3306'
    ], dockerContext).stdout.trim();
    const port = Number(portOutput.match(/:(\d+)$/)?.[1]);
    assert.ok(Number.isInteger(port) && port > 0 && port !== 3306);

    pool = mysql.createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: rootPassword,
      database: 'anna_bliver_fan_hub',
      multipleStatements: true,
      connectionLimit: 12,
      supportBigNumbers: true,
      bigNumberStrings: true
    });
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));

    const viewerHash = await bcrypt.hash(viewerPassword, 6);
    const adminHash = await bcrypt.hash(adminPassword, 6);
    const [viewerResult] = await pool.query(
      `INSERT INTO users (username, email, password, role)
       VALUES (?, ?, ?, 'user')`,
      ['phase4g-viewer', 'phase4g-viewer@example.com', viewerHash]
    );
    const [adminResult] = await pool.query(
      `INSERT INTO users (username, email, password, role)
       VALUES (?, ?, ?, 'admin')`,
      ['phase4g-admin', 'phase4g-admin@example.com', adminHash]
    );
    const [playlistResult] = await pool.query(
      `INSERT INTO playlists (title, description, created_by)
       VALUES (?, ?, ?)`,
      ['Phase 4G Synthetic Playlist', 'Isolated test fixture', adminResult.insertId]
    );
    const playlistId = playlistResult.insertId;
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value)
       VALUES ('site_playlist_id', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [String(playlistId)]
    );
    const songIds = {};
    for (const [title, artist] of [
      ['年轮', 'Synthetic Artist'],
      ['後來', 'Synthetic Artist'],
      ['fancy', 'Synthetic Artist'],
      ['FANCY', 'Synthetic Artist']
    ]) {
      const [result] = await pool.query(
        'INSERT INTO songs (playlist_id, title, artist) VALUES (?, ?, ?)',
        [playlistId, title, artist]
      );
      songIds[title] = result.insertId;
    }
    const [tagResult] = await pool.query(
      `INSERT INTO tags (name, color) VALUES ('流行', '#C04D00')`
    );
    await pool.query(
      'INSERT INTO song_tags (song_id, tag_id) VALUES (?, ?)',
      [songIds['年轮'], tagResult.insertId]
    );
    await pool.query(
      `INSERT INTO song_aliases (
         song_id, alias, normalized_alias, script_key,
         loose_candidate_key, created_by_user_id
       ) VALUES (?, '圈圈歌', '圈圈歌', '圈圈歌', '圈圈歌', ?)`,
      [songIds['年轮'], adminResult.insertId]
    );

    const pointsBefore = {
      wallets: await tableCount(pool, 'point_wallets'),
      accounts: await tableCount(pool, 'point_accounts'),
      transactions: await tableCount(pool, 'point_account_transactions')
    };

    backend = fork(backendHelper, [], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(port),
        DB_USER: 'root',
        DB_PASSWORD: rootPassword,
        DB_NAME: 'anna_bliver_fan_hub',
        JWT_SECRET: jwtSecret,
        JWT_EXPIRES_IN: '1h',
        CORS_ORIGIN: 'http://127.0.0.1',
        ALIYUN_CAPTCHA_SCENE_ID: '',
        LIVE_EVENT_INGEST_ENABLED: 'true',
        LIVE_EVENT_INGEST_SECRET: liveSecret,
        LIVE_EVENT_MAX_SKEW_SECONDS: '300',
        LIVE_EVENT_ALLOWED_TARGETS: `${SITE_ID}:${ROOM_ID}`,
        BOT_WS_URL: '',
        BOT_WS_TOKEN: '',
        BILIBILI_COOKIE: ''
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });
    const backendPort = await waitForBackend(backend);
    const baseUrl = `http://127.0.0.1:${backendPort}`;

    const viewerToken = await login(baseUrl, 'phase4g-viewer@example.com', viewerPassword);
    const adminToken = await login(baseUrl, 'phase4g-admin@example.com', adminPassword);

    const anonymousStatus = await request(baseUrl, '/api/live-control/status');
    assert.equal(anonymousStatus.status, 401);
    const ordinaryViewerStatus = await request(
      baseUrl,
      '/api/live-control/status',
      { token: viewerToken }
    );
    assert.equal(ordinaryViewerStatus.status, 403);
    await pool.query(
      `INSERT INTO permissions (user_id, permission_key)
       VALUES (?, 'live_control.manage')`,
      [viewerResult.insertId]
    );
    const permittedViewerStatus = await request(
      baseUrl,
      '/api/live-control/status',
      { token: viewerToken }
    );
    assert.equal(permittedViewerStatus.status, 200);

    const createSession = await request(baseUrl, '/api/live-control/sessions', {
      method: 'POST',
      token: adminToken,
      body: {
        site_id: SITE_ID,
        room_id: ROOM_ID,
        playlist_id: playlistId,
        title: 'Phase 4G Synthetic Session'
      }
    });
    assert.equal(createSession.status, 201);
    const session = createSession.data.session;
    const openSession = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/open`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: session.version }
      }
    );
    assert.equal(openSession.status, 200);

    const catalog = await request(
      baseUrl,
      '/api/song-requests/catalog?query=%E5%B9%B4%E8%BC%AA&tag=%E6%B5%81%E8%A1%8C&page=1&limit=20'
    );
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.data.songs.map(({ title }) => title), ['年轮']);

    const websiteRequest = await request(baseUrl, '/api/song-requests', {
      method: 'POST',
      token: viewerToken,
      headers: { 'Idempotency-Key': 'phase4g-viewer-request-1' },
      body: { song_id: songIds['年轮'] }
    });
    assert.equal(websiteRequest.status, 201);
    assert.equal(websiteRequest.data.status, 'accepted');
    assert.equal(websiteRequest.data.request.requested_title, '年轮');
    assert.doesNotMatch(
      JSON.stringify(websiteRequest.data),
      /requester_user_id|requester_open_id|site_id|room_id|source_event_id/
    );
    const duplicateWebsite = await request(baseUrl, '/api/song-requests', {
      method: 'POST',
      token: viewerToken,
      headers: { 'Idempotency-Key': 'phase4g-viewer-request-1' },
      body: { song_id: songIds['年轮'] }
    });
    assert.equal(duplicateWebsite.status, 200);
    assert.equal(duplicateWebsite.data.status, 'duplicate');

    for (const songId of [songIds['後來'], songIds.fancy, songIds.FANCY]) {
      const manual = await request(baseUrl, '/api/live-control/requests', {
        method: 'POST',
        token: adminToken,
        body: {
          site_id: SITE_ID,
          room_id: ROOM_ID,
          session_public_id: session.public_id,
          song_id: songId,
          requester_display_name: 'Synthetic Streamer'
        }
      });
      assert.equal(manual.status, 201);
      assert.equal(manual.data.request.source, 'manual');
    }

    let management = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/requests`,
      { token: adminToken }
    );
    assert.equal(management.status, 200);
    const reorderable = management.data.requests
      .filter(({ status }) => ['needs_match', 'queued'].includes(status));
    const reversed = [...reorderable].reverse().map(({ public_id }) => public_id);
    const reordered = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/reorder`,
      {
        method: 'PUT',
        token: adminToken,
        body: {
          expected_version: management.data.session.version,
          request_public_ids: reversed
        }
      }
    );
    assert.equal(reordered.status, 200);
    const staleReorder = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/reorder`,
      {
        method: 'PUT',
        token: adminToken,
        body: {
          expected_version: management.data.session.version,
          request_public_ids: reversed
        }
      }
    );
    assert.equal(staleReorder.status, 409);

    management = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/requests`,
      { token: adminToken }
    );
    const activationCandidates = management.data.requests
      .filter(({ status }) => status === 'queued')
      .slice(0, 2);
    const activationResults = await Promise.all(activationCandidates.map((entry) => request(
      baseUrl,
      `/api/live-control/requests/${entry.public_id}/activate`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: entry.version }
      }
    )));
    assert.deepEqual(activationResults.map(({ status }) => status).sort(), [200, 409]);
    let activeRequest = activationResults.find(({ status }) => status === 200).data.request;
    const fulfillment = await request(
      baseUrl,
      `/api/live-control/requests/${activeRequest.public_id}/fulfillment`,
      {
        method: 'POST',
        token: adminToken,
        body: {
          expected_version: activeRequest.version,
          fulfillment_type: 'sung'
        }
      }
    );
    assert.equal(fulfillment.status, 200);
    activeRequest = fulfillment.data.request;
    const completed = await request(
      baseUrl,
      `/api/live-control/requests/${activeRequest.public_id}/complete`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: activeRequest.version }
      }
    );
    assert.equal(completed.status, 200);

    management = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/requests`,
      { token: adminToken }
    );
    const skipCandidate = management.data.requests.find(({ status }) => status === 'queued');
    const activatedForSkip = await request(
      baseUrl,
      `/api/live-control/requests/${skipCandidate.public_id}/activate`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: skipCandidate.version }
      }
    );
    assert.equal(activatedForSkip.status, 200);
    const skipped = await request(
      baseUrl,
      `/api/live-control/requests/${skipCandidate.public_id}/skip`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: activatedForSkip.data.request.version }
      }
    );
    assert.equal(skipped.status, 200);

    management = await request(
      baseUrl,
      `/api/live-control/sessions/${session.public_id}/requests`,
      { token: adminToken }
    );
    const cancelCandidate = management.data.requests.find(({ status }) => status === 'queued');
    const cancelled = await request(
      baseUrl,
      `/api/live-control/requests/${cancelCandidate.public_id}/cancel`,
      {
        method: 'POST',
        token: adminToken,
        body: { expected_version: cancelCandidate.version }
      }
    );
    assert.equal(cancelled.status, 200);

    const simulatedRequest = runSimulator(baseUrl, liveSecret, 'simplified-request');
    assert.equal(simulatedRequest.accepted, 1);
    assert.equal(simulatedRequest.expected_song_requests, 1);
    const simulatedGift = runSimulator(baseUrl, liveSecret, 'gift-event');
    assert.equal(simulatedGift.accepted, 1);
    assert.equal(simulatedGift.expected_song_requests, 0);
    const simulatedDuplicate = runSimulator(baseUrl, liveSecret, 'duplicate');
    assert.equal(simulatedDuplicate.accepted, 1);
    assert.equal(simulatedDuplicate.duplicate, 1);
    assert.equal(simulatedDuplicate.expected_song_requests, 1);
    const simulatedConflict = runSimulator(baseUrl, liveSecret, 'conflict');
    assert.equal(simulatedConflict.accepted, 1);
    assert.equal(simulatedConflict.conflict, 1);
    assert.equal(simulatedConflict.expected_song_requests, 1);

    const liveStatus = await request(baseUrl, '/api/live-control/status', {
      token: adminToken
    });
    assert.equal(liveStatus.status, 200);
    assert.equal(liveStatus.data.backend.status, 'available');
    assert.equal(liveStatus.data.database.status, 'available');
    assert.equal(liveStatus.data.sessions.state, 'active');
    assert.equal(liveStatus.data.sessions.active_count, 1);
    assert.equal(liveStatus.data.listener.availability, 'unavailable');
    assert.equal(liveStatus.data.listener.reason_code, 'listener_status_not_reported');
    assert.equal(liveStatus.data.bilibili_connection.api_state, 'unknown');
    assert.equal(liveStatus.data.bilibili_connection.wss_state, 'unknown');
    assert.equal(liveStatus.data.bilibili_connection.authoritative, false);
    assert.equal(liveStatus.data.ingestion.total_saved, 4);
    assertSafeLiveAdminPayload(liveStatus.data);

    const eventList = await request(
      baseUrl,
      '/api/live-control/events?source=simulation&page=1&limit=100',
      { token: adminToken }
    );
    assert.equal(eventList.status, 200);
    assert.equal(eventList.data.pagination.total, 4);
    assert.equal(eventList.data.events.length, 4);
    assert.deepEqual(eventList.data.sort, [
      'received_at:desc',
      'internal_stable_key:desc'
    ]);
    assertSafeLiveAdminPayload(eventList.data);
    assert.ok(eventList.data.events.every(({ event_ref: eventRef }) => (
      /^[a-f0-9]{20}$/.test(eventRef)
    )));

    const giftEvents = await request(
      baseUrl,
      '/api/live-control/events?event_type=gift&page=1&limit=20',
      { token: adminToken }
    );
    assert.equal(giftEvents.status, 200);
    assert.equal(giftEvents.data.pagination.total, 1);
    assert.equal(giftEvents.data.events[0].event_type, 'gift');

    const sessionEvents = await request(
      baseUrl,
      `/api/live-control/events?session=${encodeURIComponent(session.public_id)}&page=1&limit=100`,
      { token: adminToken }
    );
    assert.equal(sessionEvents.status, 200);
    assert.equal(sessionEvents.data.pagination.total, 4);
    assert.ok(sessionEvents.data.events.every(({ session: eventSession }) => (
      eventSession?.public_id === session.public_id
    )));

    const rangeStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rangeEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rangedEvents = await request(
      baseUrl,
      `/api/live-control/events?start=${encodeURIComponent(rangeStart)}&end=${encodeURIComponent(rangeEnd)}&page=1&limit=100`,
      { token: adminToken }
    );
    assert.equal(rangedEvents.status, 200);
    assert.equal(rangedEvents.data.pagination.total, 4);

    const firstEventPage = await request(
      baseUrl,
      '/api/live-control/events?page=1&limit=1',
      { token: adminToken }
    );
    const secondEventPage = await request(
      baseUrl,
      '/api/live-control/events?page=2&limit=1',
      { token: adminToken }
    );
    assert.equal(firstEventPage.status, 200);
    assert.equal(secondEventPage.status, 200);
    assert.notEqual(
      firstEventPage.data.events[0].event_ref,
      secondEventPage.data.events[0].event_ref
    );

    const publicQueue = await request(baseUrl, '/api/song-requests/current');
    assert.equal(publicQueue.status, 200);
    assert.doesNotMatch(
      JSON.stringify(publicQueue.data),
      /requester_open_id|requester_user_id|source_event_id|event_id|email/
    );
    assert.ok(publicQueue.data.requests.length > 0);

    const history = await request(
      baseUrl,
      '/api/live-control/history?query=Synthetic&source=manual&page=1&limit=2',
      { token: adminToken }
    );
    assert.equal(history.status, 200);
    assert.ok(history.data.requests.length <= 2);
    assert.equal(history.data.pagination.limit, 2);

    const [[websiteCount]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM song_requests
       WHERE requester_user_id = ? AND idempotency_key = ?`,
      [viewerResult.insertId, 'phase4g-viewer-request-1']
    );
    assert.equal(Number(websiteCount.count), 1);
    const [[activeCount]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM song_requests
       WHERE session_id = (SELECT id FROM live_sessions WHERE public_id = ?)
         AND status = 'active'`,
      [session.public_id]
    );
    assert.ok(Number(activeCount.count) <= 1);
    const [[bilibiliCount]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM song_requests
       WHERE source = 'simulation'`
    );
    assert.equal(Number(bilibiliCount.count), 3);
    assert.equal(await tableCount(pool, 'live_events'), 4);
    assert.deepEqual({
      wallets: await tableCount(pool, 'point_wallets'),
      accounts: await tableCount(pool, 'point_accounts'),
      transactions: await tableCount(pool, 'point_account_transactions')
    }, pointsBefore);
    assert.ok(await tableCount(pool, 'song_request_history') >= 10);
  } finally {
    await closeBackend(backend);
    if (pool) await pool.end();
    console.log('[phase4g-e2e] removing the exact isolated project and volume');
    runDocker([
      ...composeArgs,
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '10'
    ], dockerContext, { allowFailure: true });
    for (const [kind, args] of [
      ['containers', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}']],
      ['volumes', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}']],
      ['networks', ['network', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}']]
    ]) {
      assert.equal(runDocker(args, dockerContext).stdout.trim(), '', kind);
    }
  }
});
