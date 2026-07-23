const database = require('../config/database');
const { normalizeSongText } = require('../utils/songText');
const { SongRequestError } = require('../utils/songRequestError');

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
      return {
        playlist: {
          id: playlist.id,
          title: playlist.title
        },
        songs: filtered.slice(start, start + limit).map(publicCatalogSong),
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
  matchesQuery,
  publicCatalogSong,
  resolveSitePlaylist
};
