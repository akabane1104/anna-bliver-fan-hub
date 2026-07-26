const database = require('../config/database');
const { normalizeSongText } = require('../utils/songText');
const { SongRequestError } = require('../utils/songRequestError');
const {
  activeActivityTag,
  getQueueMetrics,
  loadPolicySettings,
  settingsProjection,
  taipeiDayBounds
} = require('./songRequestPolicyService');
const { reasonMessage } = require('./songRequestCanonical');

async function resolveSitePlaylist(queryable) {
  const [settings] = await queryable.query(
    `SELECT setting_value
     FROM settings
     WHERE setting_key = 'site_playlist_id'
     LIMIT 1`
  );
  const configuredId = Number.parseInt(settings[0]?.setting_value, 10);
  if (Number.isInteger(configuredId) && configuredId > 0) {
    const [configured] = await queryable.query(
      'SELECT id, title FROM playlists WHERE id = ? LIMIT 1',
      [configuredId]
    );
    if (configured.length) return configured[0];
  }

  const [playlists] = await queryable.query(
    'SELECT id, title FROM playlists ORDER BY created_at DESC, id DESC LIMIT 1'
  );
  if (!playlists.length) {
    throw new SongRequestError(404, 'playlist_not_found', '网站歌单不存在');
  }
  return playlists[0];
}

async function loadCatalog(queryable, playlistId) {
  const [rows] = await queryable.query(
    `SELECT s.id, s.title, s.artist, s.duration, s.note,
            t.id AS tag_id, t.name AS tag_name, t.color AS tag_color
     FROM songs s
     LEFT JOIN song_tags st ON st.song_id = s.id
     LEFT JOIN tags t ON t.id = st.tag_id
     WHERE s.playlist_id = ?
     ORDER BY s.title COLLATE utf8mb4_bin, s.id, t.id`,
    [playlistId]
  );
  const [aliases] = await queryable.query(
    `SELECT sa.song_id, sa.alias, sa.normalized_alias, sa.script_key,
            sa.loose_candidate_key
     FROM song_aliases sa
     INNER JOIN songs s ON s.id = sa.song_id
     WHERE s.playlist_id = ?
     ORDER BY sa.id`,
    [playlistId]
  );

  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      const normalization = normalizeSongText(row.title);
      byId.set(row.id, {
        id: row.id,
        title: row.title,
        artist: row.artist,
        duration: row.duration || null,
        note: row.note || null,
        tags: [],
        searchKeys: new Set([
          normalization.whitespace_normalized,
          normalization.script_key,
          normalization.loose_candidate_key,
          ...Object.values(normalizeSongText(row.artist)).filter((value) => typeof value === 'string')
        ])
      });
    }
    if (row.tag_id) {
      byId.get(row.id).tags.push({
        id: row.tag_id,
        name: row.tag_name,
        color: row.tag_color
      });
    }
  }
  for (const alias of aliases) {
    const song = byId.get(alias.song_id);
    if (!song) continue;
    song.searchKeys.add(alias.alias);
    song.searchKeys.add(alias.normalized_alias);
    song.searchKeys.add(alias.script_key);
    song.searchKeys.add(alias.loose_candidate_key);
  }
  return [...byId.values()];
}

function matchesQuery(song, query) {
  if (!query) return true;
  const normalized = normalizeSongText(query);
  const exactKeys = new Set([
    normalized.whitespace_normalized,
    normalized.script_key,
    normalized.loose_candidate_key
  ]);
  for (const key of song.searchKeys) {
    const normalizedKey = String(key || '');
    if (exactKeys.has(normalizedKey)) return true;
    if (
      normalizedKey.toLocaleLowerCase().includes(normalized.loose_candidate_key) ||
      normalized.script_key && normalizedKey.includes(normalized.script_key)
    ) {
      return true;
    }
  }
  return false;
}

function publicCatalogSong(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    duration: song.duration,
    note: song.note,
    tags: song.tags
  };
}

