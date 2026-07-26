const { EventEmitter } = require('node:events');
const {
  OPERATIONS,
  encodePacket,
  parsePackets
} = require('../../src/officialProtocol');

class FakeWebSocket extends EventEmitter {
  constructor({
    autoOpen = true,
    authCode = 0,
    failBeforeOpen = false,
    replyToHeartbeat = true
  } = {}) {
    super();
    this.autoOpen = autoOpen;
    this.authCode = authCode;
    this.failBeforeOpen = failBeforeOpen;
    this.replyToHeartbeat = replyToHeartbeat;
    this.readyState = 0;
    this.sent = [];
    this.closeCount = 0;
    if (autoOpen) {
      setImmediate(() => {
        if (failBeforeOpen) {
          this.emit('error', new Error('synthetic websocket failure'));
          return;
        }
        this.readyState = 1;
        this.emit('open', {});
      });
    }
  }

  addEventListener(name, handler) {
    this.on(name, handler);
  }

  removeEventListener(name, handler) {
    this.off(name, handler);
  }

  send(value) {
    const data = Buffer.from(value);
    this.sent.push(data);
    const [packet] = parsePackets(data);
    if (packet.operation === OPERATIONS.AUTH) {
      setImmediate(() => this.receive(encodePacket({
        operation: OPERATIONS.AUTH_REPLY,
        body: Buffer.from(JSON.stringify({ code: this.authCode }))
      })));
    }
    if (packet.operation === OPERATIONS.HEARTBEAT && this.replyToHeartbeat) {
      setImmediate(() => this.receive(encodePacket({
        operation: OPERATIONS.HEARTBEAT_REPLY,
        body: Buffer.alloc(4)
      })));
    }
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
  }

  receive(data) {
    this.emit('message', { data });
  }

  remoteClose(code = 1006) {
    this.readyState = 3;
    this.emit('close', { code });
  }

  remoteError() {
    this.emit('error', new Error('synthetic websocket error'));
  }
}

function validStartData({
  roomId = 123456,
  gameId = 'synthetic-game-1',
  links = ['wss://synthetic-unverified.invalid/unverified']
} = {}) {
  return {
    game_info: { game_id: gameId },
    websocket_info: {
      auth_body: '{"key":"synthetic-auth-body"}',
      wss_link: links
    },
    anchor_info: { room_id: roomId }
  };
}

function officialResponse(data = {}, {
  code = 0,
  message = 'success',
  requestId = 'synthetic-request-id',
  status = 200
} = {}) {
  return new Response(JSON.stringify({
    code,
    message,
    request_id: requestId,
    data
  }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function danmakuCommand({
  msgId = 'synthetic-dm-1',
  roomId = 123456,
  message = 'synthetic danmaku'
} = {}) {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_DM',
    data: {
      room_id: roomId,
      open_id: 'synthetic-open-id-1',
      uname: 'synthetic-user',
      msg: message,
      msg_id: msgId,
      dm_type: 0,
      timestamp: 1700000000
    }
  };
}

function giftCommand({
  msgId = 'synthetic-gift-1',
  roomId = 123456
} = {}) {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
    data: {
      room_id: roomId,
      open_id: 'synthetic-open-id-2',
      union_id: 'synthetic-union-id-2',
      uname: 'synthetic-gift-user',
      gift_id: 100,
      gift_name: 'synthetic gift',
      gift_num: 2,
      price: 1000,
      r_price: 2000,
      paid: true,
      combo_gift: false,
      msg_id: msgId,
      timestamp: 1700000001
    }
  };
}

function liveStartCommand({
  roomId = 123456,
  timestamp = 1700000002,
  title = 'synthetic live title',
  areaName = 'synthetic area'
} = {}) {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_LIVE_START',
    data: {
      room_id: roomId,
      timestamp,
      area_name: areaName,
      title
    }
  };
}

function liveEndCommand({
  roomId = 123456,
  timestamp = 1700000003,
  title = 'synthetic live title',
  areaName = 'synthetic area'
} = {}) {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_LIVE_END',
    data: {
      room_id: roomId,
      timestamp,
      area_name: areaName,
      title
    }
  };
}

function guardCommand({
  msgId = 'synthetic-guard-1',
  roomId = 123456,
  guardLevel = 3,
  guardNum = 1,
  guardUnit = '\u6708',
  price = 198000
} = {}) {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_GUARD',
    data: {
      user_info: {
        uid: 0,
        open_id: 'synthetic-guard-open-id',
        union_id: 'synthetic-guard-union-id',
        uname: 'synthetic-guard-user',
        uface: 'https://example.invalid/avatar.png'
      },
      guard_level: guardLevel,
      guard_num: guardNum,
      guard_unit: guardUnit,
      price,
      room_id: roomId,
      msg_id: msgId,
      timestamp: 1700000004
    }
  };
}

module.exports = {
  FakeWebSocket,
  danmakuCommand,
  giftCommand,
  guardCommand,
  liveEndCommand,
  liveStartCommand,
  officialResponse,
  validStartData
};
