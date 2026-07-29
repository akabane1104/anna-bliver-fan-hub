const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const {
  MIGRATION,
  MigrationError,
  acquireMigrationLock,
  createMigrationRunner,
  loadMigration,
  releaseMigrationLock
} = require('../src/migrations/migrationRunner');
const {
  legacyTables,
  targetContracts
} = require('../src/migrations/schemaContracts');
const { inspectTables } = require('../src/migrations/schemaInspector');
const {
  createLiveAdminRepository
} = require('../src/services/liveAdminService');

const CONFIRMATION = 'r1-isolated-schema-migrations';
const integrationEnabled = process.env.R1_MIGRATION_TEST_CONFIRM === CONFIRMATION;
const repositoryRoot = path.resolve(__dirname, '../..');
const backendRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(backendRoot, 'src/config/schema.sql');
const migrationCliPath = path.join(backendRoot, 'scripts/schema-migrate.js');
const denyRemoteNetworkPath = path.join(__dirname, 'helpers/denyRemoteNetwork.js');
const legacyApplicationCommit = 'c36a46d9556463ce49afad1694c32acecd5c1986';

function integrationConfig(database) {
  const host = process.env.R1_MIGRATION_TEST_DB_HOST;
  const port = Number(process.env.R1_MIGRATION_TEST_DB_PORT);
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port <= 0 || port === 3306) {
    throw new Error('isolated_database_target_required');
  }
  return {
    DB_HOST: host,
    DB_PORT: String(port),
    DB_USER: process.env.R1_MIGRATION_TEST_DB_USER || 'root',
    DB_PASSWORD: process.env.R1_MIGRATION_TEST_DB_PASSWORD || '',
    DB_NAME: database
  };
}

function extractCreateStatement(sql, tableName) {
  const expression = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4(?: COLLATE=utf8mb4_unicode_ci)?;`,
    'i'
  );
  const match = sql.match(expression);
  assert.ok(match, `missing schema statement for ${tableName}`);
  return match[0];
}

function schemaSql(database, { includeTargets }) {
  let sql = fs.readFileSync(schemaPath, 'utf8')
    .replace(
      /CREATE DATABASE IF NOT EXISTS anna_bliver_fan_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;/,
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    )
    .replace(/USE anna_bliver_fan_hub;/, `USE \`${database}\`;`);
  if (!includeTargets) {
    sql = sql.replace(
      "role ENUM('fan_club','captain','admiral','governor','streamer','admin') NOT NULL DEFAULT 'fan_club'",
      "role ENUM('user','premium','admin') NOT NULL DEFAULT 'user'"
    );
    for (const tableName of Object.keys(targetContracts)) {
      sql = sql.replace(extractCreateStatement(sql, tableName), '');
    }
    sql = sql
      .replace(/\s+bilibili_open_id VARCHAR\(128\)[^\r\n]*\r?\n/, '\n')
      .replace(/\s+UNIQUE KEY unique_bound_open_id[^\r\n]*\r?\n/, '\n')
      .replace(/\s+UNIQUE KEY unique_song_alias_normalized[^\r\n]*\r?\n/, '\n')
      .replace(/\s+UNIQUE KEY unique_song_alias_script[^\r\n]*\r?\n/, '\n');
    for (const columnName of [
      'target_anchor_uid',
      'target_room_id',
      'fans_medal_level',
      'fans_medal_name',
      'fans_medal_status',
      'guard_level',
      'guard_started_at',
      'guard_expires_at',
      'identity_sync_status',
      'identity_source',
      'last_sync_attempt_at',
      'last_sync_success_at',
      'last_sync_error_code',
      'identity_observed_at',
      'identity_version',
      'sync_failure_count',
      'next_sync_at',
      'manual_role',
      'manual_expires_at',
      'manual_actor_user_id',
      'manual_reason',
      'manual_created_at',
      'manual_overridden_at'
    ]) {
      sql = sql.replace(new RegExp(`\\s+${columnName} [^\\r\\n]*\\r?\\n`), '\n');
    }
    sql = sql
      .replace(/\s+INDEX idx_binding_identity_due[^\r\n]*\r?\n/, '\n')
      .replace(/\s+INDEX idx_binding_guard_expiry[^\r\n]*\r?\n/, '\n')
      .replace(/\s+INDEX idx_binding_manual_expiry[^\r\n]*\r?\n/, '\n')
      .replace(/\s+CONSTRAINT fk_binding_manual_actor[^\r\n]*\r?\n/, '\n')
      .replace(/(CONSTRAINT fk_binding_user[^\r\n]*),\r?\n/, '$1\n');
  }
  return sql;
}

