const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '../../..');
const simulatorRoot = path.resolve(__dirname, '..');
const composeFile = path.resolve(__dirname, 'fixtures/docker-compose.yml');
const backendHelper = path.resolve(__dirname, 'helpers/isolatedBackend.js');
const cliPath = path.resolve(simulatorRoot, 'src/cli.js');
const schemaPath = path.resolve(repositoryRoot, 'backend/src/config/schema.sql');
const { createCleanupCoordinator } = require('./helpers/cleanupCoordinator');

function randomSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function safeBaseEnvironment() {
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PROGRAMDATA: process.env.PROGRAMDATA,
    ProgramFiles: process.env.ProgramFiles,
    'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    ProgramW6432: process.env.ProgramW6432,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH
  };
  if (process.env.DOCKER_HOST) {
    environment.DOCKER_HOST = process.env.DOCKER_HOST;
  } else if (process.platform === 'win32') {
    environment.DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine';
  }
  return environment;
}

function dockerEnvironment(databaseRootPassword, databasePassword) {
  return {
    ...safeBaseEnvironment(),
    COMPOSE_DISABLE_ENV_FILE: '1',
    PHASE4D_DB_ROOT_PASSWORD: databaseRootPassword,
    PHASE4D_DB_PASSWORD: databasePassword
  };
}

function runDocker(args, {
  cwd,
  env,
  input,
  timeout = 45000,
  allowFailure = false
}) {
  const result = spawnSync('docker', args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const error = new Error('Isolated Docker command failed');
    error.code = result.error?.code || `docker_exit_${result.status}`;
    throw error;
  }
  return result;
}

function mysqlInput(composeArgs, context, sql) {
  return runDocker([
    ...composeArgs,
    'exec',
    '-T',
    'mysql',
    'sh',
    '-lc',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 -N -B -uroot'
  ], {
    ...context,
    input: sql
  });
}

function waitForBackend(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Isolated backend startup timed out');
      error.code = 'backend_start_timeout';
      reject(error);
    }, timeoutMs);
    const onExit = (code) => {
      clearTimeout(timer);
      const error = new Error('Isolated backend exited before readiness');
      error.code = `backend_exit_${code}`;
      reject(error);
    };
    child.once('exit', onExit);
    child.on('message', (message) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(message.port);
    });
  });
}

function stopBackend(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer;
    const finish = () => {
      clearTimeout(gracefulTimer);
      clearTimeout(forceTimer);
      resolve();
    };
    const gracefulTimer = setTimeout(() => {
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, 1000);
    }, timeoutMs);
    child.once('exit', finish);
    try {
      child.send({ type: 'shutdown' });
    } catch {
      child.kill('SIGTERM');
    }
  });
}

function runCli({ args, cwd, secret, timeout = 30000 }) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...safeBaseEnvironment(),
      LIVE_EVENT_INGEST_SECRET: secret
    },
    maxBuffer: 1024 * 1024,
    timeout
  });
  if (result.error || result.status !== 0) {
    const error = new Error('Simulator CLI failed');
    error.code = result.error?.code || `simulator_exit_${result.status}`;
    throw error;
  }
  return JSON.parse(result.stdout);
}

