const crypto = require('node:crypto');
const {
  validateLiveEvent
} = require('../../../backend/src/schemas/liveEventSchema');
const { listenerError } = require('./errors');

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const SOURCE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]+$/;

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
  if (!['danmaku', 'gift'].includes(sourceEvent.kind)) {
    return Object.freeze({
      status: 'ignored',
      reason: 'unsupported_source_event'
    });
  }

  const eventId = stableEventId(sourceEvent);
  const replay = sourceEvent.replay === true;
  const common = {
    schema_version: '1.0',
    event_id: eventId,
    event_type: sourceEvent.kind,
    site_id: config.siteId,
    room_id: config.roomId,
    mode: replay ? 'replay' : config.eventMode,
    source: {
      platform: 'bilibili_live_open',
      cmd: sourceEvent.kind === 'danmaku'
        ? 'LIVE_OPEN_PLATFORM_DM'
        : 'LIVE_OPEN_PLATFORM_SEND_GIFT',
      message_id: sourceEvent.provider_event_id,
      session_id: sourceEvent.session_id
    },
    actor: actorFromSource(sourceEvent),
    occurred_at: sourceEvent.occurred_at,
    received_at: sourceEvent.received_at,
    delivery: {
      attempt: 1,
      replay,
      trace_id: `listener:${config.instanceId}:${eventFingerprint(eventId)}`
    }
  };

  const event = sourceEvent.kind === 'danmaku'
    ? {
      ...common,
      payload: {
        text: sourceEvent.data?.text,
        ...(sourceEvent.data?.dm_type
          ? { dm_type: sourceEvent.data.dm_type }
          : {})
      }
    }
    : {
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
        price_unit: 'bilibili_price'
      }
    };

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
  SOURCE_IDENTIFIER_PATTERN,
  assertCommonSourceEvent,
  eventFingerprint,
  mapSourceEvent,
  stableEventId
};
