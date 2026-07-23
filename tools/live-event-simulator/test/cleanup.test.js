const test = require('node:test');
const assert = require('node:assert/strict');
const { createCleanupCoordinator } = require('./helpers/cleanupCoordinator');

test('cleanup is idempotent and continues after an individual action fails', async () => {
  const calls = [];
  const cleanup = createCleanupCoordinator([
    async () => {
      calls.push('first');
      throw new Error('synthetic cleanup failure');
    },
    async () => {
      calls.push('second');
    }
  ]);

  const firstRun = cleanup();
  const secondRun = cleanup();
  assert.strictEqual(secondRun, firstRun);

  const errors = await firstRun;
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'synthetic cleanup failure');
});