async function createRootConnection() {
  const config = integrationConfig('unused');
  return mysql.createConnection({
    host: config.DB_HOST,
    port: Number(config.DB_PORT),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    multipleStatements: true,
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true
  });
}

async function createScenarioDatabase(root, database, includeTargets) {
  await root.query(schemaSql(database, { includeTargets }));
}

async function connectDatabase(database) {
  const config = integrationConfig(database);
  return mysql.createConnection({
    host: config.DB_HOST,
    port: Number(config.DB_PORT),
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true
  });
}

async function tableCount(connection, tableName) {
  const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${tableName}\``);
  return Number(row.count);
}

async function seedLegacyData(connection) {
  await connection.query(`
    INSERT INTO users (username, email, password, role)
    VALUES
      ('r1-synthetic-user', 'r1-synthetic@example.com', 'synthetic-not-a-login', 'user'),
      ('r1-synthetic-premium', 'r1-synthetic-premium@example.com', 'synthetic-not-a-login', 'premium'),
      ('r1-synthetic-admin', 'r1-synthetic-admin@example.com', 'synthetic-not-a-login', 'admin');
    SET @r1_user_id = (
      SELECT id FROM users WHERE username = 'r1-synthetic-user'
    );
    INSERT INTO permissions (user_id, permission_key)
    VALUES (@r1_user_id, 'synthetic.permission');
    SET @r1_playlist_id = (SELECT MIN(id) FROM playlists);
    INSERT INTO songs (playlist_id, title, artist)
    VALUES (@r1_playlist_id, 'R1 Synthetic Song', 'R1 Synthetic Artist');
    SET @r1_song_id = LAST_INSERT_ID();
    INSERT INTO tags (name, color) VALUES ('R1 Synthetic Tag', '#123456');
    SET @r1_tag_id = LAST_INSERT_ID();
    INSERT INTO song_tags (song_id, tag_id) VALUES (@r1_song_id, @r1_tag_id);
    INSERT INTO marshmallows (uuid, title, sender_alias, content, user_id)
    VALUES ('00000000-0000-4000-8000-000000000001', 'Synthetic', 'Synthetic', 'Synthetic', @r1_user_id);
    INSERT INTO point_wallets (user_id, primary_bilibili_uid, points_balance, remainder_coin)
    VALUES (@r1_user_id, 990000000001, 7, 3);
    SET @r1_wallet_id = LAST_INSERT_ID();
    INSERT INTO point_accounts (bilibili_uid, bilibili_uname, claimed_user_id, wallet_id, claimed_at)
    VALUES (990000000001, 'R1 Synthetic', @r1_user_id, @r1_wallet_id, CURRENT_TIMESTAMP);
  `);
}

