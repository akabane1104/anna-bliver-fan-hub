const database = require('../config/database');
const {
  createLiveEventReference
} = require('../utils/liveEventReference');
const { SongRequestError } = require('../utils/songRequestError');

const LISTENER_AVAILABILITY = new Set([
  'available',
  'disabled',
  'not_configured',
  'blocked',
  'unavailable'
]);
const LISTENER_STATES = new Set([
  'idle',
  'starting',
  'connecting',
  'connected',
  'backing_off',
  'stopping',
  'stopped',
  'fatal',
  'unknown'
]);
const CONNECTION_STATES = new Set([
  'connected',
  'connecting',
  'disconnected',
  'blocked',
  'unavailable',
  'unknown'
]);

function asIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asSafeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeReasonCode(value, fallback = null) {
  const normalized = String(value || '');
  return /^[a-z0-9_]{1,80}$/.test(normalized) ? normalized : fallback;
}

function safeTarget(siteId, roomId) {
  return {
    site_id: siteId,
    room_id: roomId,
    display_name: `${siteId} / 房间 ${roomId}`
  };
}

function publicSessionStatus(row) {
  return {
    public_id: row.public_id,
    title: row.title,
    status: row.status,
    target: safeTarget(row.site_id, row.room_id),
    started_at: asIsoString(row.started_at),
    ended_at: asIsoString(row.ended_at),
    last_event_at: asIsoString(row.last_event_at),
    saved_event_count: asSafeCount(row.saved_event_count),
    queue: {
      needs_match: asSafeCount(row.needs_match_count),
      queued: asSafeCount(row.queued_count),
      active: asSafeCount(row.active_count),
      total_current: (
        asSafeCount(row.needs_match_count) +
        asSafeCount(row.queued_count) +
        asSafeCount(row.active_count)
      )
    }
  };
}

function defaultListenerStatus() {
  return {
    availability: 'unavailable',
    enabled: null,
    configured: null,
    blocked: null,
    adapter_state: 'unknown',
    last_state_change_at: null,
    last_event_received_at: null,
    reason_code: 'listener_status_not_reported',
    retry_count: 0,
    reconnect_count: 0,
    bilibili_api_state: 'unknown',
    bilibili_wss_state: 'unknown'
  };
}

function sanitizeListenerStatus(value) {
  const fallback = defaultListenerStatus();
  if (!value || typeof value !== 'object') return fallback;
  return {
    availability: LISTENER_AVAILABILITY.has(value.availability)
      ? value.availability
      : fallback.availability,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : null,
    configured: typeof value.configured === 'boolean' ? value.configured : null,
    blocked: typeof value.blocked === 'boolean' ? value.blocked : null,
    adapter_state: LISTENER_STATES.has(value.adapter_state)
      ? value.adapter_state
      : 'unknown',
    last_state_change_at: asIsoString(value.last_state_change_at),
    last_event_received_at: asIsoString(value.last_event_received_at),
    reason_code: safeReasonCode(value.reason_code, fallback.reason_code),
    retry_count: asSafeCount(value.retry_count),
    reconnect_count: asSafeCount(value.reconnect_count),
    bilibili_api_state: CONNECTION_STATES.has(value.bilibili_api_state)
      ? value.bilibili_api_state
      : 'unknown',
    bilibili_wss_state: CONNECTION_STATES.has(value.bilibili_wss_state)
      ? value.bilibili_wss_state
      : 'unknown'
  };
}

