const { listenerError } = require('./errors');

const SUPPORTED_COMMANDS = Object.freeze({
  LIVE_OPEN_PLATFORM_DM: 'danmaku',
  LIVE_OPEN_PLATFORM_SEND_GIFT: 'gift'
});
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeInteger(value, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  code = 'invalid_official_event'
} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw listenerError(code);
  }
  return value;
}

function safeText(value, {
  minBytes = 1,
  maxBytes,
  code = 'invalid_official_event'
}) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < minBytes ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\u0000')
  ) {
    throw listenerError(code);
  }
  return value;
}

function safeIdentifier(value, code = 'invalid_official_event') {
  if (typeof value !== 'string' || !SOURCE_ID_PATTERN.test(value)) {
    throw listenerError(code);
  }
  return value;
}

function timestampToIso(value) {
  const seconds = safeInteger(value, {
    min: 1,
    max: Math.floor(8640000000000000 / 1000)
  });
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw listenerError('invalid_official_event');
  return date.toISOString();
}

function assertRoom(data, expectedRoomId) {
  const roomId = String(safeInteger(data?.room_id, { min: 1 }));
  if (roomId !== expectedRoomId) throw listenerError('official_event_room_mismatch');
}

function actorFromData(data) {
  const openId = safeText(data?.open_id, {
    maxBytes: 128
  });
  if (/[\s\u0000-\u001f\u007f]/.test(openId)) {
    throw listenerError('invalid_official_event');
  }
  const displayName = typeof data?.uname === 'string' && data.uname
    ? safeText(data.uname, { maxBytes: 300 })
    : undefined;
  return Object.freeze({
    open_id: openId,
    ...(displayName === undefined ? {} : { display_name: displayName })
  });
}

function translateOfficialCommand(message, {
  roomId,
  gameId
}) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    typeof message.cmd !== 'string'
  ) {
    throw listenerError('invalid_official_event');
  }
  const kind = SUPPORTED_COMMANDS[message.cmd];
  if (!kind) {
    return Object.freeze({
      status: 'ignored',
      reason: message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END'
        ? 'official_interaction_end'
        : 'unsupported_official_command'
    });
  }
  const data = message.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw listenerError('invalid_official_event');
  }
  assertRoom(data, roomId);
  const providerEventId = safeIdentifier(data.msg_id, 'unstable_provider_event_id');
  const occurredAt = timestampToIso(data.timestamp);
  const common = {
    provider: 'bilibili',
    provider_event_id: providerEventId,
    room_id: roomId,
    session_id: safeIdentifier(gameId),
    occurred_at: occurredAt,
    received_at: occurredAt,
    actor: actorFromData(data)
  };

  if (kind === 'danmaku') {
    const dmType = safeInteger(data.dm_type, { min: 0, max: 1 });
    return Object.freeze({
      status: 'mapped',
      sourceEvent: Object.freeze({
        ...common,
        kind,
        data: Object.freeze({
          text: safeText(data.msg, { maxBytes: 1500 }),
          dm_type: dmType === 1 ? 'emoji' : 'text'
        })
      })
    });
  }

  return Object.freeze({
    status: 'mapped',
    sourceEvent: Object.freeze({
      ...common,
      kind,
      data: Object.freeze({
        gift_id: String(safeInteger(data.gift_id, { min: 1 })),
        gift_name: safeText(data.gift_name, { maxBytes: 300 }),
        gift_num: safeInteger(data.gift_num, {
          min: 1,
          max: 1000000000
        }),
        paid: typeof data.paid === 'boolean'
          ? data.paid
          : (() => { throw listenerError('invalid_official_event'); })(),
        price: String(safeInteger(data.price)),
        r_price: String(safeInteger(data.r_price))
      })
    })
  });
}

module.exports = {
  SOURCE_ID_PATTERN,
  SUPPORTED_COMMANDS,
  actorFromData,
  safeIdentifier,
  timestampToIso,
  translateOfficialCommand
};