function fixtureSql() {
  return `
USE anna_bliver_fan_hub;
INSERT INTO users (username, email, password, role)
VALUES ('phase4d_admin', 'phase4d-admin@example.com', 'synthetic-not-a-real-password-hash', 'admin');
SET @phase4d_admin_id = LAST_INSERT_ID();
INSERT INTO users (username, email, password, role) VALUES
  ('phase4d_viewer_simple', 'phase4d-viewer-simple@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_traditional', 'phase4d-viewer-traditional@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_unmatched', 'phase4d-viewer-unmatched@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_lowercase', 'phase4d-viewer-lowercase@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_uppercase', 'phase4d-viewer-uppercase@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_mixedcase', 'phase4d-viewer-mixedcase@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_duplicate', 'phase4d-viewer-duplicate@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_conflict', 'phase4d-viewer-conflict@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_one', 'phase4d-viewer-one@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_two', 'phase4d-viewer-two@example.com', 'synthetic-not-a-real-password-hash', 'user'),
  ('phase4d_viewer_rollback', 'phase4d-viewer-rollback@example.com', 'synthetic-not-a-real-password-hash', 'user');
INSERT INTO user_bilibili_bindings (
  user_id, bilibili_uid, bilibili_open_id, bilibili_uname, status
)
SELECT id, 9200000000001, 'phase4d.synthetic.e2e-run.viewer-simple', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_simple'
UNION ALL
SELECT id, 9200000000002, 'phase4d.synthetic.e2e-run.viewer-traditional', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_traditional'
UNION ALL
SELECT id, 9200000000003, 'phase4d.synthetic.e2e-run.viewer-unmatched', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_unmatched'
UNION ALL
SELECT id, 9200000000004, 'phase4d.synthetic.e2e-run.viewer-lowercase', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_lowercase'
UNION ALL
SELECT id, 9200000000005, 'phase4d.synthetic.e2e-run.viewer-uppercase', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_uppercase'
UNION ALL
SELECT id, 9200000000006, 'phase4d.synthetic.e2e-run.viewer-mixedcase', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_mixedcase'
UNION ALL
SELECT id, 9200000000007, 'phase4d.synthetic.e2e-run.viewer-duplicate', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_duplicate'
UNION ALL
SELECT id, 9200000000008, 'phase4d.synthetic.e2e-run.viewer-conflict', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_conflict'
UNION ALL
SELECT id, 9200000000009, 'phase4d.synthetic.e2e-run.viewer-one', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_one'
UNION ALL
SELECT id, 9200000000010, 'phase4d.synthetic.e2e-run.viewer-two', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_two'
UNION ALL
SELECT id, 9200000000011, 'phase4d.synthetic.rollback-run.viewer-rollback', username, 'verified'
FROM users WHERE username = 'phase4d_viewer_rollback';
INSERT INTO playlists (title, description, created_by)
VALUES ('Phase 4D Synthetic Playlist', 'Synthetic fixture only', @phase4d_admin_id);
SET @phase4d_playlist_id = LAST_INSERT_ID();
INSERT INTO songs (playlist_id, title, artist, song_order) VALUES
  (@phase4d_playlist_id, '年轮', 'Synthetic Artist', 1),
  (@phase4d_playlist_id, 'fancy', 'Synthetic Artist', 2),
  (@phase4d_playlist_id, 'FANCY', 'Synthetic Artist', 3),
  (@phase4d_playlist_id, 'Simulator Duplicate', 'Synthetic Artist', 4),
  (@phase4d_playlist_id, 'Simulator Conflict', 'Synthetic Artist', 5),
  (@phase4d_playlist_id, 'Simulator Shared', 'Synthetic Artist', 6);
INSERT INTO live_sessions (
  public_id, site_id, room_id, playlist_id, title, status,
  created_by_user_id, started_at
) VALUES (
  '44444444-4444-4444-8444-444444444444',
  'phase4d-synthetic',
  '99000000000000000001',
  @phase4d_playlist_id,
  'Phase 4D Synthetic Session',
  'open',
  @phase4d_admin_id,
  UTC_TIMESTAMP(3)
);
`;
}