async function snapshotTableData(connection, database, tableNames) {
  const [primaryRows] = await connection.query(
    `SELECT TABLE_NAME AS table_name,
            SEQ_IN_INDEX AS sequence_number,
            COLUMN_NAME AS column_name
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
       AND INDEX_NAME = 'PRIMARY'
     ORDER BY TABLE_NAME, SEQ_IN_INDEX`,
    [database]
  );
  const primaryColumns = new Map();
  for (const row of primaryRows) {
    if (!primaryColumns.has(row.table_name)) primaryColumns.set(row.table_name, []);
    primaryColumns.get(row.table_name).push(row.column_name);
  }
  const rows = {};
  for (const tableName of tableNames) {
    const ordering = primaryColumns.get(tableName) || [];
    const orderSql = ordering.length
      ? ` ORDER BY ${ordering.map((name) => `\`${name}\``).join(', ')}`
      : '';
    const [tableRows] = await connection.query(`SELECT * FROM \`${tableName}\`${orderSql}`);
    rows[tableName] = {
      count: tableRows.length,
      checksum: crypto.createHash('sha256')
        .update(JSON.stringify(tableRows))
        .digest('hex')
    };
  }
  return rows;
}

async function snapshotLegacy(connection, database) {
  const structures = await inspectTables(connection, database, legacyTables);
  const rows = await snapshotTableData(connection, database, legacyTables);
  const [usersWithoutRole] = await connection.query(
    `SELECT id, username, email, password, created_at
     FROM users
     ORDER BY id`
  );
  const [userRoles] = await connection.query(
    'SELECT username, role FROM users ORDER BY username'
  );
  return { structures, rows, usersWithoutRole, userRoles };
}

function assertLegacyUpgradePreserved(before, after) {
  for (const tableName of legacyTables.filter((name) => name !== 'users')) {
    assert.deepEqual(after.rows[tableName], before.rows[tableName], tableName);
  }
  assert.deepEqual(after.usersWithoutRole, before.usersWithoutRole);
  assert.deepEqual(after.userRoles, [
    { username: 'r1-synthetic-admin', role: 'admin' },
    { username: 'r1-synthetic-premium', role: 'streamer' },
    { username: 'r1-synthetic-user', role: 'fan_club' }
  ]);
  for (const tableName of legacyTables) {
    if (['users', 'user_bilibili_bindings'].includes(tableName)) continue;
    assert.deepEqual(after.structures[tableName], before.structures[tableName], tableName);
  }

  const beforeUsers = before.structures.users;
  const afterUsers = after.structures.users;
  assert.deepEqual(
    afterUsers.columns.filter(({ name }) => name !== 'role'),
    beforeUsers.columns.filter(({ name }) => name !== 'role')
  );
  assert.deepEqual(afterUsers.indexes, beforeUsers.indexes);
  assert.deepEqual(afterUsers.foreign_keys, beforeUsers.foreign_keys);
  assert.equal(afterUsers.engine, beforeUsers.engine);
  assert.equal(afterUsers.charset, beforeUsers.charset);
  assert.equal(afterUsers.collation, beforeUsers.collation);
  assert.deepEqual(
    afterUsers.columns.find(({ name }) => name === 'role'),
    {
      ...beforeUsers.columns.find(({ name }) => name === 'role'),
      name: 'role',
      type: "enum('fan_club','captain','admiral','governor','streamer','admin')",
      nullable: false,
      default: 'fan_club'
    }
  );

  const beforeBindings = before.structures.user_bilibili_bindings;
  const afterBindings = after.structures.user_bilibili_bindings;
  const addedBindingColumns = new Set([
    'bilibili_open_id',
    'target_anchor_uid',
    'target_room_id',
    'fans_medal_level',
    'fans_medal_name',
    'fans_medal_status',
    'guard_level',
    'guard_started_at',
    'guard_expires_at',
    'identity_sync_status',
    'identity_source',
    'last_sync_attempt_at',
    'last_sync_success_at',
    'last_sync_error_code',
    'identity_observed_at',
    'identity_version',
    'sync_failure_count',
    'next_sync_at',
    'manual_role',
    'manual_expires_at',
    'manual_actor_user_id',
    'manual_reason',
    'manual_created_at',
    'manual_overridden_at'
  ]);
  const addedBindingIndexes = new Set([
    'unique_bound_open_id',
    'idx_binding_identity_due',
    'idx_binding_guard_expiry',
    'idx_binding_manual_expiry',
    'fk_binding_manual_actor'
  ]);
  assert.deepEqual(
    afterBindings.columns.filter(({ name }) => !addedBindingColumns.has(name)),
    beforeBindings.columns
  );
  assert.deepEqual(
    afterBindings.indexes.filter(({ name }) => !addedBindingIndexes.has(name)),
    beforeBindings.indexes
  );
  assert.deepEqual(
    afterBindings.foreign_keys.filter(({ name }) => name !== 'fk_binding_manual_actor'),
    beforeBindings.foreign_keys
  );
  assert.equal(afterBindings.engine, beforeBindings.engine);
  assert.equal(afterBindings.charset, beforeBindings.charset);
  assert.equal(afterBindings.collation, beforeBindings.collation);
  assert.deepEqual(
    afterBindings.columns.find(({ name }) => name === 'bilibili_open_id'),
    {
      name: 'bilibili_open_id',
      type: 'varchar(128)',
      nullable: true,
      default: null,
      charset: 'utf8mb4',
      collation: 'utf8mb4_bin',
      generated: null,
      generation_expression: null,
      auto_increment: false,
      on_update: null
    }
  );
  assert.deepEqual(
    afterBindings.indexes.find(({ name }) => name === 'unique_bound_open_id'),
    {
      name: 'unique_bound_open_id',
      unique: true,
      columns: ['bilibili_open_id']
    }
  );
}

