const { normalizeSongText } = require('../utils/songText');

const MATCH_CONFIDENCE = Object.freeze({
  exact: 1,
  normalized_exact: 0.99,
  script_exact: 0.98,
  alias_exact: 0.97,
  alias_script: 0.96,
  fuzzy: 0.9
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

function codePoints(value) {
  return Array.from(String(value || ''));
}

function editDistance(leftValue, rightValue) {
  const left = codePoints(leftValue);
  const right = codePoints(rightValue);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (
          left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
        )
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function fuzzyLayer(songs, aliases, normalization) {
  const queryKey = normalization.punctuation_key;
  const queryLength = codePoints(queryKey).length;
  if (queryLength <= 3) return null;
  const ranked = new Map();
  const rank = (song, value) => {
    const key = normalizeSongText(value).punctuation_key;
    if (!key) return;
    const distance = editDistance(queryKey, key);
    const denominator = Math.max(queryLength, codePoints(key).length, 1);
    const score = 1 - (distance / denominator);
    const existing = ranked.get(String(song.id));
    if (!existing || distance < existing.distance || (
      distance === existing.distance && score > existing.score
    )) {
      ranked.set(String(song.id), { song, distance, score });
    }
  };
  for (const song of songs) rank(song, song.title);
  for (const alias of aliases) rank(alias.song, alias.alias);
  const candidates = [...ranked.values()]
    .sort((left, right) => (
      left.distance - right.distance
      || right.score - left.score
      || Number(left.song.id) - Number(right.song.id)
    ));
  const best = candidates[0];
  const second = candidates[1];
  if (!best) return null;
  const accepted = queryLength <= 7
    ? best.distance <= 1 && (!second || second.distance - best.distance >= 1)
    : best.score >= 0.85 && (!second || best.score - second.score >= 0.1);
  if (!accepted) return null;
  return {
    kind: 'matched',
    match_method: 'fuzzy',
    match_confidence: Number(best.score.toFixed(4)),
    song: publicSong(best.song),
    candidates: [publicSong(best.song)],
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
          loose_candidate_key: alias.loose_candidate_key || normalizeSongText(alias.alias).loose_candidate_key,
          punctuation_key: normalizeSongText(alias.alias).punctuation_key
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
      preparedAliases.map((alias) => alias.song),
      (song) => preparedAliases.some(
        (alias) => String(alias.song.id) === String(song.id) && alias.alias === normalization.raw_text
      ),
      'alias_exact',
      normalization
    ),
    () => exactLayer(
      preparedSongs,
      (song) => song.normalization.whitespace_normalized.toLocaleLowerCase('en-US')
        === normalization.whitespace_normalized.toLocaleLowerCase('en-US'),
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
      preparedSongs,
      (song) => song.normalization.punctuation_key === normalization.punctuation_key,
      'normalized_exact',
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

  const fuzzy = fuzzyLayer(preparedSongs, preparedAliases, normalization);
  if (fuzzy) return fuzzy;

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
  editDistance,
  fuzzyLayer,
  loadPlaylistCatalog,
  matchSongCatalog,
  matchSongInPlaylist,
  publicSong
};