async function loadAvailability(queryable, playlistId, songIds) {
  if (!songIds.length) return new Map();
  const settings = await loadPolicySettings(queryable);
  const config = settingsProjection(settings);
  const [sessions] = await queryable.query(
    `SELECT id
     FROM live_sessions
     WHERE playlist_id = ? AND status = 'open'
     ORDER BY COALESCE(started_at, created_at) DESC, id DESC
     LIMIT 1`,
    [playlistId]
  );
  const sessionId = sessions[0]?.id || null;
  const metrics = await getQueueMetrics(queryable, sessionId, settings);
  const [policies] = await queryable.query(
    `SELECT song_id, temporarily_blocked, public_reason, blocked_until,
            special_event_tag_id
     FROM song_request_policies
     WHERE song_id IN (${songIds.map(() => '?').join(',')})`,
    songIds
  );
  const [queued] = sessionId
    ? await queryable.query(
      `SELECT DISTINCT matched_song_id
       FROM song_requests
       WHERE session_id = ? AND matched_song_id IS NOT NULL
          AND status IN ('queued','active')`,
      [sessionId]
    )
    : [[]];
  const cooldownSince = new Date(
    Date.now() - (config.cooldown_minutes * 60 * 1000)
  ).toISOString().slice(0, 23).replace('T', ' ');
  const [recent] = await queryable.query(
    `SELECT matched_song_id, MAX(completed_at) AS completed_at
     FROM song_requests
     WHERE matched_song_id IN (${songIds.map(() => '?').join(',')})
       AND status = 'completed' AND completed_at >= ?
     GROUP BY matched_song_id`,
    [...songIds, cooldownSince]
  );
  const bounds = taipeiDayBounds();
  const [today] = await queryable.query(
    `SELECT DISTINCT matched_song_id
     FROM song_requests
     WHERE matched_song_id IN (${songIds.map(() => '?').join(',')})
       AND status = 'completed'
       AND completed_at >= ? AND completed_at < ?`,
    [...songIds, bounds.start, bounds.end]
  );
  const policiesBySong = new Map(
    policies.map((row) => [Number(row.song_id), row])
  );
  const queuedIds = new Set(queued.map((row) => Number(row.matched_song_id)));
  const recentBySong = new Map(
    recent.map((row) => [Number(row.matched_song_id), row.completed_at])
  );
  const todayIds = new Set(today.map((row) => Number(row.matched_song_id)));
  const activeTagId = activeActivityTag(settings);
  const effectiveOpen = Boolean(
    sessionId && config.manual_open && !config.auto_capacity_blocked
  );
  const result = new Map();
  for (const songId of songIds) {
    const policy = policiesBySong.get(Number(songId));
    const blockedUntil = policy?.blocked_until
      ? new Date(policy.blocked_until).getTime()
      : null;
    const temporarilyBlocked = Boolean(
      policy?.temporarily_blocked
      && (!blockedUntil || blockedUntil > Date.now())
    );
    const specialEventOnly = Boolean(
      policy?.special_event_tag_id
      && Number(policy.special_event_tag_id) !== Number(activeTagId)
    );
    let reasonCode = null;
    if (!effectiveOpen) {
      reasonCode = config.auto_capacity_blocked
        ? 'queue_capacity_reached'
        : 'requests_closed';
    } else if (temporarilyBlocked) reasonCode = 'song_temporarily_blocked';
    else if (specialEventOnly) reasonCode = 'special_event_only';
    else if (queuedIds.has(Number(songId))) reasonCode = 'duplicate_in_queue';
    else if (recentBySong.has(Number(songId))) reasonCode = 'song_cooldown';
    else if (config.block_repeat_today && todayIds.has(Number(songId))) {
      reasonCode = 'already_sung_today';
    }
    const completedAt = recentBySong.get(Number(songId));
    result.set(Number(songId), {
      requestable: !reasonCode,
      reason_code: reasonCode,
      public_reason: reasonCode
        ? (policy?.public_reason || reasonMessage(reasonCode))
        : null,
      sung_today: todayIds.has(Number(songId)),
      cooldown_until: completedAt
        ? new Date(
          new Date(completedAt).getTime() + (config.cooldown_minutes * 60 * 1000)
        ).toISOString()
        : null,
      already_queued: queuedIds.has(Number(songId)),
      temporarily_blocked: temporarilyBlocked,
      special_event_only: specialEventOnly,
      eta: {
        paused: config.eta_paused,
        min_minutes: metrics.max_eta_minutes,
        max_minutes: metrics.max_eta_minutes + Math.ceil(
          (config.default_duration_seconds + config.buffer_seconds) / 60
        )
      }
    });
  }
  return result;
}

function createSongCatalogService({ pool = database } = {}) {
  return {
    async list({ query = '', tag = '', page = 1, limit = 100 } = {}) {
      const playlist = await resolveSitePlaylist(pool);
      const catalog = await loadCatalog(pool, playlist.id);
      const filtered = catalog.filter((song) => (
        matchesQuery(song, query) &&
        (!tag || song.tags.some(({ name }) => name === tag))
      ));
      const start = (page - 1) * limit;
      const pageSongs = filtered.slice(start, start + limit);
      const availability = await loadAvailability(
        pool,
        playlist.id,
        pageSongs.map(({ id }) => Number(id))
      );
      return {
        playlist: {
          id: playlist.id,
          title: playlist.title
        },
        songs: pageSongs.map((song) => ({
          ...publicCatalogSong(song),
          availability: availability.get(Number(song.id))
        })),
        pagination: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.max(1, Math.ceil(filtered.length / limit))
        }
      };
    }
  };
}

const defaultSongCatalogService = createSongCatalogService();

module.exports = {
  createSongCatalogService,
  defaultSongCatalogService,
  loadCatalog,
  loadAvailability,
  matchesQuery,
  publicCatalogSong,
  resolveSitePlaylist
};