async function countAllTables(connection, database) {
  const [[row]] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?`,
    [database]
  );
  return Number(row.count);
}

function runnerFor(database) {
  return createMigrationRunner({ env: integrationConfig(database) });
}

function runMigrationCli(command, database) {
  const config = integrationConfig(database);
  const result = spawnSync(process.execPath, [migrationCliPath, command], {
    cwd: backendRoot,
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ...config
    },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.trim() || 'migration_cli_failed');
  return JSON.parse(result.stdout);
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForBackend(child, port) {
  const deadline = Date.now() + 15000;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return;
    } catch {
      // The child may still be initializing the isolated database connection.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(exited ? 'isolated_backend_exited' : 'isolated_backend_timeout');
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function verifyBackendStartup(entry, cwd, database) {
  const port = await freeLoopbackPort();
  const db = integrationConfig(database);
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_HOST: db.DB_HOST,
      DB_PORT: db.DB_PORT,
      DB_USER: db.DB_USER,
      DB_PASSWORD: db.DB_PASSWORD,
      DB_NAME: db.DB_NAME,
      JWT_SECRET: 'r1-synthetic-jwt-secret-not-for-production',
      TRUST_PROXY: '0',
      CORS_ORIGIN: 'http://localhost:3000',
      BOT_WS_URL: '',
      BOT_WS_TOKEN: '',
      BILIBILI_COOKIE: '',
      LIVE_EVENT_INGEST_ENABLED: '',
      LIVE_EVENT_INGEST_SECRET: '',
      NODE_PATH: path.join(backendRoot, 'node_modules'),
      NODE_OPTIONS: `--require=${denyRemoteNetworkPath}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  try {
    await waitForBackend(child, port);
  } finally {
    await stopBackend(child);
  }
}

function exportLegacyBackend(directory) {
  const archivePath = path.join(directory, 'legacy-backend.tar');
  const archive = spawnSync(
    'git',
    ['archive', '--format=tar', `--output=${archivePath}`, legacyApplicationCommit, 'backend'],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 30000, windowsHide: true }
  );
  assert.equal(archive.status, 0, 'legacy_backend_archive_failed');
  const extract = spawnSync(
    'tar',
    ['-xf', archivePath, '-C', directory],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 30000, windowsHide: true }
  );
  assert.equal(extract.status, 0, 'legacy_backend_extract_failed');
  return path.join(directory, 'backend/src/server.js');
}

