const crypto = require('node:crypto');
const db = require('../config/database');
const {
  parseEventPayload
} = require('../schemas/obsOverlaySchemas');
const {
  defaultObsOverlayRealtime
} = require('./obsOverlayRealtime');

class ObsOverlayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function publicEvent(row) {
  return {
    publicId: row.public_id,
    sequence: String(row.sequence),
    eventType: row.event_type,
    source: row.source,
    payload: parsePayload(row.payload_json),
    displayDurationMs: Number(row.display_duration_ms),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    replayUntil: row.replay_until,
    dismissedAt: row.dismissed_at || null
  };
}

function createObsOverlayEventRepository({ pool = db } = {}) {
  return {
    async findBySourceKey(source, idempotencyKey) {
      const [rows] = await pool.query(
        `SELECT sequence, public_id, event_type, source, payload_json,
                display_duration_ms, idempotency_key, created_at, replay_until,
                dismissed_at
         FROM obs_overlay_events
         WHERE source = ? AND idempotency_key = ?
         LIMIT 1`,
        [source, idempotencyKey]
      );
      return rows[0] || null;
    },

    async create(input, actorUserId) {
      try {
        const [result] = await pool.query(
          `INSERT INTO obs_overlay_events (
             public_id, event_type, source, payload_json, display_duration_ms,
             idempotency_key, created_by_user_id, replay_until
           ) VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))`,
          [
            crypto.randomUUID(),
            input.eventType,
            input.source,
            JSON.stringify(input.payload),
            input.displayDurationMs,
            input.idempotencyKey,
            actorUserId || null,
            input.displayDurationMs * 1000
          ]
        );
        const [rows] = await pool.query(
          `SELECT sequence, public_id, event_type, source, payload_json,
                  display_duration_ms, idempotency_key, created_at, replay_until,
                  dismissed_at
           FROM obs_overlay_events
           WHERE sequence = ?`,
          [result.insertId]
        );
        return { row: rows[0], duplicate: false };
      } catch (error) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        const row = await this.findBySourceKey(input.source, input.idempotencyKey);
        if (!row) throw error;
        return { row, duplicate: true };
      }
    },

    async listActive(limit) {
      const [rows] = await pool.query(
        `SELECT sequence, public_id, event_type, source, payload_json,
                display_duration_ms, idempotency_key, created_at, replay_until,
                dismissed_at
         FROM obs_overlay_events
         WHERE dismissed_at IS NULL
           AND replay_until > UTC_TIMESTAMP(3)
         ORDER BY sequence ASC
         LIMIT ?`,
        [limit]
      );
      return rows;
    },

    async listRecent(limit) {
      const [rows] = await pool.query(
        `SELECT sequence, public_id, event_type, source, payload_json,
                display_duration_ms, idempotency_key, created_at, replay_until,
                dismissed_at
         FROM obs_overlay_events
         ORDER BY sequence DESC
         LIMIT ?`,
        [limit]
      );
      return rows;
    },

    async dismiss(publicId) {
      const [result] = await pool.query(
        `UPDATE obs_overlay_events
         SET dismissed_at = COALESCE(dismissed_at, UTC_TIMESTAMP(3))
         WHERE public_id = ?`,
        [publicId]
      );
      return result.affectedRows > 0;
    }
  };
}

function createObsOverlayEventService({
  repository = createObsOverlayEventRepository(),
  realtime = defaultObsOverlayRealtime
} = {}) {
  const service = {
    async create(input, actorUserId) {
      const sanitized = {
        ...input,
        payload: parseEventPayload(input.eventType, input.payload)
      };
      const result = await repository.create(sanitized, actorUserId);
      const event = publicEvent(result.row);
      if (!result.duplicate) realtime.publish('overlay_event_created');
      return { event, duplicate: result.duplicate };
    },

    async listActive(limit = 5) {
      return (await repository.listActive(limit)).map(publicEvent);
    },

    async listRecent(limit = 30) {
      return (await repository.listRecent(limit)).map(publicEvent);
    },

    async dismiss(publicId) {
      const dismissed = await repository.dismiss(publicId);
      if (!dismissed) {
        throw new ObsOverlayError(404, 'overlay_event_not_found', 'OBS event not found');
      }
      realtime.publish('overlay_event_dismissed');
    },

    async publishAiBubble({
      text,
      persona,
      idempotencyKey,
      displayDurationMs = 6000
    }) {
      return service.create({
        eventType: 'ai_bubble',
        source: 'ai',
        payload: { text, persona },
        displayDurationMs,
        idempotencyKey
      }, null);
    }
  };
  return service;
}

const defaultObsOverlayEventService = createObsOverlayEventService();

module.exports = {
  ObsOverlayError,
  createObsOverlayEventRepository,
  createObsOverlayEventService,
  defaultObsOverlayEventService,
  publicEvent
};
