const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  acquireInstanceLock
} = require('../src/instanceLock');

test('shared data directory permits only one listener instance', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-lock-'));
  try {
    const first = await acquireInstanceLock(dataDir, {
      platform: 'win32'
    });
    await assert.rejects(
      () => acquireInstanceLock(dataDir, { platform: 'win32' }),
      { code: 'listener_instance_already_running' }
    );
    await first.release();

    const replacement = await acquireInstanceLock(dataDir, {
      platform: 'win32'
    });
    await replacement.release();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
