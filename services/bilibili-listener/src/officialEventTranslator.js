const { listenerError } = require('./errors');

const SUPPORTED_COMMANDS = Object.freeze({
  LIVE_OPEN_PLATFORM_DM: 'danmaku',
  LIVE_OPEN_PLATFORM_SEND_GIFT: 'gift',
  LIVE_OPEN_PLATFORM_LIVE_START: 'live_start',
  LIVE_OPEN_PLATFORM_LIVE_END: 'live_end',
  LIVE_OPEN_PLATFORM_GUARD: 'guard_buy'
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
  const unionId = typeof data?.union_id === 'string' && data.union_id
    ? safeText(data.union_id, { maxBytes: 128 })
    : undefined;
  if (unionId !== undefined && /[\s\u0000-\u001f\u007f]/.test(unionId)) {
    throw listenerError('invalid_official_event');
  }
  return Object.freeze({
    open_id: openId,
    ...(unionId === undefined ? {} : { union_id: unionId }),
    ...(displayName === undefined ? {} : { display_name: displayName })
  });
}

function optionalText(value, options) {
  if (value === undefined || value === null) return undefined;
  return safeText(value, { ...options, minBytes: 0 });
}

function liveStateProviderEventId(kind, roomId, timestamp) {
  return safeIdentifier(
    `${kind.replace('_', '-')}:${roomId}:${timestamp}`,
    'unstable_provider_event_id'
  );
}

function comboFromData(data) {
  if (data?.combo_gift === undefined || data.combo_gift === false) {
    return Object.freeze({ combo_gift: false });
  }
  if (data.combo_gift !== true) throw listenerError('invalid_official_event');
  const combo = data.combo_info;
  if (!combo || typeof combo !== 'object' || Array.isArray(combo)) {
    throw listenerError('invalid_official_event');
  }
  return Object.freeze({
    combo_gift: true,
    combo_info: Object.freeze({
      combo_base_num: safeInteger(combo.combo_base_num, {
        min: 1,
        max: 1000000000
      }),
      combo_count: safeInteger(combo.combo_count, {
        min: 1,
        max: 1000000000
      }),
      combo_id: safeIdentifier(combo.combo_id),
      combo_timeout: safeInteger(combo.combo_timeout, {
        min: 0,
        max: 86400
      })
    })
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
  const occurredAt = timestampToIso(data.timestamp);
  const providerEventId = ['live_start', 'live_end'].includes(kind)
    ? liveStateProviderEventId(kind, roomId, data.timestamp)
    : safeIdentifier(data.msg_id, 'unstable_provider_event_id');
  const actor = ['live_start', 'live_end'].includes(kind)
    ? null
    : (kind === 'guard_buy' ? actorFromData(data.user_info) : actorFromData(data));
  const common = {
    provider: 'bilibili',
    provider_event_id: providerEventId,
    room_id: roomId,
    session_id: safeIdentifier(gameId),
    occurred_at: occurredAt,
    received_at: occurredAt,
    actor
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

  if (kind === 'live_start' || kind === 'live_end') {
    const title = optionalText(data.title, { maxBytes: 600 });
    const areaName = optionalText(data.area_name, { maxBytes: 300 });
    return Object.freeze({
      status: 'mapped',
      sourceEvent: Object.freeze({
        ...common,
        kind,
        data: Object.freeze({
          ...(title === undefined ? {} : { title }),
          ...(areaName === undefined ? {} : { area_name: areaName })
        })
      })
    });
  }

  if (kind === 'guard_buy') {
    return Object.freeze({
      status: 'mapped',
      sourceEvent: Object.freeze({
        ...common,
        kind,
        data: Object.freeze({
          guard_level: String(safeInteger(data.guard_level, {
            min: 1,
            max: 3
          })),
          guard_num: safeInteger(data.guard_num, {
            min: 1,
            max: 1000000
          }),
          guard_unit: safeText(data.guard_unit, { maxBytes: 90 }),
          price: String(safeInteger(data.price))
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
        r_price: String(safeInteger(data.r_price)),
        ...comboFromData(data)
      })
    })
  });
}

module.exports = {
  SOURCE_ID_PATTERN,
  SUPPORTED_COMMANDS,
  actorFromData,
  comboFromData,
  liveStateProviderEventId,
  optionalText,
  safeIdentifier,
  timestampToIso,
  translateOfficialCommand
};
