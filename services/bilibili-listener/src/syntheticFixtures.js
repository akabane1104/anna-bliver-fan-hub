const SYNTHETIC_ROOM_ID = '99000000000000000002';
const SYNTHETIC_SITE_ID = 'phase4e-synthetic';
const SYNTHETIC_INSTANCE_ID = 'phase4e-dry-run';
const SYNTHETIC_SESSION_ID = 'phase4e-synthetic-session';
const SYNTHETIC_TIME = '2026-07-23T09:00:00.000Z';

function commonSourceEvent(providerEventId, kind) {
  return {
    synthetic: true,
    provider: 'synthetic',
    provider_event_id: providerEventId,
    kind,
    room_id: SYNTHETIC_ROOM_ID,
    session_id: SYNTHETIC_SESSION_ID,
    actor: {
      open_id: `phase4e.synthetic.${providerEventId}`,
      display_name: 'Synthetic Listener Viewer'
    },
    occurred_at: SYNTHETIC_TIME,
    received_at: SYNTHETIC_TIME,
    data: {}
  };
}

function syntheticDanmaku(providerEventId, text = '点歌 年轮') {
  return {
    ...commonSourceEvent(providerEventId, 'danmaku'),
    data: {
      text,
      dm_type: 'text'
    }
  };
}

function syntheticGift(providerEventId) {
  return {
    ...commonSourceEvent(providerEventId, 'gift'),
    data: {
      gift_id: 'phase4e-synthetic-gift',
      gift_name: 'Synthetic Gift',
      gift_num: 1,
      paid: true,
      price: '1000',
      r_price: '1000'
    }
  };
}

function syntheticUnsupported(providerEventId) {
  return commonSourceEvent(providerEventId, 'synthetic_unsupported');
}

function syntheticInvalid() {
  const event = syntheticDanmaku('phase4e-invalid-source');
  delete event.provider_event_id;
  return event;
}

module.exports = {
  SYNTHETIC_INSTANCE_ID,
  SYNTHETIC_ROOM_ID,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_SITE_ID,
  SYNTHETIC_TIME,
  syntheticDanmaku,
  syntheticGift,
  syntheticInvalid,
  syntheticUnsupported
};