function listenerStatusWithTimeout(provider, timeoutMs) {
  let timeout;
  return Promise.race([
    Promise.resolve().then(provider),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({
        ...defaultListenerStatus(),
        reason_code: 'listener_status_timeout'
      }), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function toMysqlUtcDateTime(value) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function eventContent(eventType) {
  switch (eventType) {
    case 'danmaku':
      return { summary: '弹幕消息', text: null };
    case 'gift':
      return { summary: '礼物事件', text: null };
    case 'super_chat':
      return { summary: '醒目留言', text: null };
    case 'guard_buy':
      return { summary: '大航海购买', text: null };
    case 'like':
      return { summary: '点赞事件', text: null };
    case 'room_enter':
      return { summary: '进入直播间', text: null };
    case 'live_start':
      return { summary: '直播开始', text: null };
    case 'live_end':
      return { summary: '直播结束', text: null };
    default:
      return { summary: '直播事件', text: null };
  }
}

function publicEvent(row, filteredSession = null, { eventReferenceSecret } = {}) {
  const content = eventContent(row.event_type);
  const sessionPublicId = row.session_public_id || filteredSession?.public_id || null;
  return {
    event_ref: createLiveEventReference(row, eventReferenceSecret),
    event_type: row.event_type,
    source: {
      mode: row.mode,
      command: row.source_cmd
    },
    target: safeTarget(row.site_id, row.room_id),
    session: sessionPublicId
      ? {
        public_id: sessionPublicId,
        title: row.session_title || filteredSession?.title || null
      }
      : null,
    actor_display_name: row.actor_display_name || null,
    occurred_at: asIsoString(row.occurred_at),
    received_at: asIsoString(row.received_at),
    content,
    processing: {
      status: row.status,
      reason_code: null,
      completed_at: asIsoString(row.created_at)
    },
    song_request: row.request_public_id
      ? {
        public_id: row.request_public_id,
        requested_title: row.requested_title,
        matched_song_title: row.song_title || null,
        status: row.request_status,
        match_method: row.match_method,
        queue_assigned: row.request_session_id !== null
      }
      : null
  };
}

function sessionOption(row) {
  return {
    public_id: row.public_id,
    title: row.title,
    status: row.status,
    target: safeTarget(row.site_id, row.room_id),
    started_at: asIsoString(row.started_at),
    ended_at: asIsoString(row.ended_at)
  };
}

function createLiveAdminRepository({ pool = database } = {}) {
  return {
    async ping() {
      await pool.query('SELECT 1 AS ok');
      return true;
    },

    async listActiveSessions() {
      const [rows] = await pool.query(
        `WITH active_sessions AS (
           SELECT id, public_id, site_id, room_id, title, status,
                  started_at, ended_at, created_at
           FROM live_sessions
           WHERE status IN ('open','paused')
           ORDER BY started_at DESC, id DESC
           LIMIT 100
         ),
         event_aggregate AS (
           SELECT active.id AS session_id,
                  MAX(le.received_at) AS last_event_at,
                  COUNT(le.id) AS saved_event_count
           FROM active_sessions active
           LEFT JOIN live_events le
             ON le.site_id = active.site_id
            AND le.room_id = active.room_id
            AND le.occurred_at >= COALESCE(active.started_at, active.created_at)
            AND (active.ended_at IS NULL OR le.occurred_at <= active.ended_at)
           GROUP BY active.id
         ),
         request_aggregate AS (
           SELECT sr.session_id,
                  SUM(sr.status = 'needs_match') AS needs_match_count,
                  SUM(sr.status = 'queued') AS queued_count,
                  SUM(sr.status = 'active') AS active_count
           FROM song_requests sr
           JOIN active_sessions active ON active.id = sr.session_id
           WHERE sr.status IN ('needs_match','queued','active')
           GROUP BY sr.session_id
         )
         SELECT active.public_id, active.site_id, active.room_id, active.title,
                active.status, active.started_at, active.ended_at,
                events.last_event_at, events.saved_event_count,
                COALESCE(requests.needs_match_count, 0) AS needs_match_count,
                COALESCE(requests.queued_count, 0) AS queued_count,
                COALESCE(requests.active_count, 0) AS active_count
         FROM active_sessions active
         LEFT JOIN event_aggregate events ON events.session_id = active.id
         LEFT JOIN request_aggregate requests ON requests.session_id = active.id
         ORDER BY active.started_at DESC, active.id DESC`
      );
      return rows;
    },

    async getIngestionSummary() {
      const [[row]] = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM live_events) AS total_saved,
           (
             SELECT received_at
             FROM live_events
             ORDER BY received_at DESC, id DESC
             LIMIT 1
           ) AS last_event_at,
           (
             SELECT COUNT(*)
             FROM live_events
             WHERE received_at >= UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE
           ) AS recent_event_count`
      );
      return row;
    },

    async findSession(publicId) {
      const [rows] = await pool.query(
        `SELECT public_id, site_id, room_id, title, status,
                started_at, ended_at, created_at
         FROM live_sessions
         WHERE public_id = ?
         LIMIT 1`,
        [publicId]
      );
      return rows[0] || null;
    },

    async listSessionOptions() {
      const [rows] = await pool.query(
        `SELECT public_id, site_id, room_id, title, status, started_at, ended_at
         FROM live_sessions
         ORDER BY COALESCE(started_at, created_at) DESC, id DESC
         LIMIT 100`
      );
      return rows;
    },

    async listEvents(input, filteredSession = null) {
      const conditions = [];
      const params = [];
      if (input.query) {
        const pattern = `%${escapeLike(input.query)}%`;
        conditions.push(`(
          COALESCE(le.actor_display_name, '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(le.normalized_payload, '$.text')), '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(le.normalized_payload, '$.message')), '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(le.normalized_payload, '$.gift_name')), '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(le.normalized_payload, '$.title')), '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(sr.requested_title, '') LIKE ? ESCAPE '\\\\' OR
          COALESCE(s.title, '') LIKE ? ESCAPE '\\\\'
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
      }
      if (input.event_type) {
        conditions.push('le.event_type = ?');
        params.push(input.event_type);
      }
      if (input.status) {
        conditions.push('le.status = ?');
        params.push(input.status);
      }
      if (input.source) {
        conditions.push('le.mode = ?');
        params.push(input.source);
      }
      if (input.start) {
        conditions.push('le.received_at >= ?');
        params.push(toMysqlUtcDateTime(input.start));
      }
      if (input.end) {
        conditions.push('le.received_at <= ?');
        params.push(toMysqlUtcDateTime(input.end));
      }
      if (filteredSession) {
        conditions.push('le.site_id = ? AND le.room_id = ?');
        params.push(filteredSession.site_id, filteredSession.room_id);
        conditions.push('le.occurred_at >= COALESCE(?, ?)');
        params.push(filteredSession.started_at, filteredSession.created_at);
        if (filteredSession.ended_at) {
          conditions.push('le.occurred_at <= ?');
          params.push(filteredSession.ended_at);
        }
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const joins = `
        LEFT JOIN song_requests sr ON sr.source_event_id = le.event_id
        LEFT JOIN live_sessions ls ON ls.id = sr.session_id
        LEFT JOIN songs s ON s.id = sr.matched_song_id
      `;
      const [[countRow]] = await pool.query(
        `SELECT COUNT(DISTINCT le.id) AS count
         FROM live_events le
         ${joins}
         ${where}`,
        params
      );
      const offset = (input.page - 1) * input.limit;
      const [rows] = await pool.query(
        `SELECT le.id, le.content_hash, le.event_type, le.site_id, le.room_id,
                le.mode, le.source_cmd, le.actor_display_name, le.occurred_at,
                le.received_at, le.status, le.created_at,
                sr.public_id AS request_public_id, sr.requested_title,
                sr.status AS request_status, sr.match_method,
                sr.session_id AS request_session_id,
                ls.public_id AS session_public_id, ls.title AS session_title,
                s.title AS song_title
         FROM live_events le
         ${joins}
         ${where}
         ORDER BY le.received_at DESC, le.id DESC
         LIMIT ? OFFSET ?`,
        [...params, input.limit, offset]
      );
      return {
        rows,
        total: asSafeCount(countRow.count)
      };
    }
  };
}

function createLiveAdminService({
  repository = createLiveAdminRepository(),
  listenerStatusProvider = async () => defaultListenerStatus(),
  listenerStatusTimeoutMs = 300,
  eventReferenceSecret = process.env.LIVE_EVENT_REF_SECRET,
  clock = () => new Date()
} = {}) {
  return {
    async getStatus() {
      const serverTime = clock().toISOString();
      const [databaseResult, sessionsResult, ingestionResult, listenerResult] = await Promise.allSettled([
        repository.ping(),
        repository.listActiveSessions(),
        repository.getIngestionSummary(),
        listenerStatusWithTimeout(listenerStatusProvider, listenerStatusTimeoutMs)
      ]);
      const databaseAvailable = databaseResult.status === 'fulfilled';
      const sessions = sessionsResult.status === 'fulfilled'
        ? sessionsResult.value.map(publicSessionStatus)
        : [];
      const listener = listenerResult.status === 'fulfilled'
        ? sanitizeListenerStatus(listenerResult.value)
        : defaultListenerStatus();
      const ingestion = ingestionResult.status === 'fulfilled'
        ? {
          status: 'available',
          total_saved: asSafeCount(ingestionResult.value.total_saved),
          recent_event_count: asSafeCount(ingestionResult.value.recent_event_count),
          last_event_at: asIsoString(ingestionResult.value.last_event_at)
        }
        : {
          status: 'unavailable',
          total_saved: null,
          recent_event_count: null,
          last_event_at: null
        };
      const partial = (
        !databaseAvailable ||
        sessionsResult.status !== 'fulfilled' ||
        ingestionResult.status !== 'fulfilled' ||
        listener.availability === 'unavailable'
      );
      return {
        completeness: partial ? 'partial' : 'complete',
        server_time: serverTime,
        updated_at: serverTime,
        backend: { status: 'available' },
        database: {
          status: databaseAvailable ? 'available' : 'unavailable'
        },
        sessions: {
          state: sessions.length === 0
            ? 'none'
            : (sessions.length === 1 ? 'active' : 'conflict'),
          active_count: sessions.length,
          items: sessions
        },
        listener,
        bilibili_connection: {
          api_state: listener.bilibili_api_state,
          wss_state: listener.bilibili_wss_state,
          authoritative: listener.availability === 'available'
        },
        ingestion
      };
    },

    async listEvents(input) {
      let filteredSession = null;
      if (input.session) {
        filteredSession = await repository.findSession(input.session);
        if (!filteredSession) {
          throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
        }
      }
      const [result, sessionRows] = await Promise.all([
        repository.listEvents(input, filteredSession),
        repository.listSessionOptions()
      ]);
      return {
        events: result.rows.map((row) => publicEvent(
          row,
          filteredSession,
          { eventReferenceSecret }
        )),
        filters: {
          session_options: sessionRows.map(sessionOption)
        },
        pagination: {
          page: input.page,
          limit: input.limit,
          total: result.total,
          totalPages: Math.max(1, Math.ceil(result.total / input.limit))
        },
        sort: ['received_at:desc', 'internal_stable_key:desc']
      };
    }
  };
}

const defaultLiveAdminService = createLiveAdminService();

module.exports = {
  createLiveAdminRepository,
  createLiveAdminService,
  defaultListenerStatus,
  defaultLiveAdminService,
  eventContent,
  publicEvent,
  sanitizeListenerStatus
};
