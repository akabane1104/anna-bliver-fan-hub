const test = require('node:test');
const assert = require('node:assert/strict');
const { BoundedEventQueue } = require('../src/eventQueue');
const { FakeTimers } = require('./helpers/fakeTimers');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('queue preserves FIFO order with conservative concurrency', async () => {
  const order = [];
  const queue = new BoundedEventQueue({
    maxLength: 5,
    concurrency: 1,
    handler: async (value) => order.push(value)
  });
  queue.start();
  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');
  assert.deepEqual(await queue.drain(500), { drained: true, remaining: 0 });
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('queue never exceeds configured delivery concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const started = [];
  const gates = [deferred(), deferred(), deferred()];
  const queue = new BoundedEventQueue({
    maxLength: 3,
    concurrency: 2,
    handler: async (index) => {
      started.push(index);
      active += 1;
      maximum = Math.max(maximum, active);
      await gates[index].promise;
      active -= 1;
    }
  });
  queue.start();
  queue.enqueue(0);
  queue.enqueue(1);
  queue.enqueue(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  gates[2].resolve();
  assert.equal((await queue.drain(500)).drained, true);
});

test('full queue rejects explicitly instead of silently dropping an event', async () => {
  const gate = deferred();
  const queue = new BoundedEventQueue({
    maxLength: 2,
    concurrency: 1,
    handler: async () => gate.promise
  });
  queue.start();
  const first = queue.enqueue('first');
  const second = queue.enqueue('second');
  const rejected = queue.enqueue('third');
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.deepEqual(rejected, { accepted: false, reason: 'queue_full' });
  gate.resolve();
  assert.equal((await queue.drain(500)).drained, true);
});

test('drain reports a bounded timeout and can complete after work is released', async () => {
  const timers = new FakeTimers();
  const gate = deferred();
  const queue = new BoundedEventQueue({
    maxLength: 1,
    concurrency: 1,
    handler: async () => gate.promise,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });
  queue.start();
  queue.enqueue('held');
  const waiting = queue.drain(5);
  await timers.advance(5);
  const timeout = await waiting;
  assert.equal(timeout.drained, false);
  assert.equal(timeout.remaining, 1);
  gate.resolve();
  await timers.flush();
  assert.equal((await queue.drain(500)).drained, true);
});

test('shutdown rejects new work and pending entries can be cancelled deterministically', async () => {
  const gate = deferred();
  const queue = new BoundedEventQueue({
    maxLength: 3,
    concurrency: 1,
    handler: async () => gate.promise
  });
  queue.start();
  queue.enqueue('active');
  const pending = queue.enqueue('pending');
  queue.stopAccepting();
  assert.deepEqual(
    queue.enqueue('late'),
    { accepted: false, reason: 'queue_stopped' }
  );
  assert.equal(queue.cancelPending(), 1);
  assert.deepEqual(await pending.completion, {
    status: 'cancelled',
    reason: 'queue_cancelled'
  });
  gate.resolve();
  assert.equal((await queue.drain(500)).drained, true);
});
