const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LEDGER_SQL,
  MIGRATION,
  MigrationError,
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

test('contracts cover 22 legacy and five target tables', () => {
  assert.equal(legacyTables.length, 22);
  assert.equal(new Set(legacyTables).size, 22);
  assert.deepEqual(Object.keys(targetContracts), MIGRATION.tables);
  assert.deepEqual(Object.keys(migrationContracts), [
    '202607240001',
    '202607240002'
  ]);
  assert.equal(ledgerContract.indexes.some(({ name }) => name === 'PRIMARY'), true);
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
