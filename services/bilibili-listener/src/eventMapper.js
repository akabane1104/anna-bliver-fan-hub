const crypto = require('node:crypto');
const {
  validateLiveEvent
} = require('../../../backend/src/schemas/liveEventSchema');
const { listenerError } = require('./errors');

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const SOURCE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const SOURCE_COMMANDS = Object.freeze({
  danmaku: 'LIVE_OPEN_PLATFORM_DM',
  gift: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
  live_start: 'LIVE_OPEN_PLATFORM_LIVE_START',
  live_end: 'LIVE_OPEN_PLATFORM_LIVE_END',
  guard_buy: 'LIVE_OPEN_PLATFORM_GUARD'
});

function isIsoDateTime(value) {
  if (typeof value !== 'string' || !value.includes('T')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function assertSafeIdentifier(value, maxLength = 128) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    SOURCE_IDENTIFIER_PATTERN.test(value)
  );
}

function assertCommonSourceEvent(sourceEvent, config) {
  if (!sourceEvent || typeof sourceEvent !== 'object' || Array.isArray(sourceEvent)) {
    throw listenerError('invalid_source_event');
  }
  if (!PROVIDER_PATTERN.test(String(sourceEvent.provider || ''))) {
    throw listenerError('invalid_source_event');
  }
  if (!assertSafeIdentifier(sourceEvent.provider_event_id)) {
    throw listenerError('unstable_provider_event_id');
  }
  if (sourceEvent.room_id !== config.roomId) {
    throw listenerError('source_target_mismatch');
  }
  if (!assertSafeIdentifier(sourceEvent.session_id, 255)) {
    throw listenerError('invalid_source_event');
  }
  if (!isIsoDateTime(sourceEvent.occurred_at) || !isIsoDateTime(sourceEvent.received_at)) {
    throw listenerError('invalid_source_event');
  }
  if (sourceEvent.provider === 'synthetic' && sourceEvent.synthetic !== true) {
    throw listenerError('invalid_source_event');
  }
}

function actorFromSource(sourceEvent) {
  const actor = sourceEvent.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw listenerError('invalid_source_event');
  }
  return {
    open_id: actor.open_id,
    ...(actor.union_id === undefined
      ? {}
      : { union_id: actor.union_id }),
    ...(actor.display_name === undefined
      ? {}
      : { display_name: actor.display_name })
  };
}

function stableEventId(sourceEvent) {
  const value = `${sourceEvent.provider}:${sourceEvent.room_id}:${sourceEvent.provider_event_id}`;
  if (value.length > 255 || !SOURCE_IDENTIFIER_PATTERN.test(value)) {
    throw listenerError('invalid_event_id');
  }
  return value;
}

function eventFingerprint(eventId) {
  return crypto.createHash('sha256').update(eventId, 'utf8').digest('hex').slice(0, 16);
}

function mapSourceEvent(sourceEvent, config, {
  validator = validateLiveEvent
} = {}) {
  assertCommonSourceEvent(sourceEvent, config);
  if (!Object.hasOwn(SOURCE_COMMANDS, sourceEvent.kind)) {
    return Object.freeze({
      status: 'ignored',
      reason: 'unsupported_source_event'
    });
  }

  const eventId = stableEventId(sourceEvent);
  const replay = sourceEvent.replay === true;
  const source = {
    platform: 'bilibili_live_open',
    cmd: SOURCE_COMMANDS[sourceEvent.kind],
    ...(['live_start', 'live_end'].includes(sourceEvent.kind)
      ? {}
      : { message_id: sourceEvent.provider_event_id }),
    session_id: sourceEvent.session_id
  };
  const actor = ['live_start', 'live_end'].includes(sourceEvent.kind)
    && sourceEvent.actor === null
    ? null
    : actorFromSource(sourceEvent);
  const common = {
    schema_version: '1.0',
    event_id: eventId,
    event_type: sourceEvent.kind,
    site_id: config.siteId,
    room_id: config.roomId,
    mode: replay ? 'replay' : config.eventMode,
    source,
    actor,
    occurred_at: sourceEvent.occurred_at,
    received_at: sourceEvent.received_at,
    delivery: {
      attempt: 1,
      replay,
      trace_id: `listener:${config.instanceId}:${eventFingerprint(eventId)}`
    }
  };

  let event;
  if (sourceEvent.kind === 'danmaku') {
    event = {
      ...common,
      payload: {
        text: sourceEvent.data?.text,
        ...(sourceEvent.data?.dm_type
          ? { dm_type: sourceEvent.data.dm_type }
          : {})
      }
    };
  } else if (sourceEvent.kind === 'gift') {
    event = {
      ...common,
      payload: {
        gift_id: sourceEvent.data?.gift_id,
        gift_name: sourceEvent.data?.gift_name,
        gift_num: sourceEvent.data?.gift_num,
        paid: sourceEvent.data?.paid,
        price: sourceEvent.data?.price,
        ...(sourceEvent.data?.r_price === undefined
          ? {}
          : { r_price: sourceEvent.data.r_price }),
        price_unit: 'bilibili_price',
        combo_gift: sourceEvent.data?.combo_gift === true,
        ...(sourceEvent.data?.combo_gift === true
          ? { combo_info: sourceEvent.data.combo_info }
          : {}),
        points_status: 'not_processed',
        points_reason: 'official_open_id_account_mapping_unavailable'
      }
    };
  } else if (sourceEvent.kind === 'guard_buy') {
    event = {
      ...common,
      payload: {
        guard_level: sourceEvent.data?.guard_level,
        guard_num: sourceEvent.data?.guard_num,
        guard_unit: sourceEvent.data?.guard_unit,
        price: sourceEvent.data?.price,
        price_unit: 'bilibili_guard_price'
      }
    };
  } else {
    event = {
      ...common,
      payload: {
        ...(sourceEvent.data?.title === undefined
          ? {}
          : { title: sourceEvent.data.title }),
        ...(sourceEvent.data?.area_name === undefined
          ? {}
          : { area_name: sourceEvent.data.area_name })
      }
    };
  }

  const validation = validator(event);
  if (!validation.success) throw listenerError('invalid_source_event');
  return Object.freeze({
    status: 'mapped',
    event: validation.data,
    eventFingerprint: eventFingerprint(eventId)
  });
}

module.exports = {
  PROVIDER_PATTERN,
  SOURCE_COMMANDS,
  SOURCE_IDENTIFIER_PATTERN,
  assertCommonSourceEvent,
  eventFingerprint,
  mapSourceEvent,
  stableEventId
};