function assertionSql() {
  return `
USE anna_bliver_fan_hub;
SELECT JSON_OBJECT(
  'live_events', (SELECT COUNT(*) FROM live_events),
  'song_requests', (SELECT COUNT(*) FROM song_requests),
  'history', (SELECT COUNT(*) FROM song_request_history),
  'users', (SELECT COUNT(*) FROM users),
  'permissions', (SELECT COUNT(*) FROM permissions),
  'wallets', (SELECT COUNT(*) FROM point_wallets),
  'accounts', (SELECT COUNT(*) FROM point_accounts),
  'transactions', (SELECT COUNT(*) FROM point_account_transactions),
  'simple_event_id_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.simplified-request.1'
  ),
  'simple_raw_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.simplified-request.1'
      AND raw_request_text = '点歌 年轮'
  ),
  'simple_title_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.simplified-request.1'
      AND requested_title = '年轮'
  ),
  'simple_method_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.simplified-request.1'
      AND match_method = 'exact'
  ),
  'simple_song_ok', (
    SELECT COUNT(*) = 1
    FROM song_requests sr JOIN songs s ON s.id = sr.matched_song_id
    WHERE sr.source_event_id = 'phase4d.e2e-run.simplified-request.1'
      AND s.title = '年轮'
  ),
  'simple_ok', (
    SELECT COUNT(*) = 1
    FROM song_requests sr JOIN songs s ON s.id = sr.matched_song_id
    WHERE sr.source_event_id = 'phase4d.e2e-run.simplified-request.1'
      AND sr.raw_request_text = '点歌 年轮'
      AND sr.requested_title = '年轮'
      AND sr.match_method = 'exact'
      AND s.title = '年轮'
  ),
  'traditional_duplicate_blocked', (
    SELECT COUNT(*) = 0
    FROM song_requests sr
    WHERE sr.source_event_id = 'phase4d.e2e-run.traditional-request.1'
  ),
  'ordinary_absent', (
    SELECT COUNT(*) = 0 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.ordinary-chat.1'
  ),
  'playback_absent', (
    SELECT COUNT(*) = 0 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.playback-command-rejected.1'
  ),
  'missing_space_absent', (
    SELECT COUNT(*) = 0 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.missing-space.1'
  ),
  'unmatched_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.unmatched-song.1'
      AND matched_song_id IS NULL
      AND match_method = 'unmatched'
      AND status = 'needs_match'
  ),
  'lowercase_ok', (
    SELECT COUNT(*) = 1
    FROM song_requests sr JOIN songs s ON s.id = sr.matched_song_id
    WHERE sr.source_event_id = 'phase4d.e2e-run.case-variants.1'
      AND sr.match_method = 'exact' AND s.title = 'fancy'
  ),
  'uppercase_ok', (
    SELECT COUNT(*) = 1
    FROM song_requests sr JOIN songs s ON s.id = sr.matched_song_id
    WHERE sr.source_event_id = 'phase4d.e2e-run.case-variants.2'
      AND sr.match_method = 'exact' AND s.title = 'FANCY'
  ),
  'mixedcase_ok', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.case-variants.3'
      AND matched_song_id IS NULL
      AND match_method = 'ambiguous'
      AND status = 'needs_match'
  ),
  'duplicate_event_once', (
    SELECT COUNT(*) = 1 FROM live_events
    WHERE event_id = 'phase4d.e2e-run.duplicate.1'
  ),
  'duplicate_request_once', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.duplicate.1'
  ),
  'conflict_event_once', (
    SELECT COUNT(*) = 1 FROM live_events
    WHERE event_id = 'phase4d.e2e-run.conflict.1'
      AND JSON_UNQUOTE(JSON_EXTRACT(normalized_payload, '$.text')) = '点歌 Simulator Conflict'
  ),
  'conflict_request_once', (
    SELECT COUNT(*) = 1 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.conflict.1'
  ),
  'same_song_duplicate_blocked', (
    SELECT COUNT(*) = 1
    FROM song_requests
    WHERE source_event_id IN (
      'phase4d.e2e-run.same-song-viewers.1',
      'phase4d.e2e-run.same-song-viewers.2'
    )
  ),
  'gift_request_absent', (
    SELECT COUNT(*) = 0 FROM song_requests
    WHERE source_event_id = 'phase4d.e2e-run.gift-event.1'
  ),
  'rollback_event_absent', (
    SELECT COUNT(*) = 0 FROM live_events
    WHERE event_id = 'phase4d.rollback-run.transaction-rollback.1'
  ),
  'rollback_request_absent', (
    SELECT COUNT(*) = 0 FROM song_requests
    WHERE source_event_id = 'phase4d.rollback-run.transaction-rollback.1'
  ),
  'stable_queue_order', (
    SELECT COUNT(*) = COUNT(DISTINCT queue_order)
      AND MIN(queue_order) = 1
      AND MAX(queue_order) = 8
    FROM song_requests
  ),
  'no_play_queue_column', (
    SELECT COUNT(*) = 0
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'song_requests'
      AND column_name IN ('queue_type', 'play_queue', 'playback_queue')
  ),
  'synthetic_events_only', (
    SELECT COUNT(*) = SUM(
      site_id = 'phase4d-synthetic'
      AND room_id = '99000000000000000001'
      AND actor_open_id LIKE 'phase4d.synthetic.%'
    )
    FROM live_events
  ),
  'synthetic_requests_only', (
    SELECT COUNT(*) = SUM(
      site_id = 'phase4d-synthetic'
      AND room_id = '99000000000000000001'
      AND requester_open_id LIKE 'phase4d.synthetic.%'
    )
    FROM song_requests
  )
) AS report;
`;
}

