const database = require('../config/database');
const { SongRequestError, assertExpectedVersion } = require('../utils/songRequestError');
const {
  ACTIVE_LEGACY_STATUSES,
  REASON_MESSAGES,
  canonicalStatus,
  reasonMessage
} = require('./songRequestCanonical');

const SETTING_KEYS = Object.freeze({
  manualOpen: 'live_home_song_requests_open',
  autoCapacityBlocked: 'song_request_auto_capacity_blocked',
  cooldownMinutes: 'song_request_cooldown_minutes',
  blockRepeatToday: 'song_request_block_repeat_today',
  queueLimit: 'song_request_queue_limit',
  reopenThreshold: 'song_request_reopen_threshold',
  etaCloseMinutes: 'song_request_eta_close_minutes',
  etaReopenMinutes: 'song_request_eta_reopen_minutes',
  defaultDurationSeconds: 'song_request_default_duration_seconds',
  bufferSeconds: 'song_request_buffer_seconds',
  etaPaused: 'song_request_eta_paused',
  activeEventTagId: 'song_request_active_event_tag_id',
  settingsRevision: 'song_request_settings_revision',
  activityEnabled: 'live_home_activity_enabled',
  activityStartsAt: 'live_home_activity_starts_at',
  activityEndsAt: 'live_home_activity_ends_at'
});

const DEFAULT_SETTINGS = Object.freeze({
  [SETTING_KEYS.manualOpen]: 'true',
  [SETTING_KEYS.autoCapacityBlocked]: 'false',
  [SETTING_KEYS.cooldownMinutes]: '60',
  [SETTING_KEYS.blockRepeatToday]: 'false',
  [SETTING_KEYS.queueLimit]: '12',
  [SETTING_KEYS.reopenThreshold]: '8',
  [SETTING_KEYS.etaCloseMinutes]: '60',
  [SETTING_KEYS.etaReopenMinutes]: '40',
  [SETTING_KEYS.defaultDurationSeconds]: '240',
  [SETTING_KEYS.bufferSeconds]: '60',
  [SETTING_KEYS.etaPaused]: 'false',
  [SETTING_KEYS.activeEventTagId]: '',
  [SETTING_KEYS.settingsRevision]: '0'
});

const POLICY_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const ALL_SETTING_KEYS = Object.freeze([
  ...POLICY_SETTING_KEYS,
  SETTING_KEYS.activityEnabled,
  SETTING_KEYS.activityStartsAt,
  SETTING_KEYS.activityEndsAt
]);

function parseBoolean(value, fallback = false) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function parseInteger(value, fallback, { min = 0, max = 86400 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function mysqlDate(value) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function taipeiDayBounds(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now).filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)])
  );
  const startMs = Date.UTC(parts.year, parts.month - 1, parts.day) - (8 * 60 * 60 * 1000);
  return {
    start: mysqlDate(startMs),
    end: mysqlDate(startMs + (24 * 60 * 60 * 1000))
  };
}

function parseDurationSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{1,4}$/.test(text)) {
    const seconds = Number(text);
    return seconds >= 30 && seconds <= 7200 ? seconds : null;
  }
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (!match) return null;
  const seconds = (Number(match[1]) * 60) + Number(match[2]);
  return seconds >= 30 && seconds <= 7200 ? seconds : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function activeActivityTag(settings, now = new Date()) {
  if (!parseBoolean(settings.get(SETTING_KEYS.activityEnabled), false)) return null;
  const startsAt = Date.parse(settings.get(SETTING_KEYS.activityStartsAt) || '');
  const endsAt = Date.parse(settings.get(SETTING_KEYS.activityEndsAt) || '');
  if (Number.isFinite(startsAt) && now.getTime() < startsAt) return null;
  if (Number.isFinite(endsAt) && now.getTime() >= endsAt) return null;
  const tagId = Number.parseInt(settings.get(SETTING_KEYS.activeEventTagId) || '', 10);
  return Number.isInteger(tagId) && tagId > 0 ? tagId : null;
}

