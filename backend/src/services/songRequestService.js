const crypto = require('node:crypto');
const database = require('../config/database');
const { createContentHash } = require('../utils/canonicalJson');
const { runInTransaction } = require('../utils/databaseTransaction');
const { normalizeSongText, parseSongRequestCommand } = require('../utils/songText');
const { SongRequestError, assertExpectedVersion } = require('../utils/songRequestError');
const { findSessionByPublicId, publicSession } = require('./liveSessionService');
const { matchSongInPlaylist, publicSong } = require('./songMatcherService');
const {
  ACTIVE_LEGACY_STATUSES,
  CANONICAL_TO_LEGACY_STATUSES,
  canonicalStatus,
  isWithdrawableLegacyStatus,
  maskDisplayName,
  normalizeReasonCode,
  reasonMessage
} = require('./songRequestCanonical');
const {
  SETTING_KEYS: POLICY_SETTING_KEYS,
  activeActivityTag,
  assertSongPolicy,
  createSongRequestPolicyService,
  getQueueMetrics,
  loadPolicySettings,
  lockUserAndBindings,
  refreshCapacityState,
  resolveBoundUserByOpenId,
  settingsProjection,
  taipeiDayBounds
} = require('./songRequestPolicyService');
const {
  canSetFulfillmentType,
  canTransitionRequest,
  isTerminalRequestStatus
} = require('./songRequestStateMachine');

function toMysqlUtcDateTime(value = new Date()) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

async function ensureSongRequestsOpenSetting(queryable) {
  await queryable.query(
    `INSERT IGNORE INTO settings (setting_key, setting_value)
     VALUES ('live_home_song_requests_open', 'true')`
  );
}

async function areSongRequestsOpen(queryable, { forUpdate = false } = {}) {
  const [rows] = await queryable.query(
    `SELECT setting_value
     FROM settings
     WHERE setting_key = 'live_home_song_requests_open'
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`
  );
  return rows.length === 0 || rows[0].setting_value !== 'false';
}

async function assertSongRequestsOpen(queryable) {
  if (!await areSongRequestsOpen(queryable, { forUpdate: true })) {
    throw new SongRequestError(
      409,
      'song_requests_closed',
      '当前直播已暂停接收点歌'
    );
  }
}

async function findOpenSessionForUpdate(connection, siteId, roomId) {
  const [rows] = await connection.query(
    `SELECT id, public_id, site_id, room_id, playlist_id, title, status, version
     FROM live_sessions
     WHERE site_id = ? AND room_id = ? AND status = 'open'
     LIMIT 1
     FOR UPDATE`,
    [siteId, roomId]
  );
  return rows[0] || null;
}

async function findCurrentSessionForUpdate(connection, siteId, roomId) {
  const [rows] = await connection.query(
    `SELECT id, public_id, site_id, room_id, playlist_id, title, status, version
     FROM live_sessions
     WHERE site_id = ? AND room_id = ? AND status IN ('open','paused')
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
              COALESCE(started_at, created_at) DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [siteId, roomId]
  );
  return rows[0] || null;
}

async function findRequestByPublicId(queryable, publicId, { forUpdate = false } = {}) {
  const [rows] = await queryable.query(
    `SELECT sr.id, sr.public_id, sr.session_id, sr.site_id, sr.room_id,
            sr.source, sr.source_event_id, sr.idempotency_key,
            sr.idempotency_fingerprint, sr.requester_user_id,
            sr.requester_display_name, sr.raw_request_text, sr.requested_title,
            sr.normalized_query, sr.matched_song_id, sr.match_method,
            sr.match_confidence, sr.status, sr.fulfillment_type,
            sr.queue_order, sr.reason, sr.version, sr.requested_at,
            sr.activated_at, sr.completed_at, sr.created_at, sr.updated_at,
            details.canonical_match_method, details.reason_code,
            details.public_reason, details.internal_note
     FROM song_requests sr
     LEFT JOIN song_request_details details ON details.request_id = sr.id
     WHERE sr.public_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [publicId]
  );
  return rows[0] || null;
}

