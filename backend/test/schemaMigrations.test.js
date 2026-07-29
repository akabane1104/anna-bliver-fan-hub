const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LEDGER_SQL,
  MIGRATION,
  MigrationError,
  assertMigrationDataPreconditions,
  loadMigration,
  loadMigrations,
  readConfig
} = require('../src/migrations/migrationRunner');
const {
  ledgerContract,
  legacyTables,
  migrationContracts,
  targetContracts
} = require('../src/migrations/schemaContracts');
const {
  compareTableContract,
  normalizeContract,
  normalizeGenerationExpression
} = require('../src/migrations/schemaInspector');

const backendRoot = path.resolve(__dirname, '..');

test('migration catalog discovers strict filenames in stable version order', () => {
  const migrations = loadMigrations();
  assert.deepEqual(
    migrations.map(({ version, name }) => ({ version, name })),
    [
      {
        version: '202607240001',
        name: 'phase_4b_4c_live_control'
      },
      {
        version: '202607240002',
        name: 'live_events_received_at_index'
      },
      {
        version: '202607240003',
        name: 'phase_4i_song_request_experience'
      },
      {
        version: '202607240004',
        name: 'phase_4j_obs_overlays'
      },
      {
        version: '202607240005',
        name: 'six_role_rbac'
      },
      {
        version: '202607240006',
        name: 'viewer_identity_sync'
      },
      {
        version: '202607240007',
        name: 'official_live_ai'
      }
    ]
  );
  const migration = migrations[0];
  assert.deepEqual(migration.tables, [
    'live_events',
    'live_sessions',
    'song_requests',
    'song_request_history',
    'song_aliases'
  ]);
  assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  assert.equal(loadMigration().checksum, migration.checksum);
  assert.equal(
    migration.checksum,
    'e7293401bb94ce288014621019a961dd538936b249eed8feb34d6b0388c61166'
  );
  assert.deepEqual(migrations[1].depends_on, ['202607240001']);
  assert.deepEqual(migrations[1].indexes, [{
    table: 'live_events',
    name: 'idx_live_event_received',
    unique: false,
    columns: ['received_at', 'id']
  }]);
  assert.deepEqual(migrations[2].depends_on, [
    '202607240001',
    '202607240002'
  ]);
  assert.deepEqual(migrations[2].tables, [
    'song_request_policies',
    'song_request_details'
  ]);
  assert.deepEqual(
    migrations[2].indexes.map(({ table, name }) => `${table}.${name}`),
    [
      'user_bilibili_bindings.unique_bound_open_id',
      'song_aliases.unique_song_alias_normalized',
      'song_aliases.unique_song_alias_script'
    ]
  );
  assert.deepEqual(migrations[3].depends_on, ['202607240003']);
  assert.deepEqual(migrations[3].tables, ['obs_overlay_events']);
  assert.deepEqual(migrations[4].depends_on, ['202607240004']);
  assert.equal(migrations[4].schema_change, 'users_role');
  assert.deepEqual(migrations[4].tables, []);
  assert.deepEqual(migrations[4].indexes, []);
});

test('migration discovery rejects invalid SQL filenames and missing contracts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-r4-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, '202607240010_synthetic_index.sql'),
    'SELECT 1;\n'
  );
  fs.writeFileSync(path.join(directory, 'unsafe migration.sql'), 'SELECT 1;\n');
  const contracts = {
    '202607240010': {
      name: 'synthetic_index',
      kind: 'indexes',
      depends_on: [],
      tables: [],
      indexes: []
    }
  };
  assert.throws(
    () => loadMigrations({ directory, contracts }),
    (error) => error.code === 'migration_filename_invalid'
  );

  fs.rmSync(path.join(directory, 'unsafe migration.sql'));
  assert.equal(loadMigrations({ directory, contracts }).length, 1);
  assert.throws(
    () => loadMigrations({ directory, contracts: {} }),
    (error) => error.code === 'migration_contract_missing_or_mismatched'
  );
});

