const { normalizeSongText } = require('../utils/songText');

const MATCH_CONFIDENCE = Object.freeze({
  exact: 1,
  normalized_exact: 0.99,
  script_exact: 0.98,
  alias_exact: 0.97,
  alias_script: 0.96
});

function publicSong(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    duration: song.duration || null
  };
}

function uniqueSongs(matches) {
  const byId = new Map();
  for (const match of matches) byId.set(String(match.id), match);
  return [...byId.values()];
}

function exactLayer(songs, predicate, method, normalization) {
  const matches = uniqueSongs(songs.filter(predicate));
  if (!matches.length) return null;
  if (matches.length === 1) {
    return {
      kind: 'matched',
      match_method: method,
      match_confidence: MATCH_CONFIDENCE[method],
      song: publicSong(matches[0]),
      candidates: [publicSong(matches[0])],
      normalization
    };
  }
  return {
    kind: 'ambiguous',
    match_method: 'ambiguous',
    match_confidence: null,
    song: null,
    candidates: matches.slice(0, 5).map(publicSong),
    normalization
  };
}

function matchSongCatalog({ songs, aliases = [] }, query) {
  const normalization = normalizeSongText(query);
  const preparedSongs = songs.map((song) => ({
    ...song,
    normalization: normalizeSongText(song.title)
  }));
  const songsById = new Map(preparedSongs.map((song) => [String(song.id), song]));
  const preparedAliases = aliases
    .map((alias) => {
      const song = songsById.get(String(alias.song_id));
      if (!song) return null;
      return {
        ...alias,
        song,
        normalization: {
          raw_text: alias.alias,
          whitespace_normalized: alias.normalized_alias || normalizeSongText(alias.alias).whitespace_normalized,
          script_key: alias.script_key || normalizeSongText(alias.alias).script_key,
          loose_candidate_key: alias.loose_candidate_key || normalizeSongText(alias.alias).loose_candidate_key
        }
      };
    })
    .filter(Boolean);

  const layers = [
    () => exactLayer(
      preparedSongs,
      (song) => song.title === normalization.raw_text,
      'exact',
      normalization
    ),
    () => exactLayer(
      preparedSongs,
      (song) => song.normalization.whitespace_normalized === normalization.whitespace_normalized,
      'normalized_exact',
      normalization
    ),
    () => exactLayer(
      preparedSongs,
      (song) => song.normalization.script_key === normalization.script_key,
      'script_exact',
      normalization
    ),
    () => exactLayer(
      preparedAliases.map((alias) => alias.song),
      (song) => preparedAliases.some(
        (alias) => String(alias.song.id) === String(song.id) && alias.alias === normalization.raw_text
      ),
      'alias_exact',
      normalization
    ),
    () => exactLayer(
      preparedAliases.map((alias) => alias.song),
      (song) => preparedAliases.some(
        (alias) => (
          String(alias.song.id) === String(song.id) &&
          alias.normalization.script_key === normalization.script_key
        )
      ),
      'alias_script',
      normalization
    )
  ];

  for (const layer of layers) {
    const result = layer();
    if (result) return result;
  }

  const candidateRanks = new Map();
  const queryKey = normalization.loose_candidate_key;
  const rankCandidate = (song, rank) => {
    const key = String(song.id);
    const existing = candidateRanks.get(key);
    if (!existing || rank < existing.rank) candidateRanks.set(key, { song, rank });
  };

  for (const song of preparedSongs) {
    const key = song.normalization.loose_candidate_key;
    if (key === queryKey) rankCandidate(song, 0);
    else if (key.includes(queryKey) || queryKey.includes(key)) rankCandidate(song, 2);
  }
  for (const alias of preparedAliases) {
    const key = alias.normalization.loose_candidate_key;
    if (key === queryKey) rankCandidate(alias.song, 1);
    else if (key.includes(queryKey) || queryKey.includes(key)) rankCandidate(alias.song, 3);
  }

  const candidates = [...candidateRanks.values()]
    .sort((left, right) => left.rank - right.rank || Number(left.song.id) - Number(right.song.id))
    .slice(0, 5)
    .map(({ song }) => publicSong(song));

  if (candidates.length) {
    return {
      kind: 'ambiguous',
      match_method: 'ambiguous',
      match_confidence: null,
      song: null,
      candidates,
      normalization
    };
  }
  return {
    kind: 'unmatched',
    match_method: 'unmatched',
    match_confidence: null,
    song: null,
    candidates: [],
    normalization
  };
}

async function loadPlaylistCatalog(queryable, playlistId) {
  const [songs] = await queryable.query(
    `SELECT id, playlist_id, title, artist, duration
     FROM songs
     WHERE playlist_id = ?
     ORDER BY id`,
    [playlistId]
  );
  const [aliases] = await queryable.query(
    `SELECT sa.id, sa.song_id, sa.alias, sa.normalized_alias, sa.script_key,
            sa.loose_candidate_key
     FROM song_aliases sa
     INNER JOIN songs s ON s.id = sa.song_id
     WHERE s.playlist_id = ?
     ORDER BY sa.id`,
    [playlistId]
  );
  return { songs, aliases };
}

async function matchSongInPlaylist(queryable, playlistId, query) {
  const catalog = await loadPlaylistCatalog(queryable, playlistId);
  return matchSongCatalog(catalog, query);
}

module.exports = {
  MATCH_CONFIDENCE,
  loadPlaylistCatalog,
  matchSongCatalog,
  matchSongInPlaylist,
  publicSong
};
