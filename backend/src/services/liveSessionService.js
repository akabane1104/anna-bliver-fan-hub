const crypto = require('node:crypto');
const database = require('../config/database');
const { runInTransaction } = require('../utils/databaseTransaction');
const { SongRequestError, assertExpectedVersion } = require('../utils/songRequestError');
const { canTransitionSession } = require('./songRequestStateMachine');

async function findSessionByPublicId(queryable, publicId, { forUpdate = false } = {}) {
  const [rows] = await queryable.query(
    `SELECT id, public_id, site_id, room_id, playlist_id, title, status,
            created_by_user_id, started_at, paused_at, ended_at,
            created_at, updated_at, version
     FROM live_sessions
     WHERE public_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [publicId]
  );
  return rows[0] || null;
}

function publicSession(session) {
  if (!session) return null;
  return {
    public_id: session.public_id,
    site_id: session.site_id,
    room_id: session.room_id,
    playlist_id: session.playlist_id,
    title: session.title,
    status: session.status,
    started_at: session.started_at,
    paused_at: session.paused_at,
    ended_at: session.ended_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    version: Number(session.version)
  };
}

function createLiveSessionService({ pool = database } = {}) {
  return {
    async createDraft(input, actorUserId) {
      return runInTransaction(pool, async (connection) => {
        const [playlists] = await connection.query(
          'SELECT id FROM playlists WHERE id = ? LIMIT 1',
          [input.playlist_id]
        );
        if (!playlists.length) {
          throw new SongRequestError(404, 'playlist_not_found', '歌单不存在');
        }
        const publicId = crypto.randomUUID();
        await connection.query(
          `INSERT INTO live_sessions (
             public_id, site_id, room_id, playlist_id, title, status, created_by_user_id
           ) VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
          [
            publicId,
            input.site_id,
            input.room_id,
            input.playlist_id,
            input.title,
            actorUserId
          ]
        );
        return publicSession(await findSessionByPublicId(connection, publicId));
      });
    },

    async transition(publicId, toStatus, expectedVersion) {
      try {
        return await runInTransaction(pool, async (connection) => {
          const session = await findSessionByPublicId(connection, publicId, { forUpdate: true });
          if (!session) throw new SongRequestError(404, 'session_not_found', '直播场次不存在');
          assertExpectedVersion(session.version, expectedVersion);
          if (!canTransitionSession(session.status, toStatus)) {
            throw new SongRequestError(
              409,
              'invalid_session_transition',
              `直播场次不能从 ${session.status} 转换为 ${toStatus}`
            );
          }

          const timestampUpdates = [];
          if (toStatus === 'open') timestampUpdates.push('started_at = COALESCE(started_at, UTC_TIMESTAMP(3))');
          if (toStatus === 'paused') timestampUpdates.push('paused_at = UTC_TIMESTAMP(3)');
          if (toStatus === 'closed') timestampUpdates.push('ended_at = UTC_TIMESTAMP(3)');
          await connection.query(
            `UPDATE live_sessions
             SET status = ?, version = version + 1
                 ${timestampUpdates.length ? `, ${timestampUpdates.join(', ')}` : ''}
             WHERE id = ?`,
            [toStatus, session.id]
          );
          return publicSession(await findSessionByPublicId(connection, publicId));
        });
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
          throw new SongRequestError(
            409,
            'active_session_exists',
            '该站点与直播间已有进行中或暂停中的场次'
          );
        }
        throw error;
      }
    },

    async getCurrent(siteId, roomId) {
      const [rows] = await pool.query(
        `SELECT id, public_id, site_id, room_id, playlist_id, title, status,
                created_by_user_id, started_at, paused_at, ended_at,
                created_at, updated_at, version
         FROM live_sessions
         WHERE site_id = ? AND room_id = ? AND status IN ('open','paused')
         LIMIT 1`,
        [siteId, roomId]
      );
      return publicSession(rows[0] || null);
    },

    async getByPublicId(publicId) {
      return publicSession(await findSessionByPublicId(pool, publicId));
    }
  };
}

module.exports = {
  createLiveSessionService,
  findSessionByPublicId,
  publicSession
};