test('forward migration is additive and creates exactly the five target tables', () => {
  const { sql } = loadMigration();
  const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1]);
  assert.deepEqual(names, MIGRATION.tables);
  assert.doesNotMatch(
    sql,
    /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+[`a-z0-9_]+\s+SET|REPLACE\s+INTO)\b/i
  );
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
});

test('Phase 4I migration remains additive and partial-rerun safe', () => {
  const migration = loadMigrations()[2];
  assert.doesNotMatch(
    migration.sql,
    /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+DATABASE)\b/i
  );
  assert.doesNotMatch(migration.sql, /ALTER\s+TABLE\s+song_requests\b/i);
  assert.equal(
    [...migration.sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
      .map((match) => match[1])
      .join(','),
    migration.tables.join(',')
  );
  assert.equal(
    (migration.sql.match(/FROM information_schema\.(?:COLUMNS|STATISTICS)/g) || []).length,
    4
  );
  assert.equal(
    (migration.sql.match(/PREPARE phase4i_statement FROM @phase4i_sql/g) || []).length,
    4
  );
});

test('Phase 4I migration rejects cross-song alias collisions before DDL', async () => {
  const migration = loadMigrations()[2];
  const queries = [];
  await assert.rejects(
    assertMigrationDataPreconditions({
      async query(sql) {
        queries.push(sql);
        if (queries.length === 1) return [[{ present: 1 }]];
        return [[{ collision: 1 }]];
      }
    }, migration),
    (error) => (
      error instanceof MigrationError
      && error.code === 'migration_song_alias_collision'
      && error.details[0] === 'song_aliases.normalized_alias'
    )
  );
  assert.equal(queries.length, 2);
  assert.match(queries[1], /HAVING COUNT\(DISTINCT song_id\) > 1/);
  assert.doesNotMatch(queries[1], /\b(?:ALTER|CREATE|DROP|UPDATE|DELETE|INSERT)\b/i);
});

test('Phase 4I migration permits a legacy preflight before song_aliases exists', async () => {
  const migration = loadMigrations()[2];
  const queries = [];
  await assertMigrationDataPreconditions({
    async query(sql) {
      queries.push(sql);
      return [[]];
    }
  }, migration);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /information_schema\.TABLES/);
});

test('six-role migration maps only legacy roles and finishes with the exact enum', () => {
  const migration = loadMigrations()[4];
  assert.match(migration.sql, /UPDATE users SET role = 'fan_club' WHERE role = 'user'/);
  assert.match(migration.sql, /UPDATE users SET role = 'streamer' WHERE role = 'premium'/);
  assert.match(
    migration.sql,
    /ENUM\(''fan_club'',''captain'',''admiral'',''governor'',''streamer'',''admin''\)/
  );
  assert.match(migration.sql, /COLLATION_NAME/);
  assert.equal(
    (migration.sql.match(/CHARACTER SET utf8mb4 COLLATE/g) || []).length,
    2
  );
  assert.doesNotMatch(
    migration.sql,
    /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM|ALTER\s+DATABASE)\b/i
  );
});

test('six-role preflight fails closed when an unknown role is present', async () => {
  const migration = loadMigrations()[4];
  await assert.rejects(
    assertMigrationDataPreconditions({
      async query(sql, parameters) {
        assert.match(sql, /role NOT IN/);
        assert.deepEqual(parameters, [
          'user',
          'premium',
          'admin',
          'fan_club',
          'captain',
          'admiral',
          'governor',
          'streamer'
        ]);
        return [[{ role: 'unknown', count: 1 }]];
      }
    }, migration),
    (error) => error instanceof MigrationError
      && error.code === 'migration_unknown_user_role'
  );
});

test('viewer identity migration extends the existing binding system without destructive SQL', () => {
  const migration = loadMigrations().find(({ version }) => version === '202607240006');
  assert.ok(migration);
  assert.equal(migration.schema_change, 'viewer_identity_sync');
  assert.deepEqual(migration.tables, ['viewer_identity_audit']);
  assert.match(migration.sql, /ALTER TABLE user_bilibili_bindings ADD COLUMN guard_level/i);
  assert.match(migration.sql, /identity_sync_status/i);
  assert.match(migration.sql, /manual_expires_at/i);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS viewer_identity_audit/i);
  assert.match(migration.sql, /information_schema\.COLUMNS/i);
  assert.doesNotMatch(migration.sql, /(?:^|;)\s*(?:DROP|TRUNCATE|DELETE)\b/im);
  assert.doesNotMatch(migration.sql, /(?:cookie|token|password|credential)/i);
});

test('contracts cover 22 legacy and eleven additive target tables', () => {
  assert.equal(legacyTables.length, 22);
  assert.equal(new Set(legacyTables).size, 22);
  assert.deepEqual(Object.keys(targetContracts), [
    'official_live_event_dedup',
    'official_ai_memory',
    ...MIGRATION.tables,
    'song_request_policies',
    'song_request_details',
    'obs_overlay_events',
    'viewer_identity_audit'
  ]);
  assert.deepEqual(Object.keys(migrationContracts), [
    '202607240001',
    '202607240002',
    '202607240003',
    '202607240004',
    '202607240005',
    '202607240006',
    '202607240007'
  ]);
  assert.equal(ledgerContract.indexes.some(({ name }) => name === 'PRIMARY'), true);
});

test('official live migration stores only irreversible keys and bounded AI memory', () => {
  const migration = loadMigrations().find(
    ({ version }) => version === '202607240007'
  );
  assert.ok(migration);
  assert.deepEqual(migration.tables, [
    'official_live_event_dedup',
    'official_ai_memory'
  ]);
  assert.match(migration.sql, /event_digest CHAR\(64\)/i);
  assert.match(migration.sql, /viewer_key CHAR\(64\)/i);
  assert.match(migration.sql, /content VARCHAR\(800\)/i);
  assert.match(migration.sql, /expires_at DATETIME\(3\)/i);
  assert.doesNotMatch(
    migration.sql,
    /open_id|union_id|bili_uid|nickname|avatar|payload|users|wallet|orders/i
  );
  assert.doesNotMatch(migration.sql, /(?:^|;)\s*(?:DROP|TRUNCATE|DELETE)\b/im);
});

test('schema contract comparison is strict for columns and indexes', () => {
  const expected = targetContracts.live_events;
  assert.deepEqual(normalizeContract(expected), normalizeContract(expected));
  assert.equal(compareTableContract(expected, expected).compatible, true);

  const changed = structuredClone(expected);
  changed.columns[1].type = 'varchar(254)';
  changed.indexes.pop();
  const comparison = compareTableContract(expected, changed);
  assert.equal(comparison.compatible, false);
  assert.ok(comparison.differences.some((item) => item.includes('columns[1].type')));
  assert.ok(comparison.differences.some((item) => item.includes('indexes.length')));
});

test('generated expression metadata is normalized without weakening its semantics', () => {
  assert.equal(
    normalizeGenerationExpression(
      "case when (`status` in (_utf8mb4\\'open\\',_utf8mb4\\'paused\\')) then 1 else NULL end"
    ),
    "casewhenstatusin'open','paused'then1elsenullend"
  );
});

test('migration configuration is explicit and never loads a dotenv file', () => {
  const config = readConfig({
    DB_HOST: '127.0.0.1',
    DB_PORT: '3307',
    DB_USER: 'synthetic',
    DB_PASSWORD: 'synthetic-secret',
    DB_NAME: 'synthetic_migration'
  });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3307);
  assert.equal(config.database, 'synthetic_migration');
  assert.throws(
    () => readConfig({ DB_HOST: '127.0.0.1', DB_USER: 'synthetic' }),
    (error) => error instanceof MigrationError && error.code === 'migration_config_missing'
  );
  assert.throws(
    () => readConfig({
      DB_HOST: '127.0.0.1',
      DB_USER: 'synthetic',
      DB_NAME: 'unsafe-name'
    }),
    (error) => error.code === 'migration_config_invalid_database'
  );

  const runnerSource = fs.readFileSync(
    path.join(backendRoot, 'src/migrations/migrationRunner.js'),
    'utf8'
  );
  const cliSource = fs.readFileSync(
    path.join(backendRoot, 'scripts/schema-migrate.js'),
    'utf8'
  );
  assert.doesNotMatch(`${runnerSource}\n${cliSource}`, /dotenv|src\/config\/database/);
});

test('ledger and backend startup contain no destructive or automatic migration hook', () => {
  assert.match(LEDGER_SQL, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.doesNotMatch(LEDGER_SQL, /\b(?:DROP|TRUNCATE|ALTER)\b/i);
  const serverSource = fs.readFileSync(path.join(backendRoot, 'src/server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /schema-migrate|migrationRunner|db:migrate/);
});

test('documented npm migration commands map to the explicit CLI', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')
  );
  assert.deepEqual(
    {
      status: packageJson.scripts['db:migrate:status'],
      preflight: packageJson.scripts['db:migrate:preflight'],
      apply: packageJson.scripts['db:migrate:apply'],
      postcheck: packageJson.scripts['db:migrate:postcheck']
    },
    {
      status: 'node scripts/schema-migrate.js status',
      preflight: 'node scripts/schema-migrate.js preflight',
      apply: 'node scripts/schema-migrate.js apply',
      postcheck: 'node scripts/schema-migrate.js postcheck'
    }
  );
});
