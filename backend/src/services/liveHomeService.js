const database = require('../config/database');
const { runInTransaction } = require('../utils/databaseTransaction');
const { SongRequestError } = require('../utils/songRequestError');

const SETTING_KEYS = Object.freeze({
  overrideMode: 'live_home_override_mode',
  overrideExpiresAt: 'live_home_override_expires_at',
  overrideUpdatedBy: 'live_home_override_updated_by',
  overrideUpdatedAt: 'live_home_override_updated_at',
  songRequestsOpen: 'live_home_song_requests_open',
  songRequestsUpdatedBy: 'live_home_song_requests_updated_by',
  songRequestsUpdatedAt: 'live_home_song_requests_updated_at',
  activityEnabled: 'live_home_activity_enabled',
  activityTitle: 'live_home_activity_title',
  activityContent: 'live_home_activity_content',
  activityStartsAt: 'live_home_activity_starts_at',
  activityEndsAt: 'live_home_activity_ends_at',
  activityUpdatedBy: 'live_home_activity_updated_by',
  activityUpdatedAt: 'live_home_activity_updated_at',
  officialState: 'live_home_official_state',
  officialEventAt: 'live_home_official_event_at',
  transportState: 'live_home_transport_state',
  transportReportedAt: 'live_home_transport_reported_at',
  transportReportId: 'live_home_transport_report_id',
  transportAuthenticated: 'live_home_transport_authenticated'
});

const LIVE_FRESH_MS = 30_000;
const LIVE_GRACE_MS = 90_000;
const SETTING_NAMES = Object.freeze(Object.values(SETTING_KEYS));
const GUARD_TIERS = Object.freeze({
  '1': '总督',
  '2': '提督',
  '3': '舰长'
});

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMysqlUtcDateTime(value) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function parseBoolean(value, fallback = false) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function sanitizePublicText(value, fallback, maxLength) {
  return String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength) || fallback;
}

function publicSong(row) {
  if (!row) return null;
  return {
    title: row.song_title || row.requested_title || '未命名歌曲',
    artist: row.song_artist || null
  };
}

function currentActivity(settings, nowMs) {
  if (!parseBoolean(settings.get(SETTING_KEYS.activityEnabled))) return null;
  const startsAt = toIso(settings.get(SETTING_KEYS.activityStartsAt));
  const endsAt = toIso(settings.get(SETTING_KEYS.activityEndsAt));
  if (startsAt && nowMs < new Date(startsAt).getTime()) return null;
  if (endsAt && nowMs >= new Date(endsAt).getTime()) return null;
  const title = String(settings.get(SETTING_KEYS.activityTitle) || '').trim();
  const content = String(settings.get(SETTING_KEYS.activityContent) || '').trim();
  if (!title || !content) return null;
  return {
    title,
    content,
    starts_at: startsAt,
    ends_at: endsAt
  };
}

function resolveLiveMode(settings, nowMs) {
  const overrideMode = settings.get(SETTING_KEYS.overrideMode) || 'auto';
  const overrideExpiresAt = toIso(settings.get(SETTING_KEYS.overrideExpiresAt));
  const overrideActive = (
    ['force_live', 'force_offline'].includes(overrideMode) &&
    overrideExpiresAt &&
    new Date(overrideExpiresAt).getTime() > nowMs
  );
  if (overrideActive) {
    return {
      mode: overrideMode === 'force_live' ? 'live' : 'offline',
      source: 'manual_override',
      syncing: false
    };
  }

  const officialState = settings.get(SETTING_KEYS.officialState) || 'unknown';
  if (officialState === 'offline') {
    return { mode: 'offline', source: 'official_live_end', syncing: false };
  }
  if (officialState !== 'live') {
    return { mode: 'offline', source: 'no_trusted_signal', syncing: false };
  }

  const transportAt = toIso(settings.get(SETTING_KEYS.transportReportedAt));
  const transportAge = transportAt
    ? Math.max(0, nowMs - new Date(transportAt).getTime())
    : Number.POSITIVE_INFINITY;
  const transportState = settings.get(SETTING_KEYS.transportState) || 'unavailable';
  const authenticated = parseBoolean(
    settings.get(SETTING_KEYS.transportAuthenticated),
    false
  );
  if (
    transportState === 'connected' &&
    authenticated &&
    transportAge <= LIVE_FRESH_MS
  ) {
    return { mode: 'live', source: 'official_live_start', syncing: false };
  }
  if (transportAge <= LIVE_GRACE_MS) {
    return { mode: 'syncing', source: 'transport_grace', syncing: true };
  }
  return { mode: 'offline', source: 'transport_stale', syncing: false };
}