function settingsProjection(settings) {
  const projected = {
    manual_open: parseBoolean(settings.get(SETTING_KEYS.manualOpen), true),
    auto_capacity_blocked: parseBoolean(settings.get(SETTING_KEYS.autoCapacityBlocked), false),
    cooldown_minutes: parseInteger(settings.get(SETTING_KEYS.cooldownMinutes), 60, { max: 10080 }),
    block_repeat_today: parseBoolean(settings.get(SETTING_KEYS.blockRepeatToday), false),
    queue_limit: parseInteger(settings.get(SETTING_KEYS.queueLimit), 12, { min: 1, max: 500 }),
    reopen_threshold: parseInteger(settings.get(SETTING_KEYS.reopenThreshold), 8, { min: 0, max: 499 }),
    eta_close_minutes: parseInteger(settings.get(SETTING_KEYS.etaCloseMinutes), 60, { min: 1, max: 1440 }),
    eta_reopen_minutes: parseInteger(settings.get(SETTING_KEYS.etaReopenMinutes), 40, { min: 0, max: 1439 }),
    default_duration_seconds: parseInteger(
      settings.get(SETTING_KEYS.defaultDurationSeconds),
      240,
      { min: 30, max: 7200 }
    ),
    buffer_seconds: parseInteger(settings.get(SETTING_KEYS.bufferSeconds), 60, { max: 600 }),
    eta_paused: parseBoolean(settings.get(SETTING_KEYS.etaPaused), false),
    revision: parseInteger(settings.get(SETTING_KEYS.settingsRevision), 0, {
      max: 2147483647
    }),
    active_event_tag_id: (() => {
      const value = Number.parseInt(settings.get(SETTING_KEYS.activeEventTagId) || '', 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    })()
  };
  return {
    ...projected,
    max_eta_minutes: projected.eta_close_minutes,
    reopen_eta_minutes: projected.eta_reopen_minutes,
    default_song_seconds: projected.default_duration_seconds
  };
}

async function ensurePolicySettings(queryable) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await queryable.query(
      'INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)',
      [key, value]
    );
  }
}

