const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const {
  ledgerContract,
  legacyTables,
  migrationContracts,
  targetContracts
} = require('./schemaContracts');
const {
  compareTableContract,
  inspectTables
} = require('./schemaInspector');

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '../../migrations');
const MIGRATION_FILE_PATTERN = /^(\d{12})_([a-z][a-z0-9_]*)\.sql$/;
const BASE_MIGRATION_VERSION = '202607240001';
const LEDGER_TABLE = 'schema_migrations';
const SUPPORTED_MYSQL_VERSION = /^8\.0(?:\.|$)/;
const REQUIRED_DATABASE_COLLATION = 'utf8mb4_unicode_ci';

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('applied') NOT NULL,
  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

class MigrationError extends Error {
  constructor(code, details = []) {
    super(code);
    this.name = 'MigrationError';
    this.code = code;
    this.details = Array.isArray(details) ? details : [String(details)];
  }
}

function loadMigrations({
  directory = MIGRATIONS_DIRECTORY,
  contracts = migrationContracts
} = {}) {
  const resolvedDirectory = path.resolve(directory);
  const sqlEntries = fs.readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith('.sql'));
  const migrations = [];
  const versions = new Set();

  for (const entry of sqlEntries) {
    if (!entry.isFile()) {
      throw new MigrationError('migration_catalog_invalid_entry', [entry.name]);
    }
    const match = entry.name.match(MIGRATION_FILE_PATTERN);
    if (!match) {
      throw new MigrationError('migration_filename_invalid', [entry.name]);
    }
    const [, version, name] = match;
    if (versions.has(version)) {
      throw new MigrationError('migration_version_duplicate', [`version=${version}`]);
    }
    versions.add(version);
    const contract = contracts[version];
    if (!contract || contract.name !== name) {
      throw new MigrationError('migration_contract_missing_or_mismatched', [
        `version=${version}`
      ]);
    }
    const file = path.resolve(resolvedDirectory, entry.name);
    if (path.dirname(file) !== resolvedDirectory) {
      throw new MigrationError('migration_path_invalid', [entry.name]);
    }
    const sql = fs.readFileSync(file, 'utf8');
    migrations.push({
      version,
      name,
      file,
      kind: contract.kind,
      depends_on: [...contract.depends_on],
      tables: [...contract.tables],
      indexes: contract.indexes.map((index) => ({
        ...index,
        columns: [...index.columns]
      })),
      sql,
      checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
    });
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version, 'en'));
  const discovered = new Set(migrations.map(({ version }) => version));
  const missing = Object.keys(contracts).filter((version) => !discovered.has(version));
  if (missing.length) {
    throw new MigrationError('migration_catalog_incomplete', missing);
  }
  const positions = new Map(
    migrations.map(({ version }, index) => [version, index])
  );
  for (const [index, migration] of migrations.entries()) {
    for (const dependency of migration.depends_on) {
      if (!positions.has(dependency) || positions.get(dependency) >= index) {
        throw new MigrationError('migration_dependency_invalid', [
          `version=${migration.version}`,
          `dependency=${dependency}`
        ]);
      }
    }
  }
  return migrations;
}

function loadMigration() {
  const migration = loadMigrations().find(
    ({ version }) => version === BASE_MIGRATION_VERSION
  );
  if (!migration) {
    throw new MigrationError('migration_base_missing');
  }
  return migration;
}

const MIGRATION = Object.freeze({
  version: BASE_MIGRATION_VERSION,
  name: migrationContracts[BASE_MIGRATION_VERSION].name,
  file: path.resolve(
    MIGRATIONS_DIRECTORY,
    `${BASE_MIGRATION_VERSION}_${migrationContracts[BASE_MIGRATION_VERSION].name}.sql`
  ),
  tables: migrationContracts[BASE_MIGRATION_VERSION].tables
});