test('offline simulator traverses signed HTTP ingestion into isolated MySQL atomically', {
  timeout: 110000
}, async () => {
  const projectName = `phase4d-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const safeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4d-simulator-'));
  const databaseRootPassword = randomSecret();
  const databasePassword = randomSecret();
  const ingestSecret = randomSecret();
  const composeArgs = ['compose', '-p', projectName, '-f', composeFile];
  const dockerContext = {
    cwd: safeCwd,
    env: dockerEnvironment(databaseRootPassword, databasePassword)
  };
  let backend = null;
  let backendLogs = '';
  let triggerCreated = false;
  const cleanup = createCleanupCoordinator([
    async () => {
      if (!triggerCreated) return;
      mysqlInput(composeArgs, dockerContext, `
USE anna_bliver_fan_hub;
DROP TRIGGER IF EXISTS phase4d_fail_song_request;
`);
      triggerCreated = false;
    },
    async () => {
      await stopBackend(backend);
    },
    async () => {
      console.log('[phase4d-e2e] removing the exact isolated project and volume');
      const result = runDocker([
        ...composeArgs,
        'down',
        '-v',
        '--remove-orphans',
        '--timeout',
        '10'
      ], { ...dockerContext, allowFailure: true });
      if (result.error || result.status !== 0) {
        const error = new Error('Isolated Compose cleanup failed');
        error.code = result.error?.code || `docker_exit_${result.status}`;
        throw error;
      }
    },
    async () => {
      const remainingContainers = runDocker([
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.ID}}'
      ], dockerContext).stdout.trim();
      const remainingVolumes = runDocker([
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}'
      ], dockerContext).stdout.trim();
      assert.equal(remainingContainers, '');
      assert.equal(remainingVolumes, '');
    },
    async () => {
      fs.rmSync(safeCwd, { recursive: true, force: true });
    }
  ]);
  const exitAfterCleanup = (exitCode) => {
    cleanup()
      .then((errors) => process.exit(errors.length === 0 ? exitCode : 1))
      .catch(() => process.exit(1));
  };
  const onSigint = () => exitAfterCleanup(130);
  const onSigterm = () => exitAfterCleanup(143);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    console.log('[phase4d-e2e] starting isolated MySQL');
    runDocker([
      ...composeArgs,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '45'
    ], dockerContext);

    const containerId = runDocker([
      ...composeArgs,
      'ps',
      '-q',
      'mysql'
    ], dockerContext).stdout.trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const volumes = runDocker([
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${projectName}`,
      '--format',
      '{{.Name}}'
    ], dockerContext).stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(volumes.length, 1);
    assert.match(volumes[0], new RegExp(`^${projectName}_`));

    const portOutput = runDocker([
      ...composeArgs,
      'port',
      'mysql',
      '3306'
    ], dockerContext).stdout.trim();
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portOutput);
    assert.ok(portMatch, 'isolated MySQL must publish a loopback-only random port');
    const databasePort = Number(portMatch[1]);
    assert.notEqual(databasePort, 3306);

    console.log('[phase4d-e2e] loading full schema and synthetic fixture');
    mysqlInput(composeArgs, dockerContext, fs.readFileSync(schemaPath, 'utf8'));
    mysqlInput(composeArgs, dockerContext, fixtureSql());

    backend = fork(backendHelper, [], {
      cwd: safeCwd,
      env: {
        ...safeBaseEnvironment(),
        NODE_ENV: 'test',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(databasePort),
        DB_USER: 'phase4d',
        DB_PASSWORD: databasePassword,
        DB_NAME: 'anna_bliver_fan_hub',
        JWT_SECRET: randomSecret(),
        CORS_ORIGIN: 'http://localhost:3000',
        TRUST_PROXY: 'false',
        BOT_WS_URL: '',
        BOT_WS_TOKEN: '',
        BILIBILI_COOKIE: '',
        LIVE_EVENT_INGEST_ENABLED: 'true',
        LIVE_EVENT_INGEST_SECRET: ingestSecret,
        LIVE_EVENT_MAX_SKEW_SECONDS: '300',
        LIVE_EVENT_ALLOWED_TARGETS: 'phase4d-synthetic:99000000000000000001'
      },
      silent: true
    });
    backend.stdout.on('data', (chunk) => {
      backendLogs += chunk.toString('utf8');
    });
    backend.stderr.on('data', (chunk) => {
      backendLogs += chunk.toString('utf8');
    });
    const backendPort = await waitForBackend(backend);
    assert.notEqual(backendPort, 5000);
    const baseUrl = `http://127.0.0.1:${backendPort}`;

    console.log('[phase4d-e2e] running signed core scenarios through HTTP');
    const coreSummary = runCli({
      cwd: safeCwd,
      secret: ingestSecret,
      args: [
        'run',
        '--base-url',
        baseUrl,
        '--scenario',
        'all',
        '--run-id',
        'e2e-run',
        '--site-id',
        'phase4d-synthetic',
        '--room-id',
        '99000000000000000001',
        '--fixture',
        'phase4d-synthetic-session'
      ]
    });
    assert.deepEqual({
      scenarios: coreSummary.scenario_count,
      passed: coreSummary.scenario_passed,
      failed: coreSummary.scenario_failed,
      requests: coreSummary.request_count,
      accepted: coreSummary.accepted,
      duplicate: coreSummary.duplicate,
      conflict: coreSummary.conflict,
      expectedSongRequests: coreSummary.expected_song_requests
    }, {
      scenarios: 11,
      passed: 11,
      failed: 0,
      requests: 16,
      accepted: 14,
      duplicate: 1,
      conflict: 1,
      expectedSongRequests: 8
    });

    console.log('[phase4d-e2e] forcing one isolated transactional write failure');
    mysqlInput(composeArgs, dockerContext, `
USE anna_bliver_fan_hub;
CREATE TRIGGER phase4d_fail_song_request
BEFORE INSERT ON song_requests
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'phase4d_controlled_failure';
`);
    triggerCreated = true;
    const rollbackSummary = runCli({
      cwd: safeCwd,
      secret: ingestSecret,
      args: [
        'run',
        '--base-url',
        baseUrl,
        '--scenario',
        'transaction-rollback',
        '--run-id',
        'rollback-run',
        '--site-id',
        'phase4d-synthetic',
        '--room-id',
        '99000000000000000001',
        '--fixture',
        'phase4d-synthetic-session'
      ]
    });
    assert.equal(rollbackSummary.scenario_passed, 1);
    assert.equal(rollbackSummary.database_error, 1);
    mysqlInput(composeArgs, dockerContext, `
USE anna_bliver_fan_hub;
DROP TRIGGER phase4d_fail_song_request;
`);
    triggerCreated = false;

    console.log('[phase4d-e2e] verifying isolated database assertions');
    const reportOutput = mysqlInput(
      composeArgs,
      dockerContext,
      assertionSql()
    ).stdout.trim();
    const report = JSON.parse(reportOutput);
    assert.equal(Number(report.live_events), 14);
    assert.equal(Number(report.song_requests), 8);
    assert.equal(Number(report.history), 8);
    assert.equal(Number(report.users), 12);
    assert.equal(Number(report.permissions), 0);
    assert.equal(Number(report.wallets), 0);
    assert.equal(Number(report.accounts), 0);
    assert.equal(Number(report.transactions), 0);
    for (const key of [
      'simple_event_id_ok',
      'simple_raw_ok',
      'simple_title_ok',
      'simple_method_ok',
      'simple_song_ok',
      'simple_ok',
      'traditional_duplicate_blocked',
      'ordinary_absent',
      'playback_absent',
      'missing_space_absent',
      'unmatched_ok',
      'lowercase_ok',
      'uppercase_ok',
      'mixedcase_ok',
      'duplicate_event_once',
      'duplicate_request_once',
      'conflict_event_once',
      'conflict_request_once',
      'same_song_duplicate_blocked',
      'gift_request_absent',
      'rollback_event_absent',
      'rollback_request_absent',
      'stable_queue_order',
      'no_play_queue_column',
      'synthetic_events_only',
      'synthetic_requests_only'
    ]) {
      assert.equal(Number(report[key]), 1, key);
    }

    assert.doesNotMatch(backendLogs, new RegExp(ingestSecret));
    assert.doesNotMatch(backendLogs, /phase4d\.synthetic\./);
    assert.doesNotMatch(backendLogs, /点歌|點歌|播放|今天想唱什么/);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    const cleanupErrors = await cleanup();
    assert.deepEqual(cleanupErrors, []);
  }
});