async function loadPolicySettings(queryable, { forUpdate = false } = {}) {
  const [rows] = await queryable.query(
    `SELECT setting_key, setting_value
     FROM settings
     WHERE setting_key IN (${ALL_SETTING_KEYS.map(() => '?').join(',')})
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    ALL_SETTING_KEYS
  );
  const settings = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!settings.has(key)) settings.set(key, value);
  }
  return settings;
}

function throwPolicy(code, supplement = null, status = 409) {
  const error = new SongRequestError(status, code, reasonMessage(code, supplement));
  error.publicReason = supplement || REASON_MESSAGES[code] || null;
  throw error;
}

async function resolveBoundUserByOpenId(connection, openId) {
  const normalized = String(openId || '').trim();
  if (!normalized) return null;
  const [rows] = await connection.query(
    `SELECT b.user_id
     FROM user_bilibili_bindings b
     WHERE b.bilibili_open_id = ? AND b.status = 'verified'
     LIMIT 1`,
    [normalized]
  );
  if (!rows.length) return null;
  const identity = await lockUserAndBindings(connection, rows[0].user_id, {
    requireBinding: true
  });
  const [verified] = await connection.query(
    `SELECT id
     FROM user_bilibili_bindings
     WHERE user_id = ? AND bilibili_open_id = ? AND status = 'verified'
     LIMIT 1
     FOR UPDATE`,
    [rows[0].user_id, normalized]
  );
  return verified.length
    ? {
      id: identity.user.id,
      username: identity.user.username,
      binding_id: verified[0].id
    }
    : null;
}

async function lockUserAndBindings(connection, userId, { requireBinding = true } = {}) {
  const [users] = await connection.query(
    'SELECT id, username FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
    [userId]
  );
  if (!users.length) throwPolicy('identity_binding_required', null, 401);
  const [bindings] = await connection.query(
    `SELECT id
     FROM user_bilibili_bindings
     WHERE user_id = ? AND status = 'verified'
     ORDER BY id
     FOR UPDATE`,
    [userId]
  );
  if (requireBinding && !bindings.length) throwPolicy('identity_binding_required', null, 409);
  const [active] = await connection.query(
    `SELECT id
     FROM song_requests
     WHERE requester_user_id = ?
       AND status IN (${ACTIVE_LEGACY_STATUSES.map(() => '?').join(',')})
     LIMIT 1
     FOR UPDATE`,
    [userId, ...ACTIVE_LEGACY_STATUSES]
  );
  if (active.length) throwPolicy('user_active_limit');
  return { user: users[0], bindings };
}

async function loadQueueRows(queryable, sessionId) {
  const [rows] = await queryable.query(
    `SELECT sr.id, sr.public_id, sr.status, sr.queue_order, sr.matched_song_id,
            sr.activated_at, sr.requested_at, s.duration,
            p.duration_override_seconds
     FROM song_requests sr
     LEFT JOIN songs s ON s.id = sr.matched_song_id
     LEFT JOIN song_request_policies p ON p.song_id = sr.matched_song_id
     WHERE sr.session_id = ?
       AND sr.status IN ('needs_match','queued','active')
     ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
              sr.queue_order, sr.id`,
    [sessionId]
  );
  return rows;
}

async function loadDurationHistory(queryable) {
  const [rows] = await queryable.query(
    `SELECT matched_song_id,
            TIMESTAMPDIFF(SECOND, activated_at, completed_at) AS duration_seconds
     FROM song_requests
     WHERE status = 'completed'
       AND fulfillment_type = 'sung'
       AND matched_song_id IS NOT NULL
       AND activated_at IS NOT NULL
       AND completed_at IS NOT NULL
       AND completed_at >= activated_at
     ORDER BY completed_at DESC, id DESC
     LIMIT 1000`
  );
  return rows
    .map((row) => ({
      songId: Number(row.matched_song_id),
      seconds: Number(row.duration_seconds)
    }))
    .filter(({ seconds }) => Number.isFinite(seconds) && seconds >= 30 && seconds <= 7200);
}

function calculateEta(queueRows, durationHistory, config) {
  const bySong = new Map();
  for (const item of durationHistory) {
    if (!bySong.has(item.songId)) bySong.set(item.songId, []);
    bySong.get(item.songId).push(item.seconds);
  }
  const songMedians = new Map(
    [...bySong.entries()].map(([songId, values]) => [songId, median(values)])
  );
  const globalMedian = median(durationHistory.map(({ seconds }) => seconds));
  const estimate = (row) => (
    parseInteger(row.duration_override_seconds, null, { min: 30, max: 7200 })
    || songMedians.get(Number(row.matched_song_id))
    || parseDurationSeconds(row.duration)
    || globalMedian
    || config.default_duration_seconds
  );
  let cumulativeSeconds = 0;
  let position = 0;
  const requests = queueRows.map((row) => {
    const durationSeconds = estimate(row);
    if (row.status === 'active') {
      cumulativeSeconds += durationSeconds + config.buffer_seconds;
      return {
        public_id: row.public_id,
        position: 0,
        status: canonicalStatus(row.status),
        eta: { paused: config.eta_paused, min_minutes: 0, max_minutes: 0 }
      };
    }
    position += 1;
    const minMinutes = Math.max(0, Math.floor((cumulativeSeconds * 0.85) / 60));
    const maxMinutes = Math.max(minMinutes + 1, Math.ceil((cumulativeSeconds * 1.15) / 60));
    const result = {
      public_id: row.public_id,
      position,
      status: canonicalStatus(row.status),
      eta: {
        paused: config.eta_paused,
        min_minutes: minMinutes,
        max_minutes: maxMinutes
      }
    };
    cumulativeSeconds += durationSeconds + config.buffer_seconds;
    return result;
  });
  const waiting = requests.filter(({ position: value }) => value > 0);
  return {
    requests,
    waiting_count: waiting.length,
    max_eta_minutes: waiting.at(-1)?.eta.max_minutes || 0,
    updated_at: new Date().toISOString()
  };
}

async function getQueueMetrics(queryable, sessionId, settings) {
  if (!sessionId) {
    return {
      requests: [],
      waiting_count: 0,
      max_eta_minutes: 0,
      updated_at: new Date().toISOString()
    };
  }
  const queueRows = await loadQueueRows(queryable, sessionId);
  const history = await loadDurationHistory(queryable);
  return calculateEta(queueRows, history, settingsProjection(settings));
}

function resolveCapacityBlocked(metrics, config) {
  if (config.auto_capacity_blocked) {
    return !(
      metrics.waiting_count <= config.reopen_threshold
      && metrics.max_eta_minutes < config.eta_reopen_minutes
    );
  }
  return (
    metrics.waiting_count >= config.queue_limit
    || metrics.max_eta_minutes > config.eta_close_minutes
  );
}

async function refreshCapacityState(connection, sessionId, existingSettings = null) {
  const settings = existingSettings || await loadPolicySettings(connection, { forUpdate: true });
  const config = settingsProjection(settings);
  const metrics = await getQueueMetrics(connection, sessionId, settings);
  const blocked = resolveCapacityBlocked(metrics, config);
  if (blocked !== config.auto_capacity_blocked) {
    await connection.query(
      'UPDATE settings SET setting_value = ? WHERE setting_key = ?',
      [blocked ? 'true' : 'false', SETTING_KEYS.autoCapacityBlocked]
    );
    settings.set(SETTING_KEYS.autoCapacityBlocked, blocked ? 'true' : 'false');
  }
  const current = settingsProjection(settings);
  return {
    settings,
    metrics,
    effective_open: current.manual_open && !current.auto_capacity_blocked,
    public_reason: !current.manual_open
      ? 'requests_closed'
      : (current.auto_capacity_blocked ? 'queue_capacity_reached' : null),
    ...current
  };
}

async function assertSongPolicy(connection, {
  sessionId,
  matchedSongId,
  requestId = null,
  requesterUserId = null,
  requireBinding = false,
  userAlreadyLocked = false,
  now = new Date()
}) {
  const settings = await loadPolicySettings(connection, { forUpdate: true });
  const config = settingsProjection(settings);
  if (!config.manual_open) throwPolicy('requests_closed');
  if (requesterUserId && !userAlreadyLocked) {
    await lockUserAndBindings(connection, requesterUserId, { requireBinding });
  }
  const capacity = await refreshCapacityState(connection, sessionId, settings);
  if (!capacity.effective_open) throwPolicy(capacity.public_reason);
  if (!matchedSongId) return { settings, capacity };

  const [policies] = await connection.query(
    `SELECT song_id, temporarily_blocked, public_reason, internal_note,
            blocked_until, special_event_tag_id, duration_override_seconds, version
     FROM song_request_policies
     WHERE song_id = ?
     LIMIT 1
     FOR UPDATE`,
    [matchedSongId]
  );
  const policy = policies[0] || null;
  if (policy?.temporarily_blocked) {
    const expiresAt = policy.blocked_until ? new Date(policy.blocked_until).getTime() : null;
    if (!expiresAt || expiresAt > now.getTime()) {
      throwPolicy('song_temporarily_blocked', policy.public_reason);
    }
    await connection.query(
      `UPDATE song_request_policies
       SET temporarily_blocked = 0, released_at = UTC_TIMESTAMP(3),
           released_by_user_id = NULL, version = version + 1
       WHERE song_id = ?`,
      [matchedSongId]
    );
  }
  if (
    policy?.special_event_tag_id
    && Number(policy.special_event_tag_id) !== Number(activeActivityTag(settings, now))
  ) {
    throwPolicy('special_event_only');
  }

  const [duplicates] = await connection.query(
    `SELECT id
     FROM song_requests
     WHERE session_id = ? AND matched_song_id = ?
        AND status IN ('queued','active')
       AND (? IS NULL OR id <> ?)
     LIMIT 1
     FOR UPDATE`,
    [sessionId, matchedSongId, requestId, requestId]
  );
  if (duplicates.length) throwPolicy('duplicate_in_queue');

  const cooldownSince = mysqlDate(now.getTime() - (config.cooldown_minutes * 60 * 1000));
  const [recent] = await connection.query(
    `SELECT id
     FROM song_requests
     WHERE matched_song_id = ? AND status = 'completed'
       AND completed_at >= ?
     LIMIT 1
     FOR UPDATE`,
    [matchedSongId, cooldownSince]
  );
  if (recent.length) throwPolicy('song_cooldown');

  if (config.block_repeat_today) {
    const bounds = taipeiDayBounds(now);
    const [today] = await connection.query(
      `SELECT id
       FROM song_requests
       WHERE matched_song_id = ? AND status = 'completed'
         AND completed_at >= ? AND completed_at < ?
       LIMIT 1
       FOR UPDATE`,
      [matchedSongId, bounds.start, bounds.end]
    );
    if (today.length) throwPolicy('already_sung_today');
  }
  return { settings, capacity, policy };
}

function publicPolicy(row) {
  if (!row) return null;
  return {
    song_id: Number(row.song_id),
    temporarily_blocked: Boolean(row.temporarily_blocked),
    blocked: Boolean(row.temporarily_blocked),
    public_reason: row.public_reason || null,
    blocked_until: row.blocked_until || null,
    expires_at: row.blocked_until || null,
    special_event_tag_id: row.special_event_tag_id == null
      ? null
      : Number(row.special_event_tag_id),
    duration_override_seconds: row.duration_override_seconds == null
      ? null
      : Number(row.duration_override_seconds),
    version: Number(row.version)
  };
}

function adminPolicy(row) {
  const publicValue = publicPolicy(row);
  return publicValue ? {
    ...publicValue,
    internal_note: row.internal_note || null,
    released_at: row.released_at || null
  } : null;
}

function createSongRequestPolicyService({ pool = database } = {}) {
  return {
    async getSettings(queryable = pool) {
      return settingsProjection(await loadPolicySettings(queryable));
    },

    async updateSettings(input, actorUserId) {
      const entries = [
        [SETTING_KEYS.cooldownMinutes, input.cooldown_minutes],
        [SETTING_KEYS.blockRepeatToday, input.block_repeat_today],
        [SETTING_KEYS.queueLimit, input.queue_limit],
        [SETTING_KEYS.reopenThreshold, input.reopen_threshold],
        [SETTING_KEYS.etaCloseMinutes, input.max_eta_minutes],
        [SETTING_KEYS.etaReopenMinutes, input.reopen_eta_minutes],
        [SETTING_KEYS.defaultDurationSeconds, input.default_song_seconds],
        [SETTING_KEYS.bufferSeconds, input.buffer_seconds],
        [SETTING_KEYS.etaPaused, input.eta_paused],
        [SETTING_KEYS.activeEventTagId, input.active_event_tag_id]
      ].filter(([, value]) => value !== undefined);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await ensurePolicySettings(connection);
        const current = await loadPolicySettings(connection, { forUpdate: true });
        assertExpectedVersion(
          settingsProjection(current).revision,
          input.expected_revision
        );
        for (const [key, value] of entries) {
          await connection.query(
            'UPDATE settings SET setting_value = ? WHERE setting_key = ?',
            [value === null ? '' : String(value), key]
          );
        }
        await connection.query(
          `UPDATE settings
           SET setting_value = CAST(CAST(setting_value AS UNSIGNED) + 1 AS CHAR)
           WHERE setting_key = ?`,
          [SETTING_KEYS.settingsRevision]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return { ...(await this.getSettings()), updated_by_user_id: actorUserId };
    },

    async getPolicy(songId, { admin = false } = {}) {
      const [rows] = await pool.query(
        `SELECT song_id, temporarily_blocked, public_reason, internal_note,
                blocked_until, released_at, special_event_tag_id,
                duration_override_seconds, version
         FROM song_request_policies WHERE song_id = ? LIMIT 1`,
        [songId]
      );
      return admin ? adminPolicy(rows[0]) : publicPolicy(rows[0]);
    },

    async setPolicy(songId, input, actorUserId) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [songs] = await connection.query(
          'SELECT id FROM songs WHERE id = ? LIMIT 1 FOR UPDATE',
          [songId]
        );
        if (!songs.length) throwPolicy('song_not_found', null, 404);
        const [existing] = await connection.query(
          `SELECT song_id, temporarily_blocked, public_reason, internal_note,
                  blocked_until, special_event_tag_id, duration_override_seconds,
                  version
           FROM song_request_policies
           WHERE song_id = ?
           LIMIT 1
           FOR UPDATE`,
          [songId]
        );
        const current = existing[0] || null;
        if (current) assertExpectedVersion(current.version, input.expected_version);
        else assertExpectedVersion(0, input.expected_version);
        const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
        const blocked = has('blocked')
          ? Boolean(input.blocked)
          : Boolean(current?.temporarily_blocked);
        const publicReason = has('public_reason')
          ? (input.public_reason || null)
          : (current?.public_reason || null);
        const internalNote = has('internal_note')
          ? (input.internal_note || null)
          : (current?.internal_note || null);
        const blockedUntil = has('expires_at')
          ? (input.expires_at ? mysqlDate(input.expires_at) : null)
          : (current?.blocked_until || null);
        const specialEventTagId = has('special_event_tag_id')
          ? (input.special_event_tag_id || null)
          : (current?.special_event_tag_id || null);
        const durationOverrideSeconds = has('duration_override_seconds')
          ? (input.duration_override_seconds || null)
          : (current?.duration_override_seconds || null);
        await connection.query(
          `INSERT INTO song_request_policies (
             song_id, temporarily_blocked, public_reason, internal_note,
             blocked_until, special_event_tag_id, duration_override_seconds,
             created_by_user_id, updated_by_user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             temporarily_blocked = VALUES(temporarily_blocked),
             public_reason = VALUES(public_reason),
             internal_note = VALUES(internal_note),
             blocked_until = VALUES(blocked_until),
             special_event_tag_id = VALUES(special_event_tag_id),
             duration_override_seconds = VALUES(duration_override_seconds),
             updated_by_user_id = VALUES(updated_by_user_id),
             released_at = CASE
               WHEN VALUES(temporarily_blocked) = 0 THEN UTC_TIMESTAMP(3)
               ELSE NULL
             END,
             released_by_user_id = CASE
               WHEN VALUES(temporarily_blocked) = 0 THEN VALUES(updated_by_user_id)
               ELSE NULL
             END,
             version = version + 1`,
          [
            songId,
            blocked ? 1 : 0,
            publicReason,
            internalNote,
            blockedUntil,
            specialEventTagId,
            durationOverrideSeconds,
            actorUserId,
            actorUserId
          ]
        );
        await connection.commit();
        return this.getPolicy(songId, { admin: true });
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async releasePolicy(songId, expectedVersion, actorUserId) {
      const [result] = await pool.query(
        `UPDATE song_request_policies
         SET temporarily_blocked = 0, released_at = UTC_TIMESTAMP(3),
             released_by_user_id = ?, updated_by_user_id = ?,
             version = version + 1
         WHERE song_id = ? AND version = ?`,
        [actorUserId, actorUserId, songId, expectedVersion]
      );
      if (!result.affectedRows) {
        const existing = await this.getPolicy(songId, { admin: true });
        if (!existing) throwPolicy('song_not_found', null, 404);
        assertExpectedVersion(existing.version, expectedVersion);
      }
      return this.getPolicy(songId, { admin: true });
    }
  };
}

const defaultSongRequestPolicyService = createSongRequestPolicyService();

module.exports = {
  ALL_SETTING_KEYS,
  DEFAULT_SETTINGS,
  POLICY_SETTING_KEYS,
  SETTING_KEYS,
  activeActivityTag,
  adminPolicy,
  assertSongPolicy,
  calculateEta,
  createSongRequestPolicyService,
  defaultSongRequestPolicyService,
  ensurePolicySettings,
  getQueueMetrics,
  loadPolicySettings,
  lockUserAndBindings,
  median,
  parseDurationSeconds,
  publicPolicy,
  refreshCapacityState,
  resolveCapacityBlocked,
  resolveBoundUserByOpenId,
  settingsProjection,
  taipeiDayBounds,
  throwPolicy
};
