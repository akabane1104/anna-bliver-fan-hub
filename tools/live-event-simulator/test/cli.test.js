const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '../src/cli.js');

function minimalEnvironment() {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP
  };
}

test('CLI dry-run validates all fixtures without a secret or HTTP connection', () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    'dry-run',
    '--scenario',
    'all',
    '--run-id',
    'cli-dry-run',
    '--json'
  ], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: minimalEnvironment(),
    timeout: 10000
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.scenario_count, 11);
  assert.equal(output.event_count, 16);
  assert.equal(output.http_requests, 0);
});

test('CLI refuses secret command-line arguments and remote URLs', () => {
  const secretArgument = spawnSync(process.execPath, [
    cliPath,
    'dry-run',
    '--secret',
    'must-not-appear',
    '--json'
  ], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: minimalEnvironment(),
    timeout: 10000
  });
  assert.equal(secretArgument.status, 1);
  assert.doesNotMatch(secretArgument.stdout, /must-not-appear/);
  assert.equal(JSON.parse(secretArgument.stdout).error_code, 'secret_argument_forbidden');

  const remote = spawnSync(process.execPath, [
    cliPath,
    'dry-run',
    '--base-url',
    'https://preview.chengzhisweety.com',
    '--json'
  ], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: minimalEnvironment(),
    timeout: 10000
  });
  assert.equal(remote.status, 1);
  assert.equal(JSON.parse(remote.stdout).error_code, 'remote_target_rejected');
});