async function lockRequestAndSession(connection, publicId) {
  const candidate = await findRequestByPublicId(connection, publicId);
  if (!candidate) return { request: null, session: null };

  let session = null;
  if (candidate.session_id) {
    const [sessions] = await connection.query(
      `SELECT id, public_id, playlist_id, site_id, room_id, status, version
       FROM live_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [candidate.session_id]
    );
    session = sessions[0] || null;
  }

  const request = await findRequestByPublicId(connection, publicId, { forUpdate: true });
  if (!request) return { request: null, session };
  if (String(request.session_id ?? '') !== String(candidate.session_id ?? '')) {
    throw new SongRequestError(409, 'stale_request_version', '点歌请求已有更新，请重新加载');
  }
  return { request, session };
}

async function nextQueueOrder(connection, sessionId) {
  const [rows] = await connection.query(
    `SELECT queue_order
     FROM song_requests
     WHERE session_id = ? AND queue_order IS NOT NULL
     ORDER BY queue_order DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [sessionId]
  );
  return (BigInt(rows[0]?.queue_order || 0) + 1n).toString();
}

async function insertHistory(connection, {
  requestId,
  fromStatus = null,
  toStatus = null,
  action,
  actorUserId = null,
  reason = null,
  metadata = null
}) {
  await connection.query(
    `INSERT INTO song_request_history (
       request_id, from_status, to_status, action, actor_user_id, reason, metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      fromStatus,
      toStatus,
      action,
      actorUserId,
      reason,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function requestForManagement(row, matchedSong = null) {
  const reasonCode = row.reason_code
    || (row.reason ? normalizeReasonCode(row.reason, 'other') : null);
  return {
    public_id: row.public_id,
    session_public_id: row.session_public_id || null,
    site_id: row.site_id,
    room_id: row.room_id,
    source: row.source,
    requester_display_name: row.requester_display_name || null,
    raw_request_text: row.raw_request_text,
    requested_title: row.requested_title,
    matched_song: matchedSong,
    match_method: row.canonical_match_method || row.match_method,
    match_confidence: row.match_confidence == null ? null : Number(row.match_confidence),
    status: canonicalStatus(row.status),
    legacy_status: row.status,
    fulfillment_type: row.fulfillment_type,
    queue_order: row.queue_order == null ? null : String(row.queue_order),
    reason: row.reason || null,
    reason_code: reasonCode,
    public_reason: row.public_reason || (reasonCode ? reasonMessage(reasonCode) : null),
    internal_note: row.internal_note || null,
    version: Number(row.version),
    requested_at: row.requested_at,
    activated_at: row.activated_at,
    completed_at: row.completed_at
  };
}

function requestForPublic(row, matchedSong = null) {
  const reasonCode = row.reason_code
    || (row.reason ? normalizeReasonCode(row.reason, 'other') : null);
  const displayKey = crypto.createHash('sha256')
    .update(String(row.public_id ?? row.id ?? row.requested_at ?? 'request'))
    .digest('hex')
    .slice(0, 16);
  return {
    display_key: displayKey,
    canonical_song: matchedSong,
    matched_song: matchedSong,
    masked_display_name: maskDisplayName(row.requester_display_name),
    status: canonicalStatus(row.status),
    queue_order: row.queue_order == null ? null : String(row.queue_order),
    reason_code: reasonCode,
    public_reason: row.public_reason || (reasonCode ? reasonMessage(reasonCode) : null),
    requested_at: row.requested_at
  };
}

function requestForOwner(row, matchedSong = null) {
  const managed = requestForManagement(row, matchedSong);
  return {
    public_id: managed.public_id,
    original_input: row.raw_request_text,
    requested_title: row.requested_title,
    canonical_song: matchedSong,
    match_method: managed.match_method,
    match_confidence: managed.match_confidence,
    status: managed.status,
    fulfillment_type: managed.fulfillment_type,
    queue_order: managed.queue_order,
    reason_code: managed.reason_code,
    public_reason: managed.public_reason,
    version: managed.version,
    requested_at: managed.requested_at,
    activated_at: managed.activated_at,
    completed_at: managed.completed_at
  };
}

function matchFields(result) {
  const canonicalMatchMethod = result.match_method;
  return {
    matchedSongId: result.song?.id || null,
    matchMethod: canonicalMatchMethod === 'fuzzy' ? 'normalized_exact' : canonicalMatchMethod,
    canonicalMatchMethod,
    matchConfidence: result.match_confidence,
    normalizedQuery: result.normalization.script_key
  };
}

async function upsertRequestDetails(connection, requestId, {
  canonicalMatchMethod = null,
  reasonCode = null,
  publicReason = null,
  internalNote = null
} = {}) {
  await connection.query(
    `INSERT INTO song_request_details (
       request_id, canonical_match_method, reason_code, public_reason, internal_note
     ) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       canonical_match_method = VALUES(canonical_match_method),
       reason_code = VALUES(reason_code),
       public_reason = VALUES(public_reason),
       internal_note = VALUES(internal_note)`,
    [
      requestId,
      canonicalMatchMethod,
      reasonCode,
      publicReason,
      internalNote
    ]
  );
}

function requestSnapshot(row) {
  return {
    status: row.status,
    session_id: row.session_id,
    matched_song_id: row.matched_song_id,
    match_method: row.match_method,
    match_confidence: row.match_confidence,
    canonical_match_method: row.canonical_match_method || null,
    fulfillment_type: row.fulfillment_type,
    queue_order: row.queue_order == null ? null : String(row.queue_order),
    reason: row.reason || null,
    reason_code: row.reason_code || null,
    public_reason: row.public_reason || null,
    internal_note: row.internal_note || null,
    activated_at: row.activated_at || null,
    completed_at: row.completed_at || null
  };
}

function parseHistoryMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function historyAgeMs(row) {
  const value = Number(row?.age_ms);
  return Number.isFinite(value) ? Math.max(0, value) : Number.POSITIVE_INFINITY;
}

async function restoreRequestSnapshot(connection, request, snapshot) {
  await connection.query(
    `UPDATE song_requests
     SET session_id = ?, matched_song_id = ?, match_method = ?,
         match_confidence = ?, status = ?, fulfillment_type = ?,
         queue_order = ?, reason = ?, activated_at = ?, completed_at = ?,
         version = version + 1
     WHERE id = ?`,
    [
      snapshot.session_id ?? null,
      snapshot.matched_song_id ?? null,
      snapshot.match_method || 'unmatched',
      snapshot.match_confidence ?? null,
      snapshot.status,
      snapshot.fulfillment_type || 'undecided',
      snapshot.queue_order ?? null,
      snapshot.reason ?? null,
      snapshot.activated_at ? toMysqlUtcDateTime(snapshot.activated_at) : null,
      snapshot.completed_at ? toMysqlUtcDateTime(snapshot.completed_at) : null,
      request.id
    ]
  );
  await upsertRequestDetails(connection, request.id, {
    canonicalMatchMethod: snapshot.canonical_match_method || snapshot.match_method,
    reasonCode: snapshot.reason_code || null,
    publicReason: snapshot.public_reason || null,
    internalNote: snapshot.internal_note || null
  });
}

async function resolveRequestMatch(connection, session, { songId, query }) {
  if (songId) {
    const [songs] = await connection.query(
      `SELECT id, playlist_id, title, artist, duration
       FROM songs
       WHERE id = ? AND playlist_id = ?
       LIMIT 1`,
      [songId, session.playlist_id]
    );
    if (!songs.length) {
      throw new SongRequestError(
        422,
        'song_not_in_session_playlist',
        '所选歌曲不属于当前场次歌单'
      );
    }
    const requestedTitle = query || songs[0].title;
    const normalization = normalizeSongText(requestedTitle);
    return {
      requestedTitle,
      result: {
        kind: 'matched',
        song: publicSong(songs[0]),
        candidates: [publicSong(songs[0])],
        match_method: 'exact',
        match_confidence: 1,
        normalization
      }
    };
  }
  const result = await matchSongInPlaylist(connection, session.playlist_id, query);
  return { requestedTitle: query, result };
}

function statusForMatch(result) {
  return result.kind === 'matched' ? 'queued' : 'needs_match';
}

async function insertSongRequest(connection, input) {
  const publicId = crypto.randomUUID();
  const [result] = await connection.query(
    `INSERT INTO song_requests (
       public_id, session_id, site_id, room_id, source, source_event_id,
       idempotency_key, idempotency_fingerprint, requester_user_id,
       requester_open_id, requester_display_name, raw_request_text,
       requested_title, normalized_query, matched_song_id, match_method,
       match_confidence, status, fulfillment_type, queue_order, reason,
       requested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'undecided', ?, ?, ?)`,
    [
      publicId,
      input.sessionId,
      input.siteId,
      input.roomId,
      input.source,
      input.sourceEventId,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.requesterUserId,
      input.requesterOpenId,
      input.requesterDisplayName,
      input.rawRequestText,
      input.requestedTitle,
      input.normalizedQuery,
      input.matchedSongId,
      input.matchMethod,
      input.matchConfidence,
      input.status,
      input.queueOrder,
      input.reason,
      input.requestedAt
    ]
  );
  await upsertRequestDetails(connection, result.insertId, {
    canonicalMatchMethod: input.canonicalMatchMethod || input.matchMethod,
    reasonCode: input.reasonCode || null,
    publicReason: input.publicReason || null,
    internalNote: input.internalNote || null
  });
  if (input.sessionId && input.queueOrder !== null) {
    await connection.query(
      'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
      [input.sessionId]
    );
  }
  await insertHistory(connection, {
    requestId: result.insertId,
    toStatus: input.status,
    action: 'created',
    actorUserId: input.actorUserId,
    reason: input.reason,
    metadata: {
      source: input.source,
      match_method: input.canonicalMatchMethod || input.matchMethod,
      session_public_id: input.sessionPublicId || null,
      result_version: 0
    }
  });
  return findRequestByPublicId(connection, publicId);
}

async function getMatchedSong(queryable, songId) {
  if (!songId) return null;
  const [songs] = await queryable.query(
    'SELECT id, title, artist, duration FROM songs WHERE id = ? LIMIT 1',
    [songId]
  );
  return songs[0] ? publicSong(songs[0]) : null;
}

async function resolveWebsiteSessionForUpdate(connection, input) {
  if (input.site_id && input.room_id) {
    return findOpenSessionForUpdate(connection, input.site_id, input.room_id);
  }

  const [songs] = await connection.query(
    'SELECT id, playlist_id FROM songs WHERE id = ? LIMIT 1',
    [input.song_id]
  );
  if (!songs.length) {
    throw new SongRequestError(404, 'song_not_found', '歌曲不存在');
  }
  const [sessions] = await connection.query(
    `SELECT id, public_id, site_id, room_id, playlist_id, title, status, version
     FROM live_sessions
     WHERE playlist_id = ? AND status = 'open'
     ORDER BY started_at DESC, id DESC
     LIMIT 2
     FOR UPDATE`,
    [songs[0].playlist_id]
  );
  if (sessions.length > 1) {
    throw new SongRequestError(
      409,
      'ambiguous_open_session',
      '当前有多个开放场次，请稍后再试'
    );
  }
  return sessions[0] || null;
}

function createSongRequestService({
  pool = database,
  policyService = null,
  policy = {
    assertSongPolicy,
    lockUserAndBindings,
    resolveBoundUserByOpenId
  }
} = {}) {
  const policyStore = policyService || createSongRequestPolicyService({ pool });
  let gateInitializationPromise = null;
  const ensureGateSetting = async () => {
    if (!gateInitializationPromise) {
      gateInitializationPromise = ensureSongRequestsOpenSetting(pool)
        .catch((error) => {
          gateInitializationPromise = null;
          throw error;
        });
    }
    await gateInitializationPromise;
  };

  const service = {
    async observeAcceptedDanmaku(event, { connection }) {
      if (event.event_type !== 'danmaku') return { status: 'ignored', reason: 'not_danmaku' };
      const command = parseSongRequestCommand(event.payload.text);
      if (!command.matched) return { status: 'ignored', reason: command.reason };

      await ensureGateSetting();
      const [existing] = await connection.query(
        'SELECT public_id FROM song_requests WHERE source_event_id = ? LIMIT 1',
        [event.event_id]
      );
      if (existing.length) return { status: 'duplicate', public_id: existing[0].public_id };

      try {
        const boundUser = await policy.resolveBoundUserByOpenId(
          connection,
          event.actor?.open_id
        );
        if (!boundUser) {
          return { status: 'ignored', reason: 'identity_binding_required' };
        }
        const session = await findCurrentSessionForUpdate(
          connection,
          event.site_id,
          event.room_id
        );
        if (!session || session.status !== 'open') {
          return { status: 'ignored', reason: 'requests_closed' };
        }
        const match = await matchSongInPlaylist(
          connection,
          session.playlist_id,
          command.requested_title
        );
        const fields = matchFields(match);
        const reasonCode = match.kind === 'matched'
          ? null
          : (match.kind === 'ambiguous' ? 'title_unclear' : 'song_not_found');
        await policy.assertSongPolicy(connection, {
          sessionId: session.id,
          matchedSongId: fields.matchedSongId,
          requesterUserId: boundUser.id,
          requireBinding: true,
          userAlreadyLocked: true
        });
        const request = await insertSongRequest(connection, {
          sessionId: session.id,
          sessionPublicId: session.public_id,
          siteId: event.site_id,
          roomId: event.room_id,
          source: event.mode === 'replay'
            ? 'replay'
            : (event.mode === 'simulation' ? 'simulation' : 'bilibili_danmaku'),
          sourceEventId: event.event_id,
          idempotencyKey: null,
          idempotencyFingerprint: null,
          requesterUserId: boundUser.id,
          requesterOpenId: event.actor.open_id,
          requesterDisplayName: boundUser.username,
          rawRequestText: command.raw_text,
          requestedTitle: command.requested_title,
          normalizedQuery: fields.normalizedQuery,
          matchedSongId: fields.matchedSongId,
          matchMethod: fields.matchMethod,
          canonicalMatchMethod: fields.canonicalMatchMethod,
          matchConfidence: fields.matchConfidence,
          status: statusForMatch(match),
          queueOrder: await nextQueueOrder(connection, session.id),
          reason: reasonCode,
          reasonCode,
          publicReason: reasonCode ? reasonMessage(reasonCode) : null,
          requestedAt: toMysqlUtcDateTime(event.occurred_at),
          actorUserId: boundUser.id
        });
        return { status: 'created', request };
      } catch (error) {
        if (
          error instanceof SongRequestError
          && Number(error.status) >= 400
          && Number(error.status) < 500
        ) {
          return { status: 'ignored', reason: normalizeReasonCode(error.code) };
        }
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        const [duplicates] = await connection.query(
          'SELECT public_id FROM song_requests WHERE source_event_id = ? LIMIT 1',
          [event.event_id]
        );
        if (!duplicates.length) throw error;
        return { status: 'duplicate', public_id: duplicates[0].public_id };
      }
    },

    async createWebsiteRequest(input, { userId, idempotencyKey }) {
      const fingerprint = createContentHash({
        site_id: input.site_id,
        room_id: input.room_id,
        song_id: input.song_id || null,
        query: input.query || null
      });
      await ensureGateSetting();
      const findIdempotentRequest = async (queryable) => {
        const [rows] = await queryable.query(
          `SELECT public_id, idempotency_fingerprint
           FROM song_requests
           WHERE requester_user_id = ? AND idempotency_key = ?
           LIMIT 1`,
          [userId, idempotencyKey]
        );
        if (!rows.length) return null;
        if (rows[0].idempotency_fingerprint !== fingerprint) {
          throw new SongRequestError(
            409,
            'idempotency_key_conflict',
            '该 Idempotency-Key 已用于另一条请求'
          );
        }
        return {
          duplicate: true,
          request: await findRequestByPublicId(queryable, rows[0].public_id)
        };
      };
      const existingBeforeTransaction = await findIdempotentRequest(pool);
      if (existingBeforeTransaction) return existingBeforeTransaction;
      try {
        const result = await runInTransaction(pool, async (connection) => {
          const existing = await findIdempotentRequest(connection);
          if (existing) return existing;
          const identity = await policy.lockUserAndBindings(connection, userId, {
            requireBinding: true
          });
          const session = await resolveWebsiteSessionForUpdate(connection, input);
          if (!session) {
            throw new SongRequestError(409, 'no_open_session', '当前没有开放中的直播场次');
          }
          const { requestedTitle, result: match } = await resolveRequestMatch(connection, session, {
            songId: input.song_id,
            query: input.query
          });
          const fields = matchFields(match);
          const status = statusForMatch(match);
          const reasonCode = match.kind === 'matched'
            ? null
            : (match.kind === 'ambiguous' ? 'title_unclear' : 'song_not_found');
          await policy.assertSongPolicy(connection, {
            sessionId: session.id,
            matchedSongId: fields.matchedSongId,
            requesterUserId: userId,
            requireBinding: true,
            userAlreadyLocked: true
          });
          const request = await insertSongRequest(connection, {
            sessionId: session.id,
            sessionPublicId: session.public_id,
            siteId: session.site_id,
            roomId: session.room_id,
            source: 'website',
            sourceEventId: null,
            idempotencyKey,
            idempotencyFingerprint: fingerprint,
            requesterUserId: userId,
            requesterOpenId: null,
            requesterDisplayName: identity.user.username,
            rawRequestText: input.query || requestedTitle,
            requestedTitle,
            normalizedQuery: fields.normalizedQuery,
            matchedSongId: fields.matchedSongId,
            matchMethod: fields.matchMethod,
            canonicalMatchMethod: fields.canonicalMatchMethod,
            matchConfidence: fields.matchConfidence,
            status,
            queueOrder: await nextQueueOrder(connection, session.id),
            reason: reasonCode,
            reasonCode,
            publicReason: reasonCode ? reasonMessage(reasonCode) : null,
            requestedAt: toMysqlUtcDateTime(),
            actorUserId: userId
          });
          return { duplicate: false, request };
        });
        return result;
      } catch (error) {
        if (!['ER_DUP_ENTRY', 'song_requests_closed', 'requests_closed'].includes(error?.code)) {
          throw error;
        }
        const existing = await findIdempotentRequest(pool);
        if (!existing) throw error;
        return existing;
      }
    },

    async createManualRequest(input, actorUserId) {
      await ensureGateSetting();
      return runInTransaction(pool, async (connection) => {
        let session;
        if (input.session_public_id) {
          session = await findSessionByPublicId(connection, input.session_public_id, {
            forUpdate: true
          });
          if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
          if (session.status !== 'open') {
            throw new SongRequestError(409, 'requests_closed', '当前场次未开放点歌');
          }
          if (session.site_id !== input.site_id || session.room_id !== input.room_id) {
            throw new SongRequestError(422, 'session_target_mismatch', '场次站点或直播间不匹配');
          }
        } else {
          session = await findOpenSessionForUpdate(
            connection,
            input.site_id,
            input.room_id
          );
          if (!session) {
            throw new SongRequestError(409, 'requests_closed', '当前没有开放中的直播场次');
          }
        }

        const { requestedTitle, result: match } = await resolveRequestMatch(
          connection,
          session,
          {
            songId: input.song_id,
            query: input.query
          }
        );

        const fields = matchFields(match);
        const status = statusForMatch(match);
        const reasonCode = match.kind === 'matched'
          ? null
          : (match.kind === 'ambiguous' ? 'title_unclear' : 'song_not_found');
        await policy.assertSongPolicy(connection, {
          sessionId: session.id,
          matchedSongId: fields.matchedSongId
        });
        return insertSongRequest(connection, {
          sessionId: session.id,
          sessionPublicId: session.public_id,
          siteId: input.site_id,
          roomId: input.room_id,
          source: 'manual',
          sourceEventId: null,
          idempotencyKey: null,
          idempotencyFingerprint: null,
          requesterUserId: null,
          requesterOpenId: null,
          requesterDisplayName: input.requester_display_name || '人工点歌',
          rawRequestText: input.query || requestedTitle,
          requestedTitle,
          normalizedQuery: fields.normalizedQuery,
          matchedSongId: fields.matchedSongId,
          matchMethod: fields.matchMethod,
          canonicalMatchMethod: fields.canonicalMatchMethod,
          matchConfidence: fields.matchConfidence,
          status,
          queueOrder: await nextQueueOrder(connection, session.id),
          reason: reasonCode,
          reasonCode,
          publicReason: reasonCode ? reasonMessage(reasonCode) : null,
          requestedAt: toMysqlUtcDateTime(),
          actorUserId
        });
      });
    },

    async assignToSession(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, { forUpdate: true });
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (request.status !== 'observed') {
          throw new SongRequestError(409, 'request_not_observed', '只有待归属请求可以指派场次');
        }
        const session = await findSessionByPublicId(connection, input.session_public_id, {
          forUpdate: true
        });
        if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
        if (session.status === 'closed') {
          throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
        }
        if (session.site_id !== request.site_id || session.room_id !== request.room_id) {
          throw new SongRequestError(422, 'session_target_mismatch', '场次站点或直播间不匹配');
        }

        const match = await matchSongInPlaylist(
          connection,
          session.playlist_id,
          request.requested_title
        );
        const fields = matchFields(match);
        const toStatus = session.status === 'open' ? statusForMatch(match) : 'observed';
        const queueOrder = session.status === 'open'
          ? await nextQueueOrder(connection, session.id)
          : null;
        await policy.assertSongPolicy(connection, {
          sessionId: session.id,
          matchedSongId: fields.matchedSongId,
          requestId: request.id
        });
        await connection.query(
          `UPDATE song_requests
           SET session_id = ?, matched_song_id = ?, match_method = ?,
               match_confidence = ?, normalized_query = ?, status = ?,
               queue_order = ?, reason = ?, version = version + 1
           WHERE id = ?`,
          [
            session.id,
            fields.matchedSongId,
            fields.matchMethod,
            fields.matchConfidence,
            fields.normalizedQuery,
            toStatus,
            queueOrder,
            input.reason || null,
            request.id
          ]
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: fields.canonicalMatchMethod,
          reasonCode: input.reason_code || null,
          publicReason: input.public_reason || null,
          internalNote: input.internal_note || null
        });
        if (queueOrder !== null) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [session.id]
          );
        }
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus,
          action: 'assigned',
          actorUserId,
          reason: input.reason || null,
          metadata: {
            session_public_id: session.public_id,
            match_method: fields.canonicalMatchMethod,
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async setManualMatch(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const { request, session } = await lockRequestAndSession(connection, requestPublicId);
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!['observed', 'needs_match', 'queued'].includes(request.status)) {
          throw new SongRequestError(409, 'request_not_matchable', '当前状态不能修改歌曲匹配');
        }
        if (!request.session_id) {
          throw new SongRequestError(409, 'request_has_no_session', '请先将请求指派到直播场次');
        }
        if (!session || session.status !== 'open') {
          throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
        }
        const [songs] = await connection.query(
          `SELECT id FROM songs WHERE id = ? AND playlist_id = ? LIMIT 1`,
          [input.song_id, session.playlist_id]
        );
        if (!songs.length) {
          throw new SongRequestError(
            422,
            'song_not_in_session_playlist',
            '所选歌曲不属于当前场次歌单'
          );
        }
        await policy.assertSongPolicy(connection, {
          sessionId: session.id,
          matchedSongId: input.song_id,
          requestId: request.id
        });
        const toStatus = 'queued';
        const queueOrder = request.queue_order || await nextQueueOrder(connection, session.id);
        if (input.save_alias && request.requested_title) {
          const normalizedAlias = normalizeSongText(request.requested_title);
          try {
            await connection.query(
              `INSERT INTO song_aliases (
                 song_id, alias, normalized_alias, script_key,
                 loose_candidate_key, created_by_user_id
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                input.song_id,
                normalizedAlias.raw_text.trim(),
                normalizedAlias.whitespace_normalized,
                normalizedAlias.script_key,
                normalizedAlias.loose_candidate_key,
                actorUserId
              ]
            );
          } catch (error) {
            if (error?.code === 'ER_DUP_ENTRY') {
              throw new SongRequestError(
                409,
                'equivalent_alias_exists',
                '该别名与现有歌曲别名冲突'
              );
            }
            throw error;
          }
        }
        await connection.query(
          `UPDATE song_requests
           SET matched_song_id = ?, match_method = 'manual', match_confidence = 1,
               status = ?, queue_order = ?, reason = ?, version = version + 1
           WHERE id = ?`,
          [input.song_id, toStatus, queueOrder, input.reason || null, request.id]
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: 'manual',
          reasonCode: input.reason_code || null,
          publicReason: input.public_reason || null,
          internalNote: input.internal_note || null
        });
        if (request.queue_order === null) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [session.id]
          );
        }
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus,
          action: 'matched',
          actorUserId,
          reason: input.reason || null,
          metadata: {
            matched_song_id: input.song_id,
            alias_saved: Boolean(input.save_alias),
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async acceptUnmatched(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const { request, session } = await lockRequestAndSession(connection, requestPublicId);
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!['observed', 'needs_match'].includes(request.status) || !request.session_id) {
          throw new SongRequestError(409, 'request_not_acceptable', '当前状态不能接受该请求');
        }
        if (!session || session.status !== 'open') {
          throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
        }
        await policy.assertSongPolicy(connection, {
          sessionId: request.session_id,
          matchedSongId: request.matched_song_id,
          requestId: request.id
        });
        const queueOrder = request.queue_order || await nextQueueOrder(
          connection,
          request.session_id
        );
        await connection.query(
          `UPDATE song_requests
           SET match_method = 'manual', status = 'queued', queue_order = ?,
               reason = ?, version = version + 1
           WHERE id = ?`,
          [queueOrder, input.reason || null, request.id]
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: 'manual',
          reasonCode: input.reason_code || null,
          publicReason: input.public_reason || null,
          internalNote: input.internal_note || null
        });
        if (request.queue_order === null) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [request.session_id]
          );
        }
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus: 'queued',
          action: 'accepted_unmatched',
          actorUserId,
          reason: input.reason || null,
          metadata: {
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async setFulfillmentType(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, { forUpdate: true });
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!canSetFulfillmentType(request.status)) {
          throw new SongRequestError(
            409,
            'fulfillment_type_locked',
            '只有排队中或处理中的请求可以设置完成方式'
          );
        }
        await connection.query(
          `UPDATE song_requests
           SET fulfillment_type = ?, reason = ?, version = version + 1
           WHERE id = ?`,
          [input.fulfillment_type, input.reason || null, request.id]
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: request.canonical_match_method || request.match_method,
          reasonCode: input.reason_code || request.reason_code,
          publicReason: input.public_reason || request.public_reason,
          internalNote: input.internal_note || request.internal_note
        });
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus: request.status,
          action: 'fulfillment_type_changed',
          actorUserId,
          reason: input.reason || null,
          metadata: {
            from_fulfillment_type: request.fulfillment_type,
            to_fulfillment_type: input.fulfillment_type,
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async transitionRequest(requestPublicId, toStatus, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const { request, session } = await lockRequestAndSession(connection, requestPublicId);
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!canTransitionRequest(request.status, toStatus)) {
          throw new SongRequestError(
            409,
            'invalid_request_transition',
            `点歌请求不能从 ${request.status} 转换为 ${toStatus}`
          );
        }
        if (toStatus === 'queued' && !['failed', 'skipped'].includes(request.status)) {
          throw new SongRequestError(
            409,
            'match_confirmation_required',
            '请先通过场次指派或人工匹配确认该请求'
          );
        }
        if (toStatus === 'completed' && request.fulfillment_type === 'undecided') {
          throw new SongRequestError(
            409,
            'fulfillment_type_required',
            '完成请求前必须选择演唱或播放'
          );
        }

        let queueOrder = request.queue_order;
        if (toStatus === 'queued') {
          if (!request.session_id) {
            throw new SongRequestError(409, 'request_has_no_session', '点歌请求尚未归属直播场次');
          }
          if (!session || session.status !== 'open') {
            throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
          }
          await policy.assertSongPolicy(connection, {
            sessionId: request.session_id,
            matchedSongId: request.matched_song_id,
            requestId: request.id,
            requesterUserId: request.requester_user_id,
            requireBinding: Boolean(request.requester_user_id)
          });
          queueOrder = await nextQueueOrder(connection, request.session_id);
        }
        if (toStatus === 'active') {
          if (!session || session.status === 'closed') {
            throw new SongRequestError(409, 'session_closed', '已关闭的场次不能开始处理请求');
          }
          const [activeRequests] = await connection.query(
            `SELECT id
             FROM song_requests
             WHERE session_id = ? AND status = 'active' AND id <> ?
             LIMIT 1
             FOR UPDATE`,
            [request.session_id, request.id]
          );
          if (activeRequests.length) {
            throw new SongRequestError(
              409,
              'active_request_exists',
              '当前已有正在处理的歌曲'
            );
          }
        }
        const previousQueueOrder = request.queue_order;
        if (isTerminalRequestStatus(toStatus) || ['active', 'failed'].includes(toStatus)) {
          queueOrder = null;
        }

        const activatedAt = toStatus === 'active' ? 'UTC_TIMESTAMP(3)' : 'activated_at';
        const completedAt = toStatus === 'completed' ? 'UTC_TIMESTAMP(3)' : 'completed_at';
        await connection.query(
          `UPDATE song_requests
           SET status = ?, queue_order = ?, reason = ?,
               activated_at = ${activatedAt}, completed_at = ${completedAt},
               version = version + 1
           WHERE id = ?`,
          [toStatus, queueOrder, input.reason || null, request.id]
        );
        const fallbackReasonCode = toStatus === 'rejected'
          ? 'manual_rejection'
          : (toStatus === 'skipped' ? 'manual_skip' : null);
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: request.canonical_match_method || request.match_method,
          reasonCode: input.reason_code || fallbackReasonCode,
          publicReason: input.public_reason || (
            fallbackReasonCode ? reasonMessage(fallbackReasonCode) : null
          ),
          internalNote: input.internal_note || null
        });
        if (String(previousQueueOrder ?? '') !== String(queueOrder ?? '') && request.session_id) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [request.session_id]
          );
        }
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus,
          action: `status_${toStatus}`,
          actorUserId,
          reason: input.reason || null,
          metadata: {
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async advanceCurrent(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const { request, session } = await lockRequestAndSession(connection, requestPublicId);
        if (!request) {
          throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        }
        assertExpectedVersion(request.version, input.expected_version);
        if (request.status !== 'active') {
          throw new SongRequestError(
            409,
            'request_not_active',
            '只有当前正在处理的歌曲可以完成或跳过'
          );
        }
        if (!request.session_id) {
          throw new SongRequestError(
            409,
            'request_has_no_session',
            '当前歌曲尚未归属直播场次'
          );
        }

        if (!session || session.status === 'closed') {
          throw new SongRequestError(
            409,
            'session_closed',
            '已关闭的场次不能切换当前歌曲'
          );
        }

        let next = null;
        if (input.activate_next) {
          const [nextRows] = await connection.query(
            `SELECT public_id, id, status, version
             FROM song_requests
             WHERE session_id = ? AND status = 'queued'
             ORDER BY queue_order, id
             LIMIT 1
             FOR UPDATE`,
            [request.session_id]
          );
          next = nextRows[0] || null;
        }
        const operationId = crypto.randomUUID();

        const completedAt = input.outcome === 'completed'
          ? 'UTC_TIMESTAMP(3)'
          : 'completed_at';
        await connection.query(
          `UPDATE song_requests
           SET status = ?, fulfillment_type = ?, queue_order = NULL,
               reason = ?, completed_at = ${completedAt},
               version = version + 1
           WHERE id = ?`,
          [
            input.outcome,
            input.outcome === 'completed' ? 'sung' : request.fulfillment_type,
            input.reason || null,
            request.id
          ]
        );
        const outcomeReasonCode = input.reason_code || (
          input.outcome === 'skipped' ? 'manual_skip' : null
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: request.canonical_match_method || request.match_method,
          reasonCode: outcomeReasonCode,
          publicReason: input.public_reason || (
            outcomeReasonCode ? reasonMessage(outcomeReasonCode) : null
          ),
          internalNote: input.internal_note || null
        });
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus: input.outcome,
          action: `status_${input.outcome}`,
          actorUserId,
          reason: input.reason || null,
          metadata: {
            operation_id: operationId,
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });

        if (next) {
          const nextRequest = await findRequestByPublicId(
            connection,
            next.public_id,
            { forUpdate: true }
          );
          await connection.query(
            `UPDATE song_requests
             SET status = 'active', queue_order = NULL,
                 activated_at = UTC_TIMESTAMP(3), reason = NULL,
                 version = version + 1
             WHERE id = ?`,
            [next.id]
          );
          await insertHistory(connection, {
            requestId: next.id,
            fromStatus: next.status,
            toStatus: 'active',
            action: 'status_active',
            actorUserId,
            metadata: {
              operation_id: operationId,
              advanced_from_request_id: request.id,
              before: requestSnapshot(nextRequest),
              result_version: Number(nextRequest.version) + 1
            }
          });
        }

        await connection.query(
          'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
          [request.session_id]
        );
        return {
          previous: await findRequestByPublicId(connection, requestPublicId),
          current: next
            ? await findRequestByPublicId(connection, next.public_id)
            : null
        };
      });
    },

    async reorder(sessionPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const session = await findSessionByPublicId(connection, sessionPublicId, { forUpdate: true });
        if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
        assertExpectedVersion(session.version, input.expected_version);
        if (!['open', 'paused'].includes(session.status)) {
          throw new SongRequestError(409, 'session_not_active', '只有开放中或暂停中的场次可以排序');
        }
        if (new Set(input.request_public_ids).size !== input.request_public_ids.length) {
          throw new SongRequestError(422, 'invalid_reorder_set', '排序列表包含重复请求');
        }

        const [rows] = await connection.query(
          `SELECT sr.*, details.canonical_match_method, details.reason_code,
                  details.public_reason, details.internal_note
           FROM song_requests sr
           LEFT JOIN song_request_details details ON details.request_id = sr.id
           WHERE sr.session_id = ? AND sr.status IN ('needs_match','queued')
           ORDER BY queue_order, id
           FOR UPDATE`,
          [session.id]
        );
        const expected = new Set(rows.map((row) => row.public_id));
        if (
          expected.size !== input.request_public_ids.length ||
          input.request_public_ids.some((publicId) => !expected.has(publicId))
        ) {
          throw new SongRequestError(
            422,
            'invalid_reorder_set',
            '排序列表必须完整且不重复地包含当前场次所有待匹配与排队请求'
          );
        }

        await connection.query(
          `UPDATE song_requests
           SET queue_order = NULL
           WHERE session_id = ? AND status IN ('needs_match','queued')`,
          [session.id]
        );
        const rowsByPublicId = new Map(rows.map((row) => [row.public_id, row]));
        const operationId = crypto.randomUUID();
        let changed = false;
        for (const [index, publicId] of input.request_public_ids.entries()) {
          const row = rowsByPublicId.get(publicId);
          const newOrder = String(index + 1);
          const orderChanged = String(row.queue_order) !== newOrder;
          await connection.query(
            `UPDATE song_requests
             SET queue_order = ?, version = version + ?
             WHERE id = ?`,
            [newOrder, orderChanged ? 1 : 0, row.id]
          );
          if (orderChanged) {
            changed = true;
            await insertHistory(connection, {
              requestId: row.id,
              fromStatus: row.status,
              toStatus: row.status,
              action: 'reordered',
              actorUserId,
              metadata: {
                operation_id: operationId,
                from_queue_order: String(row.queue_order),
                to_queue_order: newOrder,
                before: requestSnapshot(row),
                result_version: Number(row.version) + 1
              }
            });
          }
        }
        if (changed) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [session.id]
          );
        }
        return {
          session: publicSession(await findSessionByPublicId(connection, sessionPublicId)),
          request_public_ids: input.request_public_ids
        };
      });
    },

    async getCenter(userId = null) {
      return runInTransaction(pool, async (connection) => {
        const [sessions] = await connection.query(
          `SELECT id, public_id, title, status
           FROM live_sessions
           WHERE status IN ('open','paused')
           ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                    COALESCE(started_at, created_at) DESC, id DESC
           LIMIT 1`
        );
        const session = sessions[0] || null;
        const capacity = await refreshCapacityState(connection, session?.id || null);
        const etaById = new Map(
          capacity.metrics.requests.map((item) => [item.public_id, item])
        );
        const [rows] = session
          ? await connection.query(
            `SELECT sr.id, sr.public_id, sr.requester_user_id,
                    sr.requester_display_name, sr.status, sr.queue_order,
                    sr.requested_at, sr.reason, details.reason_code,
                    details.public_reason, s.id AS song_id, s.title AS song_title,
                    s.artist AS song_artist, s.duration AS song_duration
             FROM song_requests sr
             LEFT JOIN song_request_details details ON details.request_id = sr.id
             LEFT JOIN songs s ON s.id = sr.matched_song_id
             WHERE sr.session_id = ?
               AND sr.status IN ('needs_match','queued','active')
             ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
                      sr.queue_order, sr.id`,
            [session.id]
          )
          : [[]];
        const publicRows = rows.map((row) => ({
          ...requestForPublic(
            row,
            row.song_id ? publicSong({
              id: row.song_id,
              title: row.song_title,
              artist: row.song_artist,
              duration: row.song_duration
            }) : null
          ),
          position: etaById.get(row.public_id)?.position ?? null,
          eta: etaById.get(row.public_id)?.eta || null,
          is_mine: Boolean(userId && Number(row.requester_user_id) === Number(userId))
        }));
        const bounds = taipeiDayBounds();
        const [completedRows] = await connection.query(
          `SELECT sr.id, sr.status, sr.requester_display_name, sr.requested_at,
                  sr.reason, details.reason_code, details.public_reason,
                  s.id AS song_id, s.title AS song_title,
                  s.artist AS song_artist, s.duration AS song_duration
           FROM song_requests sr
           LEFT JOIN song_request_details details ON details.request_id = sr.id
           LEFT JOIN songs s ON s.id = sr.matched_song_id
           WHERE sr.status = 'completed'
             AND sr.completed_at >= ? AND sr.completed_at < ?
           ORDER BY sr.completed_at DESC, sr.id DESC
           LIMIT 50`,
          [bounds.start, bounds.end]
        );
        const settings = capacity.settings;
        const [activityRows] = await connection.query(
          `SELECT setting_key, setting_value
           FROM settings
           WHERE setting_key IN (
             'live_home_activity_title',
             'live_home_activity_content',
             'live_home_activity_starts_at',
             'live_home_activity_ends_at'
           )`
        );
        const activitySettings = new Map(
          activityRows.map((row) => [row.setting_key, row.setting_value])
        );
        const activeTagId = activeActivityTag(settings);
        const activity = activeTagId ? {
          tag_id: activeTagId,
          title: activitySettings.get('live_home_activity_title') || '',
          content: activitySettings.get('live_home_activity_content') || '',
          starts_at: activitySettings.get('live_home_activity_starts_at') || null,
          ends_at: activitySettings.get('live_home_activity_ends_at') || null
        } : null;
        return {
          session: session ? {
            public_id: session.public_id,
            title: session.title,
            status: session.status
          } : null,
          effective_open: Boolean(session && capacity.effective_open),
          manual_open: capacity.manual_open,
          auto_capacity_blocked: capacity.auto_capacity_blocked,
          close_reason: !session ? 'requests_closed' : capacity.public_reason,
          capacity_count: capacity.metrics.waiting_count,
          queue_limit: capacity.queue_limit,
          reopen_threshold: capacity.reopen_threshold,
          eta_paused: capacity.eta_paused,
          current: publicRows.find((row) => row.status === 'singing') || null,
          next: publicRows.find((row) => row.status !== 'singing') || null,
          queue: publicRows.filter((row) => row.status !== 'singing'),
          today_completed: completedRows.map((row) => requestForPublic(
            row,
            row.song_id ? publicSong({
              id: row.song_id,
              title: row.song_title,
              artist: row.song_artist,
              duration: row.song_duration
            }) : null
          )),
          activity,
          updated_at: capacity.metrics.updated_at
        };
      });
    },

    async getMine(userId, { status, page = 1, limit = 20 } = {}) {
      const [bindingRows] = await pool.query(
        `SELECT id
         FROM user_bilibili_bindings
         WHERE user_id = ? AND status = 'verified'
         ORDER BY id`,
        [userId]
      );
      const activeStatuses = ['observed', 'needs_match', 'queued', 'active'];
      const [activeRows] = await pool.query(
        `SELECT sr.*, details.canonical_match_method, details.reason_code,
                details.public_reason, s.id AS song_id, s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE sr.requester_user_id = ?
           AND sr.status IN (${activeStatuses.map(() => '?').join(',')})
         ORDER BY sr.requested_at DESC, sr.id DESC
         LIMIT 1`,
        [userId, ...activeStatuses]
      );
      let activeRequest = activeRows[0] ? requestForOwner(
        activeRows[0],
        activeRows[0].song_id ? publicSong({
          id: activeRows[0].song_id,
          title: activeRows[0].song_title,
          artist: activeRows[0].song_artist,
          duration: activeRows[0].song_duration
        }) : null
      ) : null;
      if (activeRequest && activeRows[0].session_id) {
        const settings = await loadPolicySettings(pool);
        const metrics = await getQueueMetrics(pool, activeRows[0].session_id, settings);
        const ownEta = metrics.requests.find(
          ({ public_id: publicId }) => publicId === activeRows[0].public_id
        );
        activeRequest = {
          ...activeRequest,
          position: ownEta?.position ?? null,
          eta: ownEta?.eta || null
        };
      }
      const conditions = [
        'sr.requester_user_id = ?',
        `sr.status NOT IN (${activeStatuses.map(() => '?').join(',')})`
      ];
      const params = [userId, ...activeStatuses];
      const requestedStatuses = status ? CANONICAL_TO_LEGACY_STATUSES[status] : null;
      const activeOnlyFilter = requestedStatuses?.every((item) => (
        activeStatuses.includes(item)
      ));
      if (requestedStatuses && !activeOnlyFilter) {
        const statuses = requestedStatuses;
        conditions.push(`sr.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
      const where = conditions.join(' AND ');
      const [[countRow]] = activeOnlyFilter ? [[{ count: 0 }]] : await pool.query(
        `SELECT COUNT(*) AS count FROM song_requests sr WHERE ${where}`,
        params
      );
      const [rows] = activeOnlyFilter ? [[]] : await pool.query(
        `SELECT sr.*, details.canonical_match_method, details.reason_code,
                details.public_reason, s.id AS song_id, s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE ${where}
         ORDER BY sr.requested_at DESC, sr.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit]
      );
      const mapped = rows.map((row) => requestForOwner(
        row,
        row.song_id ? publicSong({
          id: row.song_id,
          title: row.song_title,
          artist: row.song_artist,
          duration: row.song_duration
        }) : null
      ));
      const total = Number(countRow.count);
      return {
        binding: {
          bound: bindingRows.length > 0,
          count: bindingRows.length
        },
        active_request: activeRequest,
        history: mapped,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit))
        }
      };
    },

    async withdraw(requestPublicId, userId, expectedVersion = null) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, {
          forUpdate: true
        });
        if (!request || Number(request.requester_user_id) !== Number(userId)) {
          throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        }
        if (expectedVersion !== null) {
          assertExpectedVersion(request.version, expectedVersion);
        }
        if (!isWithdrawableLegacyStatus(request.status)) {
          throw new SongRequestError(409, 'request_not_withdrawable', '当前状态不能撤回');
        }
        await connection.query(
          `UPDATE song_requests
           SET status = 'cancelled', queue_order = NULL, reason = 'withdrawn_by_user',
               version = version + 1
           WHERE id = ?`,
          [request.id]
        );
        await upsertRequestDetails(connection, request.id, {
          canonicalMatchMethod: request.canonical_match_method || request.match_method,
          reasonCode: 'other',
          publicReason: '已由点歌者撤回',
          internalNote: null
        });
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus: 'cancelled',
          action: 'withdrawn_by_user',
          actorUserId: userId,
          metadata: {
            before: requestSnapshot(request),
            result_version: Number(request.version) + 1
          }
        });
        if (request.session_id) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [request.session_id]
          );
        }
        const updated = await findRequestByPublicId(connection, requestPublicId);
        return requestForOwner(
          updated,
          await getMatchedSong(connection, updated.matched_song_id)
        );
      });
    },

    async rerequest(requestPublicId, userId, idempotencyKey) {
      const request = await findRequestByPublicId(pool, requestPublicId);
      if (!request || Number(request.requester_user_id) !== Number(userId)) {
        throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
      }
      if (!['completed', 'skipped', 'failed', 'rejected', 'cancelled'].includes(request.status)) {
        throw new SongRequestError(409, 'request_not_rerequestable', '当前请求不能再次点歌');
      }
      return service.createWebsiteRequest({
        site_id: request.site_id,
        room_id: request.room_id,
        song_id: request.matched_song_id || undefined,
        query: request.matched_song_id ? undefined : request.requested_title
      }, { userId, idempotencyKey });
    },

    async undoLatest(expectedRevision, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const [observedLatestRows] = await connection.query(
          `SELECT h.id, h.request_id, h.metadata, h.created_at,
                  TIMESTAMPDIFF(
                    MICROSECOND, h.created_at, UTC_TIMESTAMP(3)
                  ) / 1000 AS age_ms
           FROM song_request_history h
           ORDER BY h.id DESC
           LIMIT 1`
        );
        const observedLatest = observedLatestRows[0];
        if (!observedLatest || Number(observedLatest.id) !== Number(expectedRevision)) {
          throw new SongRequestError(409, 'undo_conflict', '队列已有更新，请重新加载');
        }
        const observedMetadata = parseHistoryMetadata(observedLatest.metadata);
        if (!observedMetadata.before) {
          throw new SongRequestError(409, 'undo_conflict', '最近操作不能安全撤销');
        }
        if (historyAgeMs(observedLatest) > 30_000) {
          throw new SongRequestError(409, 'undo_expired', '撤销时间已超过 30 秒');
        }

        let observedHistoryRows = [observedLatest];
        if (observedMetadata.operation_id) {
          [observedHistoryRows] = await connection.query(
            `SELECT id, request_id, metadata
             FROM song_request_history
             WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.operation_id')) = ?
             ORDER BY id`,
            [observedMetadata.operation_id]
          );
        }
        const sessionIds = new Set();
        for (const history of observedHistoryRows) {
          const metadata = parseHistoryMetadata(history.metadata);
          if (metadata.before?.session_id) {
            sessionIds.add(Number(metadata.before.session_id));
          }
          const [requestRefs] = await connection.query(
            'SELECT session_id FROM song_requests WHERE id = ? LIMIT 1',
            [history.request_id]
          );
          if (requestRefs[0]?.session_id) {
            sessionIds.add(Number(requestRefs[0].session_id));
          }
        }

        let lockedSessions = [];
        if (sessionIds.size) {
          [lockedSessions] = await connection.query(
            `SELECT id, status
             FROM live_sessions
             WHERE id IN (${[...sessionIds].map(() => '?').join(',')})
             ORDER BY id
             FOR UPDATE`,
            [...sessionIds].sort((left, right) => left - right)
          );
        }
        const sessionsById = new Map(
          lockedSessions.map((session) => [Number(session.id), session])
        );

        const [latestRows] = await connection.query(
          `SELECT h.id, h.request_id, h.metadata, h.created_at,
                  TIMESTAMPDIFF(
                    MICROSECOND, h.created_at, UTC_TIMESTAMP(3)
                  ) / 1000 AS age_ms
           FROM song_request_history h
           ORDER BY h.id DESC
           LIMIT 1
           FOR UPDATE`
        );
        const latest = latestRows[0];
        if (!latest || Number(latest.id) !== Number(expectedRevision)) {
          throw new SongRequestError(409, 'undo_conflict', '队列已有更新，请重新加载');
        }
        if (historyAgeMs(latest) > 30_000) {
          throw new SongRequestError(409, 'undo_expired', 'Undo window has expired');
        }
        const latestMetadata = parseHistoryMetadata(latest.metadata);
        let historyRows = [latest];
        if (latestMetadata.operation_id) {
          [historyRows] = await connection.query(
            `SELECT id, request_id, metadata
             FROM song_request_history
             WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.operation_id')) = ?
             ORDER BY id
             FOR UPDATE`,
            [latestMetadata.operation_id]
          );
        }
        const pendingRestores = [];
        for (const history of [...historyRows].sort(
          (left, right) => Number(left.request_id) - Number(right.request_id)
        )) {
          const metadata = parseHistoryMetadata(history.metadata);
          if (!metadata.before || !Number.isInteger(Number(metadata.result_version))) {
            throw new SongRequestError(409, 'undo_conflict', '撤销资料不完整');
          }
          const [requestRows] = await connection.query(
            `SELECT sr.*, details.canonical_match_method, details.reason_code,
                    details.public_reason, details.internal_note
             FROM song_requests sr
             LEFT JOIN song_request_details details ON details.request_id = sr.id
             WHERE sr.id = ?
             LIMIT 1
             FOR UPDATE`,
            [history.request_id]
          );
          const request = requestRows[0];
          if (!request || Number(request.version) !== Number(metadata.result_version)) {
            throw new SongRequestError(409, 'undo_conflict', '队列已有更新，请重新加载');
          }
          pendingRestores.push({ history, metadata, request });
        }

        const reactivatesQueue = pendingRestores.some(({ metadata, request }) => (
          ACTIVE_LEGACY_STATUSES.includes(metadata.before.status)
          && !ACTIVE_LEGACY_STATUSES.includes(request.status)
        ));
        if (pendingRestores.length) {
          await connection.query(
            `UPDATE song_requests
             SET queue_order = NULL
             WHERE id IN (${pendingRestores.map(() => '?').join(',')})`,
            pendingRestores.map(({ request }) => request.id)
          );
        }
        if (reactivatesQueue) {
          await connection.query(
            `UPDATE song_requests
             SET status = 'failed', queue_order = NULL
             WHERE id IN (${pendingRestores.map(() => '?').join(',')})`,
            pendingRestores.map(({ request }) => request.id)
          );
        }

        const restored = [];
        const touchedSessionIds = new Set();
        const orderedRestores = [...pendingRestores].sort((left, right) => (
          (left.metadata.before.status === 'active' ? 0 : 1)
          - (right.metadata.before.status === 'active' ? 0 : 1)
        ));
        for (const { history, metadata, request } of orderedRestores) {
          if (reactivatesQueue && ACTIVE_LEGACY_STATUSES.includes(metadata.before.status)) {
            const session = sessionsById.get(Number(metadata.before.session_id));
            if (!session || session.status !== 'open') {
              throw new SongRequestError(
                409,
                'undo_conflict',
                '当前直播场次不再允许恢复该队列操作'
              );
            }
            await policy.assertSongPolicy(connection, {
              sessionId: Number(metadata.before.session_id),
              matchedSongId: metadata.before.matched_song_id,
              requestId: request.id,
              requesterUserId: request.requester_user_id,
              requireBinding: Boolean(request.requester_user_id)
            });
            if (metadata.before.status === 'active') {
              const [activeRequests] = await connection.query(
                `SELECT id
                 FROM song_requests
                 WHERE session_id = ? AND status = 'active' AND id <> ?
                 LIMIT 1
                 FOR UPDATE`,
                [metadata.before.session_id, request.id]
              );
              if (activeRequests.length) {
                throw new SongRequestError(
                  409,
                  'undo_conflict',
                  '当前已有正在处理的歌曲，不能恢复这次操作'
                );
              }
            }
          }
          await restoreRequestSnapshot(connection, request, metadata.before);
          if (request.session_id) touchedSessionIds.add(Number(request.session_id));
          if (metadata.before.session_id) {
            touchedSessionIds.add(Number(metadata.before.session_id));
          }
          await insertHistory(connection, {
            requestId: request.id,
            fromStatus: request.status,
            toStatus: metadata.before.status,
            action: 'undo',
            actorUserId,
            metadata: { undo_of_history_id: Number(history.id) }
          });
          restored.push(request.public_id);
        }
        for (const sessionId of touchedSessionIds) {
          await connection.query(
            'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
            [sessionId]
          );
          await refreshCapacityState(connection, sessionId);
        }
        return { status: 'accepted', restored_request_public_ids: restored };
      });
    },

    async getPolicySettings() {
      const settings = await policyStore.getSettings();
      return {
        cooldown_minutes: settings.cooldown_minutes,
        block_repeat_today: settings.block_repeat_today,
        queue_limit: settings.queue_limit,
        reopen_threshold: settings.reopen_threshold,
        max_eta_minutes: settings.max_eta_minutes,
        reopen_eta_minutes: settings.reopen_eta_minutes,
        default_song_seconds: settings.default_song_seconds,
        buffer_seconds: settings.buffer_seconds,
        eta_paused: settings.eta_paused,
        active_event_tag_id: settings.active_event_tag_id,
        revision: settings.revision
      };
    },

    updatePolicySettings(input, actorUserId) {
      return policyStore.updateSettings(input, actorUserId);
    },

    async setEtaPaused(paused, expectedRevision, actorUserId) {
      return policyStore.updateSettings({
        eta_paused: paused,
        expected_revision: expectedRevision
      }, actorUserId);
    },

    getSongPolicy(songId) {
      return policyStore.getPolicy(songId, { admin: true });
    },

    setSongPolicy(songId, input, actorUserId) {
      return policyStore.setPolicy(songId, input, actorUserId);
    },

    releaseSongPolicy(songId, expectedVersion, actorUserId) {
      return policyStore.releasePolicy(
        songId,
        expectedVersion,
        actorUserId
      );
    },

    async getCurrentQueue(siteId, roomId) {
      const params = [];
      let targetWhere = '';
      if (siteId && roomId) {
        targetWhere = 'AND site_id = ? AND room_id = ?';
        params.push(siteId, roomId);
      }
      const [sessions] = await pool.query(
        `SELECT id, public_id, title, status
         FROM live_sessions
         WHERE status IN ('open','paused') ${targetWhere}
         ORDER BY started_at DESC, id DESC
         LIMIT 2`,
        params
      );
      if (!siteId && sessions.length > 1) {
        throw new SongRequestError(
          409,
          'ambiguous_active_session',
          '当前有多个直播场次，无法确定公开队列'
        );
      }
      if (!sessions.length) return { session: null, requests: [] };
      const session = sessions[0];
      const [rows] = await pool.query(
        `SELECT sr.id, sr.public_id, sr.requester_display_name, sr.status,
                sr.queue_order, sr.requested_at, sr.reason,
                details.reason_code, details.public_reason,
                s.id AS song_id, s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE sr.session_id = ?
           AND sr.status IN ('needs_match','queued','active')
         ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
                  sr.queue_order, sr.requested_at, sr.id`,
        [session.id]
      );
      return {
        session: {
          public_id: session.public_id,
          title: session.title,
          status: session.status
        },
        requests: rows.map((row) => requestForPublic(
          row,
          row.song_title ? publicSong({
            id: row.song_id,
            title: row.song_title,
            artist: row.song_artist,
            duration: row.song_duration
          }) : null
        ))
      };
    },

    async getHistory({ query = '', status, source, page = 1, limit = 20 } = {}) {
      const conditions = [];
      const params = [];
      if (query) {
        const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
        conditions.push(`(
          sr.requested_title LIKE ? ESCAPE '\\\\' OR
          s.title LIKE ? ESCAPE '\\\\' OR
          s.artist LIKE ? ESCAPE '\\\\' OR
          sr.requester_display_name LIKE ? ESCAPE '\\\\'
        )`);
        params.push(pattern, pattern, pattern, pattern);
      }
      if (status) {
        const statuses = CANONICAL_TO_LEGACY_STATUSES[status] || [status];
        conditions.push(`sr.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
      if (source) {
        conditions.push('sr.source = ?');
        params.push(source);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM song_requests sr
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         ${where}`,
        params
      );
      const offset = (page - 1) * limit;
      const [rows] = await pool.query(
        `SELECT sr.public_id, sr.requested_title, sr.requester_display_name,
                sr.source, sr.status, sr.fulfillment_type, sr.requested_at,
                sr.activated_at, sr.completed_at, details.reason_code,
                details.public_reason, details.internal_note,
                s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration,
                (
                  SELECT h.created_at
                  FROM song_request_history h
                  WHERE h.request_id = sr.id
                  ORDER BY h.id DESC
                  LIMIT 1
                ) AS last_action_at,
                (
                  SELECT u.username
                  FROM song_request_history h
                  LEFT JOIN users u ON u.id = h.actor_user_id
                  WHERE h.request_id = sr.id
                  ORDER BY h.id DESC
                  LIMIT 1
                ) AS last_actor_display_name
         FROM song_requests sr
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         ${where}
         ORDER BY sr.requested_at DESC, sr.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = Number(countRow.count);
      return {
        requests: rows.map((row) => ({
          public_id: row.public_id,
          requested_title: row.requested_title,
          matched_song: row.song_title
            ? {
              title: row.song_title,
              artist: row.song_artist,
              duration: row.song_duration || null
            }
            : null,
          requester_display_name: row.requester_display_name || null,
          source: row.source,
          status: canonicalStatus(row.status),
          legacy_status: row.status,
          fulfillment_type: row.fulfillment_type,
          reason_code: row.reason_code || null,
          public_reason: row.public_reason || null,
          internal_note: row.internal_note || null,
          requested_at: row.requested_at,
          activated_at: row.activated_at,
          completed_at: row.completed_at,
          last_action_at: row.last_action_at,
          last_actor_display_name: row.last_actor_display_name || null
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit))
        }
      };
    },

    async getSessionRequests(sessionPublicId) {
      const session = await findSessionByPublicId(pool, sessionPublicId);
      if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
      const [rows] = await pool.query(
        `SELECT sr.*, ls.public_id AS session_public_id,
                details.canonical_match_method, details.reason_code,
                details.public_reason, details.internal_note,
                s.id AS song_id, s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
         LEFT JOIN live_sessions ls ON ls.id = sr.session_id
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE sr.session_id = ?
         ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
                  sr.queue_order, sr.requested_at, sr.id`,
        [session.id]
      );
      const settings = await loadPolicySettings(pool);
      const metrics = await getQueueMetrics(pool, session.id, settings);
      const etaById = new Map(metrics.requests.map((item) => [item.public_id, item]));
      const [latestRows] = await pool.query(
        `SELECT h.id, h.created_at, h.metadata,
                TIMESTAMPDIFF(
                  MICROSECOND, h.created_at, UTC_TIMESTAMP(3)
                ) / 1000 AS age_ms
         FROM song_request_history h
         INNER JOIN song_requests sr ON sr.id = h.request_id
         WHERE sr.session_id = ?
         ORDER BY h.id DESC
         LIMIT 1`,
        [session.id]
      );
      const latest = latestRows[0] || null;
      const latestMetadata = parseHistoryMetadata(latest?.metadata);
      const undoAvailable = Boolean(
        latest
        && latestMetadata.before
        && historyAgeMs(latest) <= 30_000
      );
      return {
        session: publicSession(session),
        requests: rows.map((row) => ({
          ...requestForManagement(
            row,
            row.song_id ? publicSong({
              id: row.song_id,
              title: row.song_title,
              artist: row.song_artist,
              duration: row.song_duration
            }) : null
          ),
          position: etaById.get(row.public_id)?.position ?? null,
          eta: etaById.get(row.public_id)?.eta || null
        })),
        settings: settingsProjection(settings),
        revision: latest ? Number(latest.id) : 0,
        undo: {
          available: undoAvailable,
          expected_revision: latest ? Number(latest.id) : 0,
          seconds_remaining: undoAvailable
            ? Math.max(
              0,
              Math.ceil((30_000 - historyAgeMs(latest)) / 1000)
            )
            : 0
        }
      };
    },

    async getObserved(siteId, roomId) {
      const [rows] = await pool.query(
        `SELECT sr.*, NULL AS session_public_id,
                details.canonical_match_method, details.reason_code,
                details.public_reason, details.internal_note
         FROM song_requests sr
         LEFT JOIN song_request_details details ON details.request_id = sr.id
         WHERE sr.site_id = ? AND sr.room_id = ?
           AND sr.status = 'observed' AND sr.session_id IS NULL
         ORDER BY sr.requested_at, sr.id`,
        [siteId, roomId]
      );
      return rows.map((row) => requestForManagement(row));
    },

    async listAliases(songId) {
      const [rows] = await pool.query(
        `SELECT id, song_id, alias, created_at, updated_at
         FROM song_aliases
         WHERE song_id = ?
         ORDER BY alias COLLATE utf8mb4_bin, id`,
        [songId]
      );
      return rows;
    },

    async addAlias(songId, alias, actorUserId) {
      const normalized = normalizeSongText(alias);
      try {
        return await runInTransaction(pool, async (connection) => {
          const [songs] = await connection.query(
            'SELECT id FROM songs WHERE id = ? LIMIT 1',
            [songId]
          );
          if (!songs.length) throw new SongRequestError(404, 'song_not_found', '歌曲不存在');
          const [result] = await connection.query(
            `INSERT INTO song_aliases (
               song_id, alias, normalized_alias, script_key,
               loose_candidate_key, created_by_user_id
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              songId,
              normalized.raw_text.trim(),
              normalized.whitespace_normalized,
              normalized.script_key,
              normalized.loose_candidate_key,
              actorUserId
            ]
          );
          const [rows] = await connection.query(
            `SELECT id, song_id, alias, created_at, updated_at
             FROM song_aliases WHERE id = ?`,
            [result.insertId]
          );
          return rows[0];
        });
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
          throw new SongRequestError(
            409,
            'equivalent_alias_exists',
            '该歌曲已存在等价别名'
          );
        }
        throw error;
      }
    },

    async deleteAlias(aliasId) {
      const [result] = await pool.query('DELETE FROM song_aliases WHERE id = ?', [aliasId]);
      if (!result.affectedRows) throw new SongRequestError(404, 'alias_not_found', '歌曲别名不存在');
      return { success: true };
    },

    async getHistoryCount(requestPublicId) {
      const request = await findRequestByPublicId(pool, requestPublicId);
      if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS count FROM song_request_history WHERE request_id = ?',
        [request.id]
      );
      return Number(rows[0].count);
    },

    async getRequest(requestPublicId) {
      const request = await findRequestByPublicId(pool, requestPublicId);
      if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
      return requestForManagement(request, await getMatchedSong(pool, request.matched_song_id));
    },

    async getPublicRequest(requestPublicId) {
      const request = await findRequestByPublicId(pool, requestPublicId);
      if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
      return requestForPublic(request, await getMatchedSong(pool, request.matched_song_id));
    },

    async getOwnRequest(requestPublicId, userId) {
      const request = await findRequestByPublicId(pool, requestPublicId);
      if (!request || Number(request.requester_user_id) !== Number(userId)) {
        throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
      }
      return requestForOwner(request, await getMatchedSong(pool, request.matched_song_id));
    }
  };

  return service;
}

const defaultSongRequestService = createSongRequestService();

module.exports = {
  areSongRequestsOpen,
  assertSongRequestsOpen,
  createSongRequestService,
  defaultSongRequestService,
  ensureSongRequestsOpenSetting,
  findOpenSessionForUpdate,
  findCurrentSessionForUpdate,
  findRequestByPublicId,
  insertHistory,
  nextQueueOrder,
  requestForPublic,
  requestForOwner,
  requestForManagement,
  resolveWebsiteSessionForUpdate,
  toMysqlUtcDateTime
};
