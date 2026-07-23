const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runDryRun } = require('../src/dryRun');
const { withNetworkGuard } = require('./helpers/networkGuard');

test('dry-run completes all synthetic lifecycle scenarios with zero external connections', async () => {
  const result = await withNetworkGuard(async (networkCalls) => {
    const value = await runDryRun();
    assert.deepEqual(networkCalls, []);
    return value;
  });
  assert.equal(result.scenario_count, 7);
  assert.equal(result.event_count, 8);
  assert.equal(result.bilibili_connections, 0);
  assert.equal(result.http_connections, 0);
  assert.equal(result.backend_connections, 0);
  assert.equal(result.mysql_connections, 0);
  assert.equal(result.queue_rejected, 1);
  assert.equal(result.reconnect_count, 1);
  assert.equal(result.state, 'stopped');
  assert.equal(result.queue_depth, 0);
});

test('dry-run CLI exits cleanly from an empty working directory without dotenv', () => {
  const cliPath = path.resolve(__dirname, '../src/cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'dry-run', '--json'], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.bilibili_connections, 0);
  assert.equal(output.http_connections, 0);
  assert.equal(output.mysql_connections, 0);
});
