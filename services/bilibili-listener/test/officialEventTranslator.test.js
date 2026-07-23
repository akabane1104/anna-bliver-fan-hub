const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSourceEvent } = require('../src/eventMapper');
const {
  translateOfficialCommand
} = require('../src/officialEventTranslator');
const {
  danmakuCommand,
  giftCommand
} = require('./helpers/fakeOfficial');

const target = {
  roomId: '123456',
  gameId: 'synthetic-game-1'
};
const listenerConfig = {
  roomId: '123456',
  siteId: 'synthetic-site',
  instanceId: 'synthetic-instance',
  eventMode: 'simulation'
};

test('official DM maps through the existing Backend schema with stable msg_id', () => {
  const source = translateOfficialCommand(danmakuCommand({
    message: '\u70b9\u6b4c \u5e74\u8f6e'
  }), target);
  const first = mapSourceEvent(source.sourceEvent, listenerConfig);
  const second = mapSourceEvent(source.sourceEvent, listenerConfig);
  assert.equal(first.status, 'mapped');
  assert.equal(first.event.event_id, 'bilibili:123456:synthetic-dm-1');
  assert.equal(first.event.payload.text, '\u70b9\u6b4c \u5e74\u8f6e');
  assert.equal(first.event.actor.open_id, 'synthetic-open-id-1');
  assert.deepEqual(first.event, second.event);
  assert.equal(first.event.received_at, first.event.occurred_at);
});

test('official gift preserves raw official units and creates no points fields', () => {
  const source = translateOfficialCommand(giftCommand(), target);
  const mapped = mapSourceEvent(source.sourceEvent, listenerConfig);
  assert.deepEqual(mapped.event.payload, {
    gift_id: '100',
    gift_name: 'synthetic gift',
    gift_num: 2,
    paid: true,
    price: '1000',
    r_price: '2000',
    price_unit: 'bilibili_price'
  });
  assert.equal(JSON.stringify(mapped.event).includes('point'), false);
});

test('unsupported commands are ignored while malformed and wrong-room events reject', () => {
  assert.deepEqual(
    translateOfficialCommand({
      cmd: 'LIVE_OPEN_PLATFORM_LIKE',
      data: { synthetic: true }
    }, target),
    { status: 'ignored', reason: 'unsupported_official_command' }
  );
  assert.throws(
    () => translateOfficialCommand(danmakuCommand({ roomId: 123457 }), target),
    { code: 'official_event_room_mismatch' }
  );
  const missingId = danmakuCommand();
  delete missingId.data.msg_id;
  assert.throws(
    () => translateOfficialCommand(missingId, target),
    { code: 'unstable_provider_event_id' }
  );
});
