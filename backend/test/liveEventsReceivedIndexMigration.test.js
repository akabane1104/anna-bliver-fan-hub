const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const migrationsDirectory = path.join(backendRoot, 'migrations');
const baseMigrationPath = path.join(
  migrationsDirectory,
  '202607240001_phase_4b_4c_live_control.sql'
);

test('next additive migration covers received_at ordering with the stable id key', () => {
  const migrationFiles = fs.readdirSync(migrationsDirectory)
    .filter((name) => /^\d{12}_[a-z][a-z0-9_]*\.sql$/.test(name))
    .sort();
  assert.deepEqual(migrationFiles, [
    '202607240001_phase_4b_4c_live_control.sql',
    '202607240002_live_events_received_at_index.sql'
  ]);

  const sql = fs.readFileSync(
    path.join(migrationsDirectory, migrationFiles[1]),
    'utf8'
  );
  assert.match(
    sql,
    /ALTER\s+TABLE\s+live_events\s+ADD\s+INDEX\s+idx_live_event_received\s+\(received_at,\s*id\)/i
  );
  assert.doesNotMatch(
    sql,
    /\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|REPLACE|RENAME)\b/i
  );
  const baseSql = fs.readFileSync(baseMigrationPath, 'utf8');
  assert.doesNotMatch(
    baseSql,
    /INDEX\s+\w+\s+\(received_at,\s*id\)/i
  );
});