function safeRoomUrl(roomId) {
  const normalized = String(roomId || '').trim();
  return /^[1-9][0-9]{0,19}$/.test(normalized)
    ? `https://live.bilibili.com/${normalized}`
    : null;
}

function parsePayload(row) {
  if (!row?.normalized_payload) return {};
  if (typeof row.normalized_payload === 'object') return row.normalized_payload;
  try {
    return JSON.parse(row.normalized_payload);
  } catch {
    return {};
  }
}

function publicSupport(row) {
  const payload = parsePayload(row);
  if (row.event_type === 'guard_buy') {
    return {
      type: 'guard',
      display_name: sanitizePublicText(row.actor_display_name, '匿名观众', 100),
      item_name: GUARD_TIERS[String(payload.guard_level)] || '大航海',
      count: Number.isSafeInteger(Number(payload.guard_num))
        ? Math.max(1, Number(payload.guard_num))
        : 1,
      occurred_at: toIso(row.occurred_at)
    };
  }
  return {
    type: 'gift',
    display_name: sanitizePublicText(row.actor_display_name, '匿名观众', 100),
    item_name: sanitizePublicText(payload.gift_name, '礼物', 100),
    count: Number.isSafeInteger(Number(payload.gift_num))
      ? Math.max(1, Number(payload.gift_num))
      : 1,
    occurred_at: toIso(row.occurred_at)
  };
}

function buildPublicHome({
  settings,
  queue,
  supportRows,
  nowMs,
  roomId
}) {
  const state = resolveLiveMode(settings, nowMs);
  return {
    mode: state.mode,
    is_live: state.mode === 'live',
    status_label: state.mode === 'live'
      ? '直播中'
      : (state.mode === 'syncing' ? '重新同步中' : '目前未开播'),
    room_url: safeRoomUrl(roomId),
    song_requests: {
      open: parseBoolean(settings.get(SETTING_KEYS.songRequestsOpen), true),
      queue_count: queue.waitingCount,
      current: publicSong(queue.current),
      next: publicSong(queue.next)
    },
    activity: currentActivity(settings, nowMs),
    recent_support: supportRows.map(publicSupport),
    updated_at: new Date(nowMs).toISOString(),
    refresh_after_ms: state.mode === 'offline' ? 30_000 : 5_000
  };
}

function createLiveHomeRepository({
  pool = database,
  siteId = process.env.LISTENER_SITE_ID,
  roomId = process.env.LISTENER_ROOM_ID
} = {}) {
  const normalizedSiteId = String(siteId || '').trim();
  const normalizedRoomId = String(roomId || '').trim();
  const targetConfigured = (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalizedSiteId) &&
    /^[1-9][0-9]{0,19}$/.test(normalizedRoomId)
  );
  return {
    pool,

    async loadSettings(queryable = pool, { forUpdate = false } = {}) {
      const [rows] = await queryable.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN (${SETTING_NAMES.map(() => '?').join(',')})
         ${forUpdate ? 'FOR UPDATE' : ''}`,
        SETTING_NAMES
      );
      return new Map(rows.map((row) => [row.setting_key, row.setting_value]));
    },

    async putSettings(queryable, entries) {
      for (const [key, value] of entries) {
        await queryable.query(
          `INSERT INTO settings (setting_key, setting_value)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
          [key, value ?? '']
        );
      }
    },

    async getQueue() {
      const targetWhere = targetConfigured
        ? 'AND site_id = ? AND room_id = ?'
        : '';
      const [rows] = await pool.query(
        `WITH selected_session AS (
           SELECT id
           FROM live_sessions
           WHERE status IN ('open', 'paused')
             ${targetWhere}
           ORDER BY
             CASE status WHEN 'open' THEN 0 ELSE 1 END,
             COALESCE(started_at, created_at) DESC,
             id DESC
           LIMIT 1
         )
         SELECT sr.public_id, sr.requested_title, sr.status, sr.queue_order,
                sr.version,
                s.title AS song_title, s.artist AS song_artist,
                SUM(
                  CASE WHEN sr.status IN ('needs_match', 'queued') THEN 1 ELSE 0 END
                ) OVER () AS waiting_count
         FROM song_requests sr
         JOIN selected_session session ON session.id = sr.session_id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE sr.status IN ('needs_match', 'queued', 'active')
         ORDER BY
           CASE sr.status WHEN 'active' THEN 0 ELSE 1 END,
           sr.queue_order,
           sr.id
         LIMIT 501`
        ,
        targetConfigured ? [normalizedSiteId, normalizedRoomId] : []
      );
      const current = rows.find((row) => row.status === 'active') || null;
      const waiting = rows
        .filter((row) => ['needs_match', 'queued'].includes(row.status))
        .slice(0, 500);
      return {
        current,
        next: waiting[0] || null,
        waiting,
        waitingCount: Number(rows[0]?.waiting_count || 0)
      };
    },

    async getRecentSupport() {
      const targetWhere = targetConfigured
        ? 'AND site_id = ? AND room_id = ?'
        : '';
      const [rows] = await pool.query(
        `SELECT event_type, actor_display_name, occurred_at, normalized_payload
         FROM live_events
         WHERE (
           event_type = 'guard_buy'
           OR (
             event_type = 'gift'
             AND JSON_EXTRACT(normalized_payload, '$.paid') = TRUE
           )
         )
         ${targetWhere}
         ORDER BY occurred_at DESC, id DESC
         LIMIT 5`,
        targetConfigured ? [normalizedSiteId, normalizedRoomId] : []
      );
      return rows;
    }
  };
}

