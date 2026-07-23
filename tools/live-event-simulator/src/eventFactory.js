const SYNTHETIC_SITE_PATTERN = /^phase4d-[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/;
const SYNTHETIC_ROOM_PATTERN = /^99[0-9]{18,30}$/;
const SYNTHETIC_RUN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function simulatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSyntheticConfig({ siteId, roomId, runId, fixture }) {
  if (!SYNTHETIC_SITE_PATTERN.test(siteId)) {
    throw simulatorError('unsafe_synthetic_site', 'site_id must use the phase4d- synthetic prefix');
  }
  if (!SYNTHETIC_ROOM_PATTERN.test(roomId)) {
    throw simulatorError('unsafe_synthetic_room', 'room_id must use the reserved Phase 4D test shape');
  }
  if (!SYNTHETIC_RUN_PATTERN.test(runId)) {
    throw simulatorError('invalid_run_id', 'run_id must be a short lowercase slug');
  }
  if (!/^phase4d-[A-Za-z0-9._:/-]{1,100}$/.test(fixture)) {
    throw simulatorError('unsafe_fixture', 'fixture must use the phase4d- synthetic prefix');
  }
}

function eventId(config, scenario, step) {
  return `phase4d.${config.runId}.${scenario}.${step}`;
}

function actor(config, actorKey = 'viewer-a') {
  return {
    open_id: `phase4d.synthetic.${config.runId}.${actorKey}`,
    display_name: `Synthetic ${actorKey}`
  };
}

function commonEvent({
  config,
  scenario,
  step,
  eventType,
  sourceCmd,
  actorKey,
  occurredAt,
  receivedAt
}) {
  assertSyntheticConfig(config);
  const id = eventId(config, scenario, step);
  const baseTime = occurredAt || config.now;
  const receivedTime = receivedAt || config.now;
  return {
    schema_version: '1.0',
    event_id: id,
    event_type: eventType,
    site_id: config.siteId,
    room_id: config.roomId,
    mode: 'simulation',
    source: {
      platform: 'bilibili_live_open',
      cmd: sourceCmd,
      message_id: `${id}:message`,
      session_id: config.fixture
    },
    actor: actor(config, actorKey),
    occurred_at: baseTime,
    received_at: receivedTime,
    delivery: {
      attempt: 1,
      replay: false,
      trace_id: `phase4d:${config.runId}:${scenario}:${step}`
    }
  };
}

function createDanmakuEvent(options) {
  return {
    ...commonEvent({
      ...options,
      eventType: 'danmaku',
      sourceCmd: 'LIVE_OPEN_PLATFORM_DM'
    }),
    payload: {
      text: options.text,
      dm_type: 'text'
    }
  };
}

function createGiftEvent(options) {
  return {
    ...commonEvent({
      ...options,
      eventType: 'gift',
      sourceCmd: 'LIVE_OPEN_PLATFORM_SEND_GIFT'
    }),
    payload: {
      gift_id: 'phase4d-synthetic-gift',
      gift_name: 'Synthetic Gift',
      gift_num: 1,
      paid: true,
      price: '1000',
      r_price: '1000',
      price_unit: 'bilibili_price'
    }
  };
}

module.exports = {
  SYNTHETIC_ROOM_PATTERN,
  SYNTHETIC_RUN_PATTERN,
  SYNTHETIC_SITE_PATTERN,
  assertSyntheticConfig,
  createDanmakuEvent,
  createGiftEvent,
  eventId
};
