const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  installShutdownHandlers,
  main,
  parseArguments
} = require('../src/cli');
const { withNetworkGuard } = require('./helpers/networkGuard');

function outputCollector() {
  let value = '';
  return {
    stream: { write(chunk) { value += chunk; } },
    read() { return value; }
  };
}

test('CLI accepts only service, explicit-source start, dry-run, and json', () => {
  assert.deepEqual(parseArguments(['dry-run']), {
    mode: 'dry-run',
    json: false,
    source: null
  });
  assert.deepEqual(parseArguments(['dry-run', '--json']), {
    mode: 'dry-run',
    json: true,
    source: null
  });
  assert.deepEqual(parseArguments(['service', '--json']), {
    mode: 'service',
    json: true,
    source: null
  });
  assert.deepEqual(
    parseArguments(['start', '--source=bilibili-official']),
    {
      mode: 'start',
      json: false,
      source: 'bilibili-official'
    }
  );
  assert.throws(() => parseArguments(['run']), { code: 'invalid_listener_mode' });
  assert.throws(() => parseArguments(['dry-run', '--fixture', 'external.json']), {
    code: 'invalid_argument'
  });
  assert.throws(() => parseArguments(['dry-run', '--json', '--json']), {
    code: 'duplicate_argument'
  });
});

test('CLI explicitly rejects secrets and bypass switches', () => {
  for (const args of [
    ['dry-run', '--secret', 'hidden'],
    ['dry-run', '--secret=hidden'],
    ['dry-run', '--allow-remote'],
    ['dry-run', '--force-remote'],
    ['dry-run', '--insecure']
  ]) {
    assert.throws(
      () => parseArguments(args),
      { code: args[1].startsWith('--secret')
        ? 'secret_argument_forbidden'
        : 'invalid_argument' }
    );
  }
});

test('production start without an explicit source fails before network', async () => {
  const output = outputCollector();
  const code = await withNetworkGuard(async (networkCalls) => {
    const result = await main(['start', '--json'], {
      stdout: output.stream
    });
    assert.deepEqual(networkCalls, []);
    return result;
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output.read()), {
    status: 'failed',
    error_code: 'invalid_argument'
  });
});

test('SIGINT, SIGTERM, and explicit invocation share one idempotent shutdown', async () => {
  const processLike = new EventEmitter();
  processLike.exitCode = 0;
  let calls = 0;
  const handlers = installShutdownHandlers({
    processLike,
    async shutdown() {
      calls += 1;
    }
  });
  processLike.emit('SIGINT');
  processLike.emit('SIGTERM');
  await handlers.invoke(0);
  assert.equal(calls, 1);
  assert.equal(processLike.exitCode, 130);
  handlers.dispose();
});

test('uncaught exceptions and unhandled rejections use the same safe shutdown', async () => {
  for (const eventName of ['uncaughtException', 'unhandledRejection']) {
    const processLike = new EventEmitter();
    processLike.exitCode = 0;
    let calls = 0;
    const handlers = installShutdownHandlers({
      processLike,
      async shutdown() {
        calls += 1;
      }
    });
    processLike.emit(eventName, new Error('synthetic private failure'));
    await handlers.invoke(0);
    assert.equal(calls, 1);
    assert.equal(processLike.exitCode, 1);
    handlers.dispose();
  }
});
