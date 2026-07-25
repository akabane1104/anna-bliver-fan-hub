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

test('official gift preserves units and remains explicitly unprocessed for points', () => {
  const source = translateOfficialCommand(giftCommand(), target);
  const mapped = mapSourceEvent(source.sourceEvent, listenerConfig);
  assert.deepEqual(mapped.event.payload, {
    gift_id: '100',
    gift_name: 'synthetic gift',
    gift_num: 2,
    paid: true,
    price: '1000',
    r_price: '2000',
    price_unit: 'bilibili_price',
    combo_gift: false,
    points_status: 'not_processed',
    points_reason: 'official_open_id_account_mapping_unavailable'
  });
  assert.equal(mapped.event.actor.union_id, 'synthetic-union-id-2');
  assert.equal('uid' in mapped.event.actor, false);
});

test('official combo gifts retain bounded combo metadata without creating points', () => {
  const command = giftCommand({ msgId: 'synthetic-combo-gift' });
  command.data.combo_gift = true;
  command.data.combo_info = {
    combo_base_num: 5,
    combo_count: 100,
    combo_id: 'synthetic-combo-1',
    combo_timeout: 3
  };
  const mapped = mapSourceEvent(
    translateOfficialCommand(command, target).sourceEvent,
    listenerConfig
  );
  assert.deepEqual(mapped.event.payload.combo_info, command.data.combo_info);
  assert.equal(mapped.event.payload.points_status, 'not_processed');
});

test('free gifts, duplicate IDs, uid zero, and equal display names remain safe', () => {
  const free = giftCommand({ msgId: 'synthetic-free-gift' });
  free.data.uid = 0;
  free.data.paid = false;
  free.data.price = 0;
  free.data.r_price = 0;
  free.data.uname = 'same-display-name';
  const first = mapSourceEvent(
    translateOfficialCommand(free, target).sourceEvent,
    listenerConfig
  );
  const second = mapSourceEvent(
    translateOfficialCommand(structuredClone(free), target).sourceEvent,
    listenerConfig
  );
  assert.deepEqual(first.event, second.event);
  assert.equal(first.event.payload.paid, false);
  assert.equal(first.event.payload.price, '0');
  assert.equal('uid' in first.event.actor, false);

  const other = structuredClone(free);
  other.data.msg_id = 'synthetic-free-gift-other-user';
  other.data.open_id = 'synthetic-open-id-other';
  other.data.union_id = '';
  const mappedOther = mapSourceEvent(
    translateOfficialCommand(other, target).sourceEvent,
    listenerConfig
  );
  assert.equal(mappedOther.event.actor.display_name, 'same-display-name');
  assert.notEqual(
    mappedOther.event.actor.open_id,
    first.event.actor.open_id
  );
  assert.equal('union_id' in mappedOther.event.actor, false);
});

test('invalid gift quantities, prices, and combo metadata fail closed', () => {
  const mutations = [
    (data) => { data.gift_num = 0; },
    (data) => { data.gift_num = -1; },
    (data) => { data.gift_num = 1000000001; },
    (data) => { data.price = -1; },
    (data) => { data.price = Number.MAX_SAFE_INTEGER + 1; },
    (data) => {
      data.combo_gift = true;
      delete data.combo_info;
    },
    (data) => {
      data.combo_gift = true;
      data.combo_info = {
        combo_base_num: 1,
        combo_count: 1,
        combo_id: '',
        combo_timeout: 3
      };
    }
  ];
  for (const mutate of mutations) {
    const command = giftCommand();
    mutate(command.data);
    assert.throws(
      () => translateOfficialCommand(command, target),
      { code: 'invalid_official_event' }
    );
  }
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