function createLiveHomeService({
  repository = createLiveHomeRepository(),
  clock = Date.now,
  roomId = process.env.LISTENER_ROOM_ID
} = {}) {
  const service = {
    async getPublicHome() {
      const nowMs = clock();
      const [settings, queue, supportRows] = await Promise.all([
        repository.loadSettings(),
        repository.getQueue(),
        repository.getRecentSupport()
      ]);
      return buildPublicHome({ settings, queue, supportRows, nowMs, roomId });
    },

    async getAdminHome() {
      const nowMs = clock();
      const [settings, queue, supportRows] = await Promise.all([
        repository.loadSettings(),
        repository.getQueue(),
        repository.getRecentSupport()
      ]);
      const resolved = resolveLiveMode(settings, nowMs);
      return {
        ...buildPublicHome({ settings, queue, supportRows, nowMs, roomId }),
        control: {
          override_mode: settings.get(SETTING_KEYS.overrideMode) || 'auto',
          override_expires_at: toIso(settings.get(SETTING_KEYS.overrideExpiresAt)),
          override_updated_by: settings.get(SETTING_KEYS.overrideUpdatedBy) || null,
          override_updated_at: toIso(settings.get(SETTING_KEYS.overrideUpdatedAt)),
          automatic_source: resolved.source,
          official_state: settings.get(SETTING_KEYS.officialState) || 'unknown',
          official_event_at: toIso(settings.get(SETTING_KEYS.officialEventAt)),
          listener: {
            state: settings.get(SETTING_KEYS.transportState) || 'unavailable',
            authenticated: parseBoolean(
              settings.get(SETTING_KEYS.transportAuthenticated),
              false
            ),
            reported_at: toIso(settings.get(SETTING_KEYS.transportReportedAt))
          },
          room_id_configured: Boolean(safeRoomUrl(roomId)),
          queue: {
            current: queue.current
              ? {
                public_id: queue.current.public_id,
                version: Number(queue.current.version),
                status: queue.current.status,
                ...publicSong(queue.current)
              }
              : null,
            waiting: queue.waiting.map((request) => ({
              public_id: request.public_id,
              version: Number(request.version),
              status: request.status,
              ...publicSong(request)
            })),
            waiting_count: queue.waitingCount
          },
          activity: {
            enabled: parseBoolean(settings.get(SETTING_KEYS.activityEnabled), false),
            title: settings.get(SETTING_KEYS.activityTitle) || '',
            content: settings.get(SETTING_KEYS.activityContent) || '',
            starts_at: toIso(settings.get(SETTING_KEYS.activityStartsAt)),
            ends_at: toIso(settings.get(SETTING_KEYS.activityEndsAt))
          },
          activity_updated_by: settings.get(SETTING_KEYS.activityUpdatedBy) || null,
          activity_updated_at: toIso(settings.get(SETTING_KEYS.activityUpdatedAt))
        }
      };
    },

    async setOverride(input, actorUserId) {
      const now = new Date(clock()).toISOString();
      if (input.expires_at && new Date(input.expires_at).getTime() <= clock()) {
        throw new SongRequestError(422, 'override_expired', '手动模式过期时间必须晚于现在');
      }
      await runInTransaction(repository.pool, (connection) => (
        repository.putSettings(connection, [
          [SETTING_KEYS.overrideMode, input.mode],
          [SETTING_KEYS.overrideExpiresAt, input.expires_at || ''],
          [SETTING_KEYS.overrideUpdatedBy, String(actorUserId)],
          [SETTING_KEYS.overrideUpdatedAt, now]
        ])
      ));
      return service.getAdminHome();
    },

    async setSongRequestsOpen(open, actorUserId) {
      const now = new Date(clock()).toISOString();
      await runInTransaction(repository.pool, (connection) => (
        repository.putSettings(connection, [
          [SETTING_KEYS.songRequestsOpen, open ? 'true' : 'false'],
          [SETTING_KEYS.songRequestsUpdatedBy, String(actorUserId)],
          [SETTING_KEYS.songRequestsUpdatedAt, now]
        ])
      ));
      return service.getAdminHome();
    },

    async setActivity(input, actorUserId) {
      const now = new Date(clock()).toISOString();
      await runInTransaction(repository.pool, (connection) => (
        repository.putSettings(connection, [
          [SETTING_KEYS.activityEnabled, input.enabled ? 'true' : 'false'],
          [SETTING_KEYS.activityTitle, input.title],
          [SETTING_KEYS.activityContent, input.content],
          [SETTING_KEYS.activityStartsAt, input.starts_at || ''],
          [SETTING_KEYS.activityEndsAt, input.ends_at || ''],
          [SETTING_KEYS.activityUpdatedBy, String(actorUserId)],
          [SETTING_KEYS.activityUpdatedAt, now]
        ])
      ));
      return service.getAdminHome();
    },

    async observeAcceptedEvent(event, { connection }) {
      if (!['live_start', 'live_end'].includes(event.event_type)) {
        return { status: 'ignored', reason: 'not_live_state_event' };
      }
      const settings = await repository.loadSettings(connection, { forUpdate: true });
      const previousEventAt = toIso(settings.get(SETTING_KEYS.officialEventAt));
      if (
        previousEventAt &&
        new Date(event.occurred_at).getTime() <= new Date(previousEventAt).getTime()
      ) {
        return { status: 'ignored', reason: 'stale_live_state_event' };
      }
      const officialState = event.event_type === 'live_start' ? 'live' : 'offline';
      await repository.putSettings(connection, [
        [SETTING_KEYS.officialState, officialState],
        [SETTING_KEYS.officialEventAt, event.occurred_at],
        [SETTING_KEYS.transportState, 'connected'],
        [SETTING_KEYS.transportReportedAt, event.received_at],
        [SETTING_KEYS.transportAuthenticated, 'true']
      ]);
      return { status: 'updated', official_state: officialState };
    },

    async recordTransportStatus(report) {
      return runInTransaction(repository.pool, async (connection) => {
        const settings = await repository.loadSettings(connection, { forUpdate: true });
        if (settings.get(SETTING_KEYS.transportReportId) === report.report_id) {
          throw new SongRequestError(409, 'listener_status_replay', '状态报告已处理');
        }
        const previousAt = toIso(settings.get(SETTING_KEYS.transportReportedAt));
        if (
          previousAt &&
          new Date(report.reported_at).getTime() <= new Date(previousAt).getTime()
        ) {
          throw new SongRequestError(409, 'listener_status_stale', '状态报告早于已保存状态');
        }
        await repository.putSettings(connection, [
          [SETTING_KEYS.transportState, report.transport_state],
          [SETTING_KEYS.transportReportedAt, report.reported_at],
          [SETTING_KEYS.transportReportId, report.report_id],
          [SETTING_KEYS.transportAuthenticated, report.authenticated ? 'true' : 'false']
        ]);
        return { status: 'accepted', report_id: report.report_id };
      });
    }
  };
  return service;
}

const defaultLiveHomeService = createLiveHomeService();

module.exports = {
  GUARD_TIERS,
  LIVE_FRESH_MS,
  LIVE_GRACE_MS,
  SETTING_KEYS,
  buildPublicHome,
  createLiveHomeRepository,
  createLiveHomeService,
  currentActivity,
  defaultLiveHomeService,
  publicSupport,
  resolveLiveMode,
  safeRoomUrl
};
