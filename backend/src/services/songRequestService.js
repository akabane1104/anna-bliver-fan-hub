const crypto = require('node:crypto');
const database = require('../config/database');
const { createContentHash } = require('../utils/canonicalJson');
const { runInTransaction } = require('../utils/databaseTransaction');
const { normalizeSongText, parseSongRequestCommand } = require('../utils/songText');
const { SongRequestError, assertExpectedVersion } = require('../utils/songRequestError');
const { findSessionByPublicId, publicSession } = require('./liveSessionService');
const { matchSongInPlaylist, publicSong } = require('./songMatcherService');
const {
  canSetFulfillmentType,
  canTransitionRequest,
  isTerminalRequestStatus
} = require('./songRequestStateMachine');

function toMysqlUtcDateTime(value = new Date()) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
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

async function findRequestByPublicId(queryable, publicId, { forUpdate = false } = {}) {
  const [rows] = await queryable.query(
    `SELECT id, public_id, session_id, site_id, room_id, source, source_event_id,
            idempotency_key, idempotency_fingerprint, requester_user_id,
            requester_display_name, raw_request_text, requested_title,
            normalized_query, matched_song_id, match_method, match_confidence,
            status, fulfillment_type, queue_order, reason, version,
            requested_at, activated_at, completed_at, created_at, updated_at
     FROM song_requests
     WHERE public_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [publicId]
  );
  return rows[0] || null;
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
    match_method: row.match_method,
    match_confidence: row.match_confidence == null ? null : Number(row.match_confidence),
    status: row.status,
    fulfillment_type: row.fulfillment_type,
    queue_order: row.queue_order == null ? null : String(row.queue_order),
    reason: row.reason || null,
    version: Number(row.version),
    requested_at: row.requested_at,
    activated_at: row.activated_at,
    completed_at: row.completed_at
  };
}

function matchFields(result) {
  return {
    matchedSongId: result.song?.id || null,
    matchMethod: result.match_method,
    matchConfidence: result.match_confidence,
    normalizedQuery: result.normalization.script_key
  };
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
      match_method: input.matchMethod,
      session_public_id: input.sessionPublicId || null
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

function createSongRequestService({ pool = database } = {}) {
  const service = {
    async observeAcceptedDanmaku(event, { connection }) {
      if (event.event_type !== 'danmaku') return { status: 'ignored', reason: 'not_danmaku' };
      const command = parseSongRequestCommand(event.payload.text);
      if (!command.matched) return { status: 'ignored', reason: command.reason };

      const [existing] = await connection.query(
        'SELECT public_id FROM song_requests WHERE source_event_id = ? LIMIT 1',
        [event.event_id]
      );
      if (existing.length) return { status: 'duplicate', public_id: existing[0].public_id };

      const session = await findOpenSessionForUpdate(
        connection,
        event.site_id,
        event.room_id
      );
      let match = {
        kind: 'unmatched',
        song: null,
        match_method: 'unmatched',
        match_confidence: null,
        normalization: command.normalization
      };
      let status = 'observed';
      let queueOrder = null;
      let reason = 'no_open_session';
      if (session) {
        match = await matchSongInPlaylist(
          connection,
          session.playlist_id,
          command.requested_title
        );
        status = statusForMatch(match);
        queueOrder = await nextQueueOrder(connection, session.id);
        reason = match.kind === 'matched'
          ? null
          : (match.kind === 'ambiguous' ? 'candidate_confirmation_required' : 'no_catalog_match');
      }

      const fields = matchFields(match);
      try {
        const request = await insertSongRequest(connection, {
          sessionId: session?.id || null,
          sessionPublicId: session?.public_id || null,
          siteId: event.site_id,
          roomId: event.room_id,
          source: event.mode === 'replay'
            ? 'replay'
            : (event.mode === 'simulation' ? 'simulation' : 'bilibili_danmaku'),
          sourceEventId: event.event_id,
          idempotencyKey: null,
          idempotencyFingerprint: null,
          requesterUserId: null,
          requesterOpenId: event.actor.open_id,
          requesterDisplayName: event.actor.display_name || null,
          rawRequestText: command.raw_text,
          requestedTitle: command.requested_title,
          normalizedQuery: fields.normalizedQuery,
          matchedSongId: fields.matchedSongId,
          matchMethod: fields.matchMethod,
          matchConfidence: fields.matchConfidence,
          status,
          queueOrder,
          reason,
          requestedAt: toMysqlUtcDateTime(event.occurred_at),
          actorUserId: null
        });
        return { status: 'created', request };
      } catch (error) {
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
      try {
        const result = await runInTransaction(pool, async (connection) => {
          const [users] = await connection.query(
            'SELECT id, username FROM users WHERE id = ? LIMIT 1',
            [userId]
          );
          if (!users.length) throw new SongRequestError(401, 'user_not_found', '用户已不存在');

          const [existing] = await connection.query(
            `SELECT public_id, idempotency_fingerprint
             FROM song_requests
             WHERE requester_user_id = ? AND idempotency_key = ?
             LIMIT 1`,
            [userId, idempotencyKey]
          );
          if (existing.length) {
            if (existing[0].idempotency_fingerprint !== fingerprint) {
              throw new SongRequestError(
                409,
                'idempotency_key_conflict',
                '该 Idempotency-Key 已用于另一条请求'
              );
            }
            return {
              duplicate: true,
              request: await findRequestByPublicId(connection, existing[0].public_id)
            };
          }

          const session = await findOpenSessionForUpdate(
            connection,
            input.site_id,
            input.room_id
          );
          if (!session) {
            throw new SongRequestError(409, 'no_open_session', '当前没有开放中的直播场次');
          }
          const { requestedTitle, result: match } = await resolveRequestMatch(connection, session, {
            songId: input.song_id,
            query: input.query
          });
          const fields = matchFields(match);
          const status = statusForMatch(match);
          const reason = match.kind === 'matched'
            ? null
            : (match.kind === 'ambiguous' ? 'candidate_confirmation_required' : 'no_catalog_match');
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
            requesterDisplayName: users[0].username,
            rawRequestText: input.query || requestedTitle,
            requestedTitle,
            normalizedQuery: fields.normalizedQuery,
            matchedSongId: fields.matchedSongId,
            matchMethod: fields.matchMethod,
            matchConfidence: fields.matchConfidence,
            status,
            queueOrder: await nextQueueOrder(connection, session.id),
            reason,
            requestedAt: toMysqlUtcDateTime(),
            actorUserId: userId
          });
          return { duplicate: false, request };
        });
        return result;
      } catch (error) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        const [existing] = await pool.query(
          `SELECT public_id, idempotency_fingerprint
           FROM song_requests
           WHERE requester_user_id = ? AND idempotency_key = ?
           LIMIT 1`,
          [userId, idempotencyKey]
        );
        if (!existing.length) throw error;
        if (existing[0].idempotency_fingerprint !== fingerprint) {
          throw new SongRequestError(
            409,
            'idempotency_key_conflict',
            '该 Idempotency-Key 已用于另一条请求'
          );
        }
        return {
          duplicate: true,
          request: await findRequestByPublicId(pool, existing[0].public_id)
        };
      }
    },

    async createManualRequest(input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        let session = null;
        if (input.session_public_id) {
          session = await findSessionByPublicId(connection, input.session_public_id, {
            forUpdate: true
          });
          if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
          if (session.status === 'closed') {
            throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
          }
          if (session.site_id !== input.site_id || session.room_id !== input.room_id) {
            throw new SongRequestError(422, 'session_target_mismatch', '场次站点或直播间不匹配');
          }
        }

        let match;
        let requestedTitle;
        if (session) {
          ({ requestedTitle, result: match } = await resolveRequestMatch(connection, session, {
            songId: input.song_id,
            query: input.query
          }));
        } else {
          requestedTitle = input.query;
          if (!requestedTitle && input.song_id) {
            const [songs] = await connection.query(
              'SELECT id, title, artist, duration FROM songs WHERE id = ? LIMIT 1',
              [input.song_id]
            );
            if (!songs.length) throw new SongRequestError(404, 'song_not_found', '歌曲不存在');
            requestedTitle = songs[0].title;
          }
          const normalization = normalizeSongText(requestedTitle);
          match = {
            kind: 'unmatched',
            song: null,
            match_method: 'unmatched',
            match_confidence: null,
            normalization
          };
        }

        const fields = matchFields(match);
        const shouldQueue = session?.status === 'open';
        const status = shouldQueue ? statusForMatch(match) : 'observed';
        return insertSongRequest(connection, {
          sessionId: session?.id || null,
          sessionPublicId: session?.public_id || null,
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
          matchConfidence: fields.matchConfidence,
          status,
          queueOrder: shouldQueue ? await nextQueueOrder(connection, session.id) : null,
          reason: status === 'observed' ? 'awaiting_session_assignment' : null,
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
            match_method: fields.matchMethod
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async setManualMatch(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, { forUpdate: true });
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!['observed', 'needs_match', 'queued'].includes(request.status)) {
          throw new SongRequestError(409, 'request_not_matchable', '当前状态不能修改歌曲匹配');
        }
        if (!request.session_id) {
          throw new SongRequestError(409, 'request_has_no_session', '请先将请求指派到直播场次');
        }
        const [sessions] = await connection.query(
          `SELECT id, playlist_id, status
           FROM live_sessions
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [request.session_id]
        );
        const session = sessions[0];
        if (!session || session.status === 'closed') {
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
        const toStatus = 'queued';
        const queueOrder = request.queue_order || await nextQueueOrder(connection, session.id);
        await connection.query(
          `UPDATE song_requests
           SET matched_song_id = ?, match_method = 'manual', match_confidence = 1,
               status = ?, queue_order = ?, reason = ?, version = version + 1
           WHERE id = ?`,
          [input.song_id, toStatus, queueOrder, input.reason || null, request.id]
        );
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
          metadata: { matched_song_id: input.song_id }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async acceptUnmatched(requestPublicId, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, { forUpdate: true });
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!['observed', 'needs_match'].includes(request.status) || !request.session_id) {
          throw new SongRequestError(409, 'request_not_acceptable', '当前状态不能接受该请求');
        }
        const [sessions] = await connection.query(
          `SELECT id, status FROM live_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
          [request.session_id]
        );
        if (!sessions.length || sessions[0].status === 'closed') {
          throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
        }
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
          reason: input.reason || null
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
        await insertHistory(connection, {
          requestId: request.id,
          fromStatus: request.status,
          toStatus: request.status,
          action: 'fulfillment_type_changed',
          actorUserId,
          reason: input.reason || null,
          metadata: {
            from_fulfillment_type: request.fulfillment_type,
            to_fulfillment_type: input.fulfillment_type
          }
        });
        return findRequestByPublicId(connection, requestPublicId);
      });
    },

    async transitionRequest(requestPublicId, toStatus, input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const request = await findRequestByPublicId(connection, requestPublicId, { forUpdate: true });
        if (!request) throw new SongRequestError(404, 'request_not_found', '点歌请求不存在');
        assertExpectedVersion(request.version, input.expected_version);
        if (!canTransitionRequest(request.status, toStatus)) {
          throw new SongRequestError(
            409,
            'invalid_request_transition',
            `点歌请求不能从 ${request.status} 转换为 ${toStatus}`
          );
        }
        if (toStatus === 'queued' && request.status !== 'failed') {
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
          const [sessions] = await connection.query(
            `SELECT id, status FROM live_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
            [request.session_id]
          );
          if (!sessions.length || sessions[0].status === 'closed') {
            throw new SongRequestError(409, 'session_closed', '已关闭的场次不能接收请求');
          }
          queueOrder = await nextQueueOrder(connection, request.session_id);
        }
        if (toStatus === 'active') {
          const [sessions] = await connection.query(
            `SELECT status FROM live_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
            [request.session_id]
          );
          if (!sessions.length || sessions[0].status === 'closed') {
            throw new SongRequestError(409, 'session_closed', '已关闭的场次不能开始处理请求');
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
          reason: input.reason || null
        });
        return findRequestByPublicId(connection, requestPublicId);
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
          `SELECT id, public_id, status, queue_order
           FROM song_requests
           WHERE session_id = ? AND status IN ('needs_match','queued')
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
        for (const [index, publicId] of input.request_public_ids.entries()) {
          const row = rowsByPublicId.get(publicId);
          const newOrder = String(index + 1);
          await connection.query(
            `UPDATE song_requests
             SET queue_order = ?, version = version + 1
             WHERE id = ?`,
            [newOrder, row.id]
          );
          if (String(row.queue_order) !== newOrder) {
            await insertHistory(connection, {
              requestId: row.id,
              fromStatus: row.status,
              toStatus: row.status,
              action: 'reordered',
              actorUserId,
              metadata: {
                from_queue_order: String(row.queue_order),
                to_queue_order: newOrder
              }
            });
          }
        }
        await connection.query(
          'UPDATE live_sessions SET version = version + 1 WHERE id = ?',
          [session.id]
        );
        return {
          session: publicSession(await findSessionByPublicId(connection, sessionPublicId)),
          request_public_ids: input.request_public_ids
        };
      });
    },

    async getCurrentQueue(siteId, roomId) {
      const [sessions] = await pool.query(
        `SELECT id, public_id, title, status
         FROM live_sessions
         WHERE site_id = ? AND room_id = ? AND status IN ('open','paused')
         LIMIT 1`,
        [siteId, roomId]
      );
      if (!sessions.length) return { session: null, requests: [] };
      const session = sessions[0];
      const [rows] = await pool.query(
        `SELECT sr.public_id, sr.requested_title, sr.requester_display_name,
                sr.status, sr.fulfillment_type, sr.queue_order, sr.requested_at,
                s.title AS song_title, s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
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
          status: row.status,
          fulfillment_type: row.fulfillment_type,
          queue_order: row.queue_order == null ? null : String(row.queue_order),
          requested_at: row.requested_at
        }))
      };
    },

    async getSessionRequests(sessionPublicId) {
      const session = await findSessionByPublicId(pool, sessionPublicId);
      if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
      const [rows] = await pool.query(
        `SELECT sr.*, ls.public_id AS session_public_id,
                s.id AS song_id, s.title AS song_title,
                s.artist AS song_artist, s.duration AS song_duration
         FROM song_requests sr
         LEFT JOIN live_sessions ls ON ls.id = sr.session_id
         LEFT JOIN songs s ON s.id = sr.matched_song_id
         WHERE sr.session_id = ?
         ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
                  sr.queue_order, sr.requested_at, sr.id`,
        [session.id]
      );
      return {
        session: publicSession(session),
        requests: rows.map((row) => requestForManagement(
          row,
          row.song_id ? publicSong({
            id: row.song_id,
            title: row.song_title,
            artist: row.song_artist,
            duration: row.song_duration
          }) : null
        ))
      };
    },

    async getObserved(siteId, roomId) {
      const [rows] = await pool.query(
        `SELECT sr.*, NULL AS session_public_id
         FROM song_requests sr
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
    }
  };

  return service;
}

const defaultSongRequestService = createSongRequestService();

module.exports = {
  createSongRequestService,
  defaultSongRequestService,
  findOpenSessionForUpdate,
  findRequestByPublicId,
  insertHistory,
  nextQueueOrder,
  requestForManagement,
  toMysqlUtcDateTime
};
