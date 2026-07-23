const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork, spawnSync } = require('node:child_process');

const { loadListenerConfig } = require('../src/config');
const { DeliveryClient } = require('../src/deliveryClient');
const { ListenerSupervisor } = require('../src/listenerSupervisor');
const { createSafeLogger } = require('../src/logger');
const { createSyntheticAdapter } = require('../src/syntheticAdapter');
const {
  SYNTHETIC_INSTANCE_ID,
  SYNTHETIC_ROOM_ID,
  SYNTHETIC_SITE_ID,
  syntheticDanmaku,
  syntheticGift
} = require('../src/syntheticFixtures');

const repositoryRoot = path.resolve(__dirname, '../../..');
const phase4dRoot = path.resolve(repositoryRoot, 'tools/live-event-simulator');
const composeFile = path.resolve(
  phase4dRoot,
  'test/fixtures/docker-compose.yml'
);
const backendHelper = path.resolve(
  phase4dRoot,
  'test/helpers/isolatedBackend.js'
);
const {
  createCleanupCoordinator
} = require(path.resolve(
  phase4dRoot,
  'test/helpers/cleanupCoordinator.js'
));
const schemaPath = path.resolve(
  repositoryRoot,
  'backend/src/config/schema.sql'
);

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

function dockerEnvironment(rootPassword, databasePassword) {
  return {
    ...safeBaseEnvironment(),
    COMPOSE_DISABLE_ENV_FILE: '1',
    PHASE4D_DB_ROOT_PASSWORD: rootPassword,
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
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
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

function assertLoopbackPortReleased(port) {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function fixtureSql() {
  return `
USE anna_bliver_fan_hub;
INSERT INTO users (username, email, password, role)
VALUES (
  'phase4e_admin',
  'phase4e-admin@example.com',
  'synthetic-not-a-real-password-hash',
  'admin'
);
SET @phase4e_admin_id = LAST_INSERT_ID();
INSERT INTO playlists (title, description, created_by)
VALUES (
  'Phase 4E Synthetic Playlist',
  'Synthetic fixture only',
  @phase4e_admin_id
);
SET @phase4e_playlist_id = LAST_INSERT_ID();
INSERT INTO songs (playlist_id, title, artist, song_order)
VALUES (@phase4e_playlist_id, '年轮', 'Synthetic Artist', 1);
INSERT INTO live_sessions (
  public_id,
  site_id,
  room_id,
  playlist_id,
  title,
  status,
  created_by_user_id,
  started_at
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '${SYNTHETIC_SITE_ID}',
  '${SYNTHETIC_ROOM_ID}',
  @phase4e_playlist_id,
  'Phase 4E Synthetic Session',
  'open',
  @phase4e_admin_id,
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
  'danmaku_request_once', (
    SELECT COUNT(*) = 1
    FROM song_requests
    WHERE source_event_id =
      'synthetic:${SYNTHETIC_ROOM_ID}:phase4e-e2e-danmaku'
  ),
  'retry_request_once', (
    SELECT COUNT(*) = 1
    FROM song_requests
    WHERE source_event_id =
      'synthetic:${SYNTHETIC_ROOM_ID}:phase4e-e2e-retry'
  ),
  'gift_request_absent', (
    SELECT COUNT(*) = 0
    FROM song_requests
    WHERE source_event_id =
      'synthetic:${SYNTHETIC_ROOM_ID}:phase4e-e2e-gift'
  ),
  'conflict_preserved', (
    SELECT COUNT(*) = 1
    FROM live_events
    WHERE event_id =
      'synthetic:${SYNTHETIC_ROOM_ID}:phase4e-e2e-danmaku'
      AND JSON_UNQUOTE(JSON_EXTRACT(normalized_payload, '$.text')) =
        '点歌 年轮'
  ),
  'all_synthetic', (
    SELECT COUNT(*) = SUM(
      site_id = '${SYNTHETIC_SITE_ID}'
      AND room_id = '${SYNTHETIC_ROOM_ID}'
      AND actor_open_id LIKE 'phase4e.synthetic.%'
    )
    FROM live_events
  )
) AS report;
`;
}

test('silent listener delivers synthetic events through isolated Backend and MySQL', {
  timeout: 110000
}, async () => {
  const projectName = `phase4e-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const safeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4e-listener-'));
  const rootPassword = randomSecret();
  const databasePassword = randomSecret();
  const ingestSecret = randomSecret();
  const composeArgs = ['compose', '-p', projectName, '-f', composeFile];
  const dockerContext = {
    cwd: safeCwd,
    env: dockerEnvironment(rootPassword, databasePassword)
  };
  let backend = null;
  let backendLogs = '';
  let supervisor = null;
  let databasePort = null;
  let backendPort = null;

  const cleanup = createCleanupCoordinator([
    async () => {
      if (supervisor) await supervisor.stop();
    },
    async () => {
      await stopBackend(backend);
    },
    async () => {
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
      const containers = runDocker([
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.ID}}'
      ], dockerContext).stdout.trim();
      const volumes = runDocker([
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}'
      ], dockerContext).stdout.trim();
      const networks = runDocker([
        'network',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}'
      ], dockerContext).stdout.trim();
      assert.equal(containers, '');
      assert.equal(volumes, '');
      assert.equal(networks, '');
    },
    async () => {
      await assertLoopbackPortReleased(backendPort);
      await assertLoopbackPortReleased(databasePort);
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
    console.log('[phase4e-e2e] starting isolated MySQL');
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
    const portOutput = runDocker([
      ...composeArgs,
      'port',
      'mysql',
      '3306'
    ], dockerContext).stdout.trim();
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portOutput);
    assert.ok(portMatch);
    databasePort = Number(portMatch[1]);
    assert.notEqual(databasePort, 3306);

    console.log('[phase4e-e2e] loading schema and synthetic fixture');
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
        LIVE_EVENT_ALLOWED_TARGETS:
          `${SYNTHETIC_SITE_ID}:${SYNTHETIC_ROOM_ID}`
      },
      silent: true
    });
    backend.stdout.on('data', (chunk) => {
      backendLogs += chunk.toString('utf8');
    });
    backend.stderr.on('data', (chunk) => {
      backendLogs += chunk.toString('utf8');
    });
    backendPort = await waitForBackend(backend);
    assert.notEqual(backendPort, 5000);

    const config = loadListenerConfig({
      LISTENER_SITE_ID: SYNTHETIC_SITE_ID,
      LISTENER_INSTANCE_ID: SYNTHETIC_INSTANCE_ID,
      LISTENER_ROOM_ID: SYNTHETIC_ROOM_ID,
      LISTENER_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      LIVE_EVENT_INGEST_SECRET: ingestSecret
    }, {
      mode: 'test',
      overrides: {
        deliveryMaxAttempts: 3,
        deliveryTimeoutMs: 2000,
        deliveryRetryInitialMs: 10,
        deliveryRetryMaxMs: 20,
        queueMaxLength: 10,
        deliveryConcurrency: 1,
        shutdownDrainTimeoutMs: 2000
      }
    });
    const httpCounts = new Map();
    const retryBodyHashes = [];
    let retryFailureInjected = false;
    const trackedFetch = async (url, options) => {
      const parsedBody = JSON.parse(options.body);
      if (
        parsedBody.event_id.endsWith(':phase4e-e2e-retry') &&
        !retryFailureInjected
      ) {
        retryFailureInjected = true;
        retryBodyHashes.push(
          crypto.createHash('sha256').update(options.body).digest('hex')
        );
        httpCounts.set(500, (httpCounts.get(500) || 0) + 1);
        return new Response(JSON.stringify({
          status: 'rejected',
          reason: 'database_error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (parsedBody.event_id.endsWith(':phase4e-e2e-retry')) {
        retryBodyHashes.push(
          crypto.createHash('sha256').update(options.body).digest('hex')
        );
      }
      const response = await fetch(url, options);
      httpCounts.set(
        response.status,
        (httpCounts.get(response.status) || 0) + 1
      );
      return response;
    };

    const listenerLogs = [];
    const deliveryClient = new DeliveryClient({
      config,
      fetchImpl: trackedFetch
    });
    const adapter = createSyntheticAdapter();
    supervisor = new ListenerSupervisor({
      config,
      adapter,
      deliveryClient,
      logger: createSafeLogger({
        sink: (record) => listenerLogs.push(record)
      })
    });
    await supervisor.start();

    console.log('[phase4e-e2e] delivering accepted, duplicate, conflict, gift, and retry');
    const danmaku = syntheticDanmaku(
      'phase4e-e2e-danmaku',
      '点歌 年轮'
    );
    await adapter.emitEvent(danmaku);
    await adapter.emitEvent(syntheticGift('phase4e-e2e-gift'));
    await adapter.emitEvent(danmaku);
    const conflict = structuredClone(danmaku);
    conflict.data.text = '点歌 不存在的合成冲突曲目';
    await adapter.emitEvent(conflict);
    await adapter.emitEvent(syntheticDanmaku(
      'phase4e-e2e-retry',
      '点歌 年轮'
    ));
    assert.equal((await supervisor.waitForIdle(5000)).drained, true);

    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.received, 5);
    assert.equal(snapshot.mapped, 5);
    assert.equal(snapshot.accepted, 3);
    assert.equal(snapshot.duplicate, 1);
    assert.equal(snapshot.conflict, 1);
    assert.equal(snapshot.retried, 1);
    assert.equal(snapshot.failed, 0);
    assert.equal(retryFailureInjected, true);
    assert.equal(retryBodyHashes.length, 2);
    assert.equal(new Set(retryBodyHashes).size, 1);
    assert.deepEqual(Object.fromEntries(httpCounts), {
      200: 1,
      201: 3,
      409: 1,
      500: 1
    });

    console.log('[phase4e-e2e] verifying isolated database state');
    const report = JSON.parse(
      mysqlInput(composeArgs, dockerContext, assertionSql()).stdout.trim()
    );
    assert.equal(Number(report.live_events), 3);
    assert.equal(Number(report.song_requests), 2);
    assert.equal(Number(report.history), 2);
    assert.equal(Number(report.users), 1);
    assert.equal(Number(report.permissions), 0);
    assert.equal(Number(report.wallets), 0);
    assert.equal(Number(report.accounts), 0);
    assert.equal(Number(report.transactions), 0);
    for (const key of [
      'danmaku_request_once',
      'retry_request_once',
      'gift_request_absent',
      'conflict_preserved',
      'all_synthetic'
    ]) {
      assert.equal(Number(report[key]), 1, key);
    }

    const serializedListenerLogs = JSON.stringify(listenerLogs);
    assert.doesNotMatch(serializedListenerLogs, /点歌|phase4e\.synthetic\./);
    assert.doesNotMatch(serializedListenerLogs, new RegExp(ingestSecret));
    assert.doesNotMatch(backendLogs, /点歌|phase4e\.synthetic\./);
    assert.doesNotMatch(backendLogs, new RegExp(ingestSecret));
    console.log(
      '[phase4e-e2e] http=201:3,200:1,409:1,500:1 db=3/2/2 points=0/0/0'
    );
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    const cleanupErrors = await cleanup();
    assert.deepEqual(cleanupErrors, []);
  }
});