test('isolated MySQL verifies ordered Phase 4B/4C and R4 index migration paths', {
  skip: !integrationEnabled,
  timeout: 120000
}, async (t) => {
  const suffix = `${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const databases = {
    fresh: `r1_fresh_${suffix}`,
    existing: `r1_existing_${suffix}`,
    conflict: `r1_conflict_${suffix}`,
    partial: `r1_partial_${suffix}`,
    incompatible: `r1_incompatible_${suffix}`,
    indexConflict: `r4_index_conflict_${suffix}`,
    equivalentIndex: `r4_equivalent_index_${suffix}`
  };
  const root = await createRootConnection();
  let existingBefore;
  let existingAfter;
  let freshStructures;
  let upgradedStructures;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-r1-rollback-'));

  try {
    await t.test('fresh install adopts additive tables and applies ordered indexes', async () => {
      await createScenarioDatabase(root, databases.fresh, true);
      const connection = await connectDatabase(databases.fresh);
      try {
        const before = await snapshotLegacy(connection, databases.fresh);
        const result = runMigrationCli('apply', databases.fresh);
        assert.equal(result.outcome, 'applied');
        assert.deepEqual(result.created_tables, []);
        assert.deepEqual(result.created_indexes, [
          'live_events.idx_live_event_received'
        ]);
        assert.equal(runMigrationCli('postcheck', databases.fresh).applied, true);
        assert.equal(await countAllTables(connection, databases.fresh), 32);
        assert.deepEqual(await snapshotLegacy(connection, databases.fresh), before);
        freshStructures = await inspectTables(
          connection,
          databases.fresh,
          Object.keys(targetContracts)
        );
      } finally {
        await connection.end();
      }
    });

    await t.test('existing 22-table install upgrades and preserves every legacy row', async () => {
      await createScenarioDatabase(root, databases.existing, false);
      const connection = await connectDatabase(databases.existing);
      try {
        assert.equal(await countAllTables(connection, databases.existing), 22);
        await seedLegacyData(connection);
        existingBefore = await snapshotLegacy(connection, databases.existing);
        const preflight = runMigrationCli('preflight', databases.existing);
        assert.equal(preflight.applied, false);
        assert.ok(Object.values(preflight.table_states).every(({ state }) => state === 'missing'));
        const result = runMigrationCli('apply', databases.existing);
        assert.equal(result.outcome, 'applied');
        assert.deepEqual(result.created_tables, Object.keys(targetContracts));
        assert.deepEqual(result.created_indexes, [
          'live_events.idx_live_event_received',
          'user_bilibili_bindings.unique_bound_open_id',
          'song_aliases.unique_song_alias_normalized',
          'song_aliases.unique_song_alias_script',
          'user_bilibili_bindings.idx_binding_identity_due',
          'user_bilibili_bindings.idx_binding_guard_expiry',
          'user_bilibili_bindings.idx_binding_manual_expiry'
        ]);
        assert.equal(await countAllTables(connection, databases.existing), 32);
        existingAfter = await snapshotLegacy(connection, databases.existing);
        assertLegacyUpgradePreserved(existingBefore, existingAfter);
        upgradedStructures = await inspectTables(
          connection,
          databases.existing,
          Object.keys(targetContracts)
        );
      } finally {
        await connection.end();
      }
    });

    await t.test('rerun is a locked no-op with one ledger row per migration', async () => {
      const connection = await connectDatabase(databases.existing);
      try {
        const before = await snapshotLegacy(connection, databases.existing);
        assert.equal(runMigrationCli('status', databases.existing).applied, true);
        const result = runMigrationCli('apply', databases.existing);
        assert.equal(result.outcome, 'noop');
        assert.equal(await tableCount(connection, 'schema_migrations'), 6);
        assert.deepEqual(await snapshotLegacy(connection, databases.existing), before);
        const [ledgerRows] = await connection.query(
          'SELECT version FROM schema_migrations ORDER BY version'
        );
        assert.deepEqual(
          ledgerRows.map(({ version }) => version),
          [
            '202607240001',
            '202607240002',
            '202607240003',
            '202607240004',
            '202607240005',
            '202607240006'
          ]
        );

        const blocker = await connectDatabase(databases.existing);
        let lock;
        try {
          lock = await acquireMigrationLock(blocker, databases.existing);
          await assert.rejects(
            runnerFor(databases.existing).run('preflight'),
            (error) => error instanceof MigrationError
              && error.code === 'migration_lock_unavailable'
          );
        } finally {
          await releaseMigrationLock(blocker, lock);
          await blocker.end();
        }
      } finally {
        await connection.end();
      }
    });

    await t.test('R4 index failure never records the new migration as applied', async () => {
      await createScenarioDatabase(root, databases.indexConflict, true);
      const connection = await connectDatabase(databases.indexConflict);
      try {
        await connection.query(
          `ALTER TABLE live_events
           ADD INDEX idx_live_event_received (id, received_at)`
        );
        await assert.rejects(
          runnerFor(databases.indexConflict).run('apply'),
          (error) => error.code === 'migration_target_schema_incompatible'
        );
        const [ledgerRows] = await connection.query(
          'SELECT version FROM schema_migrations ORDER BY version'
        );
        assert.deepEqual(
          ledgerRows.map(({ version }) => version),
          ['202607240001']
        );
      } finally {
        await connection.end();
      }
    });

    await t.test('an equivalent existing index is adopted without creating a duplicate', async () => {
      await createScenarioDatabase(root, databases.equivalentIndex, true);
      const connection = await connectDatabase(databases.equivalentIndex);
      try {
        await connection.query(
          `ALTER TABLE live_events
           ADD INDEX idx_r4_equivalent_received (received_at, id)`
        );
        const result = await runnerFor(databases.equivalentIndex).run('apply');
        assert.deepEqual(result.created_indexes, []);
        const [indexRows] = await connection.query(
          `SELECT INDEX_NAME AS index_name
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ?
             AND TABLE_NAME = 'live_events'
           GROUP BY INDEX_NAME
           HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             = 'received_at,id'`,
          [databases.equivalentIndex]
        );
        assert.deepEqual(
          indexRows.map(({ index_name: name }) => name),
          ['idx_r4_equivalent_received']
        );
      } finally {
        await connection.end();
      }
    });

    await t.test('received_at queries use the R4 composite index in MySQL EXPLAIN', async () => {
      const connection = await connectDatabase(databases.existing);
      try {
        const repository = createLiveAdminRepository({ pool: connection });
        assert.deepEqual(await repository.listActiveSessions(), []);
        const summary = await repository.getIngestionSummary();
        assert.equal(Number(summary.total_saved), 0);
        assert.equal(summary.last_event_at, null);
        assert.equal(Number(summary.recent_event_count), 0);
        const [orderedPlan] = await connection.query(
          `EXPLAIN SELECT id, received_at
           FROM live_events
           ORDER BY received_at DESC, id DESC
           LIMIT 20`
        );
        assert.equal(orderedPlan[0].key, 'idx_live_event_received');
        const [recentPlan] = await connection.query(
          `EXPLAIN SELECT COUNT(*)
           FROM live_events
           WHERE received_at >= UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE`
        );
        assert.equal(recentPlan[0].key, 'idx_live_event_received');
      } finally {
        await connection.end();
      }
    });

    await t.test('checksum conflict fails closed', async () => {
      await createScenarioDatabase(root, databases.conflict, false);
      await runnerFor(databases.conflict).run('apply');
      const connection = await connectDatabase(databases.conflict);
      try {
        await connection.query(
          `UPDATE schema_migrations SET checksum = ? WHERE version = ?`,
          ['0'.repeat(64), loadMigration().version]
        );
        await assert.rejects(
          runnerFor(databases.conflict).run('preflight'),
          (error) => error.code === 'migration_checksum_conflict'
        );
      } finally {
        await connection.end();
      }
    });

    await t.test('compatible partial state resumes only missing tables', async () => {
      await createScenarioDatabase(root, databases.partial, false);
      const connection = await connectDatabase(databases.partial);
      try {
        const migration = loadMigration();
        await connection.query(extractCreateStatement(migration.sql, 'live_events'));
        await connection.query(extractCreateStatement(migration.sql, 'live_sessions'));
        const result = await runnerFor(databases.partial).run('apply');
        assert.deepEqual(result.created_tables, [
          'song_requests',
          'song_request_history',
          'song_aliases',
          'song_request_policies',
          'song_request_details',
          'obs_overlay_events',
          'viewer_identity_audit'
        ]);
        assert.equal(await countAllTables(connection, databases.partial), 32);
      } finally {
        await connection.end();
      }
    });

    await t.test('incompatible partial state fails without rewriting the table', async () => {
      await createScenarioDatabase(root, databases.incompatible, false);
      const connection = await connectDatabase(databases.incompatible);
      try {
        await connection.query(
          `CREATE TABLE live_events (
             id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
             incompatible_marker VARCHAR(20) NOT NULL
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
        await assert.rejects(
          runnerFor(databases.incompatible).run('apply'),
          (error) => error.code === 'migration_target_schema_incompatible'
        );
        const structures = await inspectTables(
          connection,
          databases.incompatible,
          ['live_events', 'schema_migrations']
        );
        assert.deepEqual(
          structures.live_events.columns.map(({ name }) => name),
          ['id', 'incompatible_marker']
        );
        assert.equal(structures.schema_migrations, undefined);
      } finally {
        await connection.end();
      }
    });

    await t.test('fresh and upgraded target structures are identical', () => {
      assert.deepEqual(upgradedStructures, freshStructures);
    });

    await t.test('pre-migration and current applications start with listener disabled', async () => {
      const beforeConnection = await connectDatabase(databases.existing);
      let targetDataBefore;
      try {
        await beforeConnection.query(
          `INSERT INTO live_events (
             event_id, schema_version, event_type, site_id, room_id, mode,
             source_cmd, occurred_at, received_at, normalized_payload, content_hash
           ) VALUES (
             'r1-synthetic-rollback-event', '1.0', 'live_start',
             'r1-synthetic-site', '990000000009', 'simulation',
             'R1_SYNTHETIC', '2026-07-24 00:00:00.000',
             '2026-07-24 00:00:01.000', JSON_OBJECT('synthetic', TRUE),
             REPEAT('a', 64)
           )`
        );
        targetDataBefore = await snapshotTableData(
          beforeConnection,
          databases.existing,
          Object.keys(targetContracts)
        );
      } finally {
        await beforeConnection.end();
      }

      const legacyEntry = exportLegacyBackend(temporaryDirectory);
      await verifyBackendStartup(legacyEntry, temporaryDirectory, databases.existing);
      await verifyBackendStartup(
        path.join(backendRoot, 'src/server.js'),
        temporaryDirectory,
        databases.existing
      );
      const connection = await connectDatabase(databases.existing);
      try {
        assert.deepEqual(await snapshotLegacy(connection, databases.existing), existingAfter);
        assert.deepEqual(
          await snapshotTableData(
            connection,
            databases.existing,
            Object.keys(targetContracts)
          ),
          targetDataBefore
        );
        assert.equal(await tableCount(connection, 'schema_migrations'), 6);
      } finally {
        await connection.end();
      }
    });
  } finally {
    await root.end();
    const resolvedTemporary = path.resolve(temporaryDirectory);
    if (!resolvedTemporary.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error('unsafe_temporary_cleanup_target');
    }
    fs.rmSync(resolvedTemporary, { recursive: true, force: true });
  }
});