function readConfig(env = process.env) {
  const required = ['DB_HOST', 'DB_USER', 'DB_NAME'];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new MigrationError('migration_config_missing', missing);
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationError('migration_config_invalid_port');
  }
  const database = String(env.DB_NAME).trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new MigrationError('migration_config_invalid_database');
  }
  return {
    host: String(env.DB_HOST).trim(),
    port,
    user: String(env.DB_USER).trim(),
    password: String(env.DB_PASSWORD || ''),
    database
  };
}

function lockName(databaseName) {
  const suffix = crypto.createHash('sha256').update(databaseName).digest('hex').slice(0, 24);
  return `anna-fan-hub:migrate:${suffix}`;
}

async function acquireMigrationLock(connection, databaseName) {
  const name = lockName(databaseName);
  const [[row]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
  if (Number(row.acquired) !== 1) throw new MigrationError('migration_lock_unavailable');
  return name;
}

async function releaseMigrationLock(connection, name) {
  if (!name) return;
  await connection.query('SELECT RELEASE_LOCK(?) AS released', [name]);
}

async function readDatabaseIdentity(connection, config) {
  const [[identity]] = await connection.query(
    'SELECT DATABASE() AS database_name, VERSION() AS mysql_version'
  );
  if (identity.database_name !== config.database) {
    throw new MigrationError('migration_database_mismatch', [
      `expected=${config.database}`,
      `connected=${identity.database_name || 'none'}`
    ]);
  }
  if (!SUPPORTED_MYSQL_VERSION.test(String(identity.mysql_version))) {
    throw new MigrationError('migration_mysql_version_unsupported', [
      `version=${identity.mysql_version}`
    ]);
  }
  const [[schema]] = await connection.query(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS charset_name,
            DEFAULT_COLLATION_NAME AS collation_name
     FROM information_schema.SCHEMATA
     WHERE SCHEMA_NAME = ?`,
    [config.database]
  );
  if (!schema || schema.charset_name !== 'utf8mb4'
      || schema.collation_name !== REQUIRED_DATABASE_COLLATION) {
    throw new MigrationError('migration_database_collation_incompatible', [
      `expected=utf8mb4/${REQUIRED_DATABASE_COLLATION}`,
      `found=${schema?.charset_name || 'missing'}/${schema?.collation_name || 'missing'}`
    ]);
  }
  return {
    database: identity.database_name,
    mysql_version: identity.mysql_version,
    charset: schema.charset_name,
    collation: schema.collation_name
  };
}

async function assertLegacyDependencies(connection, databaseName) {
  const placeholders = legacyTables.map(() => '?').join(', ');
  const [tableRows] = await connection.query(
    `SELECT TABLE_NAME AS table_name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN (${placeholders})`,
    [databaseName, ...legacyTables]
  );
  const present = new Set(tableRows.map((row) => row.table_name));
  const missing = legacyTables.filter((tableName) => !present.has(tableName));
  if (missing.length) throw new MigrationError('migration_legacy_tables_missing', missing);

  const [keyRows] = await connection.query(
    `SELECT TABLE_NAME AS table_name,
            COLUMN_NAME AS column_name,
            COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable,
            COLUMN_KEY AS column_key
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND (TABLE_NAME, COLUMN_NAME) IN (
         ('users', 'id'),
         ('playlists', 'id'),
         ('songs', 'id')
       )`,
    [databaseName]
  );
  const expected = new Map([
    ['users.id', 'int'],
    ['playlists.id', 'int'],
    ['songs.id', 'int']
  ]);
  const differences = [];
  for (const row of keyRows) {
    const key = `${row.table_name}.${row.column_name}`;
    expected.delete(key);
    if (String(row.column_type).toLowerCase() !== 'int'
        || row.is_nullable !== 'NO'
        || row.column_key !== 'PRI') {
      differences.push(`${key}: expected non-null INT primary key`);
    }
  }
  for (const key of expected.keys()) differences.push(`${key}: missing`);
  if (differences.length) {
    throw new MigrationError('migration_legacy_dependency_incompatible', differences);
  }
}

async function readLedgerRow(connection, ledgerExists, migration) {
  if (!ledgerExists) return null;
  const [rows] = await connection.query(
    `SELECT version, name, checksum, state, applied_at
     FROM schema_migrations
     WHERE version = ?`,
    [migration.version]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.checksum !== migration.checksum) {
    throw new MigrationError('migration_checksum_conflict', [
      `version=${migration.version}`
    ]);
  }
  if (row.name !== migration.name || row.state !== 'applied') {
    throw new MigrationError('migration_ledger_entry_incompatible', [
      `version=${migration.version}`
    ]);
  }
  return row;
}

function knownAdditiveIndexes(tableName) {
  return Object.values(migrationContracts)
    .flatMap((contract) => contract.indexes)
    .filter((index) => index.table === tableName);
}

function tableForBaseContract(tableName, structure) {
  if (!structure) return structure;
  const expectedNames = new Set(
    targetContracts[tableName].indexes.map(({ name }) => name)
  );
  const allowedIndexes = knownAdditiveIndexes(tableName);
  return {
    ...structure,
    indexes: structure.indexes.filter(
      (index) => expectedNames.has(index.name)
        || !allowedIndexes.some((allowed) => (
          index.name === allowed.name || sameIndexShape(index, allowed)
        ))
    )
  };
}

function sameIndexShape(left, right) {
  return Boolean(left)
    && left.unique === right.unique
    && left.columns.length === right.columns.length
    && left.columns.every((columnName, index) => columnName === right.columns[index]);
}

function inspectIndexStates(migration, structures) {
  const states = {};
  const incompatible = [];
  for (const expected of migration.indexes) {
    const key = `${expected.table}.${expected.name}`;
    const structure = structures[expected.table];
    if (!structure) {
      states[key] = { state: 'pending_dependency' };
      continue;
    }
    const named = structure.indexes.find(({ name }) => name === expected.name);
    if (named) {
      if (sameIndexShape(named, expected)) {
        states[key] = { state: 'compatible', resolved_name: named.name };
      } else {
        states[key] = {
          state: 'incompatible',
          differences: ['index shape does not match the migration contract']
        };
        incompatible.push(`${key}: index shape does not match the migration contract`);
      }
      continue;
    }
    const equivalent = structure.indexes.find((index) => sameIndexShape(index, expected));
    states[key] = equivalent
      ? { state: 'equivalent', resolved_name: equivalent.name }
      : { state: 'missing' };
  }
  if (incompatible.length) {
    throw new MigrationError('migration_target_schema_incompatible', incompatible);
  }
  return states;
}

async function inspectMigrationState(connection, config, migration) {
  const indexTables = migration.indexes.map(({ table }) => table);
  const names = [...new Set([LEDGER_TABLE, ...migration.tables, ...indexTables])];
  const structures = await inspectTables(connection, config.database, names);
  const ledgerExists = Boolean(structures[LEDGER_TABLE]);
  if (ledgerExists) {
    const comparison = compareTableContract(ledgerContract, structures[LEDGER_TABLE]);
    if (!comparison.compatible) {
      throw new MigrationError(
        'migration_ledger_schema_incompatible',
        comparison.differences.map((item) => `${LEDGER_TABLE}.${item}`)
      );
    }
  }

  const tableStates = {};
  const incompatible = [];
  for (const tableName of migration.tables) {
    if (!structures[tableName]) {
      tableStates[tableName] = { state: 'missing' };
      continue;
    }
    const comparison = compareTableContract(
      targetContracts[tableName],
      tableForBaseContract(tableName, structures[tableName])
    );
    if (!comparison.compatible) {
      tableStates[tableName] = {
        state: 'incompatible',
        differences: comparison.differences
      };
      incompatible.push(...comparison.differences.map((item) => `${tableName}.${item}`));
    } else {
      tableStates[tableName] = { state: 'compatible' };
    }
  }
  if (incompatible.length) {
    throw new MigrationError('migration_target_schema_incompatible', incompatible);
  }
  const indexStates = inspectIndexStates(migration, structures);
  const ledgerRow = await readLedgerRow(connection, ledgerExists, migration);
  if (ledgerRow) {
    const missingTables = Object.entries(tableStates)
      .filter(([, value]) => value.state !== 'compatible')
      .map(([name]) => name);
    const missingIndexes = Object.entries(indexStates)
      .filter(([, value]) => !['compatible', 'equivalent'].includes(value.state))
      .map(([name]) => name);
    if (missingTables.length || missingIndexes.length) {
      throw new MigrationError(
        'migration_applied_schema_incomplete',
        [...missingTables, ...missingIndexes]
      );
    }
  }
  return {
    ledger_exists: ledgerExists,
    applied: Boolean(ledgerRow),
    table_states: tableStates,
    index_states: indexStates,
    structures
  };
}

async function assertMigrationDataPreconditions(connection, migration) {
  if (migration.version !== '202607240003') return;
  const [tables] = await connection.query(
    `SELECT 1 AS present
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'song_aliases'
     LIMIT 1`
  );
  if (!tables.length) return;

  for (const column of ['normalized_alias', 'script_key']) {
    const [rows] = await connection.query(
      `SELECT 1 AS collision
       FROM song_aliases
       WHERE ${column} IS NOT NULL AND ${column} <> ''
       GROUP BY ${column}
       HAVING COUNT(DISTINCT song_id) > 1
       LIMIT 1`
    );
    if (rows.length) {
      throw new MigrationError(
        'migration_song_alias_collision',
        [`song_aliases.${column}`]
      );
    }
  }
}

async function preflightOnConnection(connection, config, migration) {
  const identity = await readDatabaseIdentity(connection, config);
  await assertLegacyDependencies(connection, config.database);
  await assertMigrationDataPreconditions(connection, migration);
  const state = await inspectMigrationState(connection, config, migration);
  return {
    command: 'preflight',
    migration: {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum
    },
    database: identity,
    applied: state.applied,
    ledger_exists: state.ledger_exists,
    table_states: state.table_states,
    index_states: state.index_states
  };
}

async function postcheckOnConnection(connection, config, migration) {
  const identity = await readDatabaseIdentity(connection, config);
  await assertLegacyDependencies(connection, config.database);
  const state = await inspectMigrationState(connection, config, migration);
  if (!state.ledger_exists || !state.applied) {
    throw new MigrationError('migration_not_applied', [`version=${migration.version}`]);
  }
  return {
    command: 'postcheck',
    migration: {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum
    },
    database: identity,
    applied: true,
    table_states: state.table_states,
    index_states: state.index_states
  };
}

async function ensureLedger(connection, config) {
  await connection.query(LEDGER_SQL);
  const structures = await inspectTables(connection, config.database, [LEDGER_TABLE]);
  const comparison = compareTableContract(ledgerContract, structures[LEDGER_TABLE]);
  if (!comparison.compatible) {
    throw new MigrationError(
      'migration_ledger_schema_incompatible',
      comparison.differences.map((item) => `${LEDGER_TABLE}.${item}`)
    );
  }
}

async function applyOnConnection(connection, config, migration) {
  const before = await preflightOnConnection(connection, config, migration);
  if (before.applied) {
    const verified = await postcheckOnConnection(connection, config, migration);
    return { ...verified, command: 'apply', outcome: 'noop' };
  }

  await ensureLedger(connection, config);
  const missingTables = Object.entries(before.table_states)
    .filter(([, value]) => value.state === 'missing')
    .map(([name]) => name);
  const pendingDependencies = Object.entries(before.index_states)
    .filter(([, value]) => value.state === 'pending_dependency')
    .map(([name]) => name);
  if (pendingDependencies.length) {
    throw new MigrationError('migration_dependency_missing', pendingDependencies);
  }
  const missingIndexes = Object.entries(before.index_states)
    .filter(([, value]) => value.state === 'missing')
    .map(([name]) => name);
  if (missingTables.length || missingIndexes.length) {
    try {
      await connection.query(migration.sql);
    } catch (error) {
      throw new MigrationError('migration_apply_failed', [
        `mysql_code=${error.code || 'unknown'}`
      ]);
    }
  }

  const afterDdl = await inspectMigrationState(connection, config, migration);
  const incomplete = Object.entries(afterDdl.table_states)
    .filter(([, value]) => value.state !== 'compatible')
    .map(([name]) => name);
  const incompleteIndexes = Object.entries(afterDdl.index_states)
    .filter(([, value]) => !['compatible', 'equivalent'].includes(value.state))
    .map(([name]) => name);
  if (incomplete.length || incompleteIndexes.length) {
    throw new MigrationError(
      'migration_postcheck_failed',
      [...incomplete, ...incompleteIndexes]
    );
  }

  try {
    await connection.query(
      `INSERT INTO schema_migrations (version, name, checksum, state)
       VALUES (?, ?, ?, 'applied')`,
      [migration.version, migration.name, migration.checksum]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new MigrationError('migration_concurrent_ledger_conflict');
    }
    throw new MigrationError('migration_ledger_write_failed', [
      `mysql_code=${error.code || 'unknown'}`
    ]);
  }

  const verified = await postcheckOnConnection(connection, config, migration);
  return {
    ...verified,
    command: 'apply',
    outcome: (missingTables.length || missingIndexes.length) ? 'applied' : 'adopted',
    created_tables: missingTables,
    created_indexes: missingIndexes
  };
}

async function statusOnConnection(connection, config, migration) {
  const preflight = await preflightOnConnection(connection, config, migration);
  return { ...preflight, command: 'status' };
}

function createMigrationRunner(options = {}) {
  const env = options.env || process.env;
  const mysqlModule = options.mysql || mysql;
  const config = readConfig(env);
  const migrations = loadMigrations(options.catalog);

  function summarize(command, results) {
    const createdTables = results.flatMap((result) => result.created_tables || []);
    const createdIndexes = results.flatMap((result) => result.created_indexes || []);
    const outcomes = results.map(({ outcome }) => outcome).filter(Boolean);
    const tableStates = Object.assign({}, ...results.map(({ table_states }) => table_states));
    const indexStates = Object.assign({}, ...results.map(({ index_states }) => index_states));
    let outcome;
    if (command === 'apply') {
      if (outcomes.every((value) => value === 'noop')) outcome = 'noop';
      else if (outcomes.some((value) => value === 'applied')) outcome = 'applied';
      else outcome = 'adopted';
    }
    return {
      command,
      database: results[0]?.database || null,
      applied: results.every(({ applied }) => applied),
      ledger_exists: results.every(({ ledger_exists }) => ledger_exists !== false),
      ...(outcome ? { outcome } : {}),
      created_tables: createdTables,
      created_indexes: createdIndexes,
      table_states: tableStates,
      index_states: indexStates,
      migrations: results
    };
  }

  async function run(command) {
    if (!['status', 'preflight', 'apply', 'postcheck'].includes(command)) {
      throw new MigrationError('migration_command_invalid');
    }
    const connection = await mysqlModule.createConnection({
      ...config,
      multipleStatements: true,
      connectTimeout: 5000,
      supportBigNumbers: true,
      bigNumberStrings: true
    });
    let lock;
    try {
      lock = await acquireMigrationLock(connection, config.database);
      const results = [];
      for (const migration of migrations) {
        if (command === 'status') {
          results.push(await statusOnConnection(connection, config, migration));
        } else if (command === 'preflight') {
          results.push(await preflightOnConnection(connection, config, migration));
        } else if (command === 'apply') {
          results.push(await applyOnConnection(connection, config, migration));
        } else {
          results.push(await postcheckOnConnection(connection, config, migration));
        }
      }
      return summarize(command, results);
    } finally {
      try {
        await releaseMigrationLock(connection, lock);
      } finally {
        await connection.end();
      }
    }
  }

  return {
    config: { ...config, password: undefined },
    migration: migrations[0],
    migrations,
    run
  };
}

module.exports = {
  LEDGER_SQL,
  LEDGER_TABLE,
  MIGRATION,
  MigrationError,
  acquireMigrationLock,
  assertMigrationDataPreconditions,
  createMigrationRunner,
  loadMigration,
  loadMigrations,
  readConfig,
  releaseMigrationLock
};
