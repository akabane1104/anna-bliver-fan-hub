const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OfficialEventProcessor
} = require('../src/officialEventProcessor');

function setup() {
  const digests = new Set();
  const aiCalls = [];
  const repository = {
    async recordEventDigest({ digest }) {
      if (digests.has(digest)) return false;
      digests.add(digest);
      return true;
    }
  };
  const processor = new OfficialEventProcessor({
    config: {
      eventHmacKey: 'synthetic-event-hmac-key-that-is-long-enough',
      eventDedupeTtlHours: 168
    },
    repository,
    aiAssistant: {
      async handleCommand(value) {
        aiCalls.push(value);
      },
      snapshot() {
        return { enabled: true };
      }
    }
  });
  return { aiCalls, digests, processor };
}

test('official msg_id is HMAC-deduplicated across reconnect replay', async () => {
  const { digests, processor } = setup();
  const event = {
    cmd: 'LIVE_OPEN_PLATFORM_LIKE',
    data: {
      msg_id: 'synthetic-message-id',
      open_id: 'synthetic-open-id',
      uname: 'synthetic-name'
    }
  };
  assert.equal((await processor.process(event)).status, 'processed');
  assert.equal((await processor.process(event)).status, 'duplicate');
  assert.equal(digests.size, 1);
  const [stored] = digests;
  assert.equal(stored.includes('synthetic-message-id'), false);
  assert.equal(stored.includes('synthetic-open-id'), false);
  assert.equal(processor.snapshot().duplicates, 1);
});

test('only AI-prefixed danmaku reaches AI and business effects remain zero', async () => {
  const { aiCalls, processor } = setup();
  await processor.process({
    cmd: 'LIVE_OPEN_PLATFORM_DM',
    data: {
      msg_id: 'dm-1',
      open_id: 'viewer-1',
      msg: '普通聊天'
    }
  });
  await processor.process({
    cmd: 'LIVE_OPEN_PLATFORM_DM',
    data: {
      msg_id: 'dm-2',
      open_id: 'viewer-1',
      msg: '!ai 测试'
    }
  });
  await processor.process({
    cmd: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
    data: {
      msg_id: 'gift-1',
      open_id: 'viewer-1',
      gift_name: 'synthetic'
    }
  });
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].text, '!ai 测试');
  assert.equal(processor.snapshot().business_effects, 0);
});

test('unknown command is counted without retaining its payload', async () => {
  const { processor } = setup();
  const result = await processor.process({
    cmd: 'SYNTHETIC_UNKNOWN',
    data: { msg_id: 'unknown-1', sensitive: 'not-stored' }
  });
  assert.deepEqual(result, { status: 'processed', eventType: 'unknown' });
  assert.equal(processor.snapshot().unknown, 1);
});
