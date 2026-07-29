const { listenerError } = require('./errors');

function asDate(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw listenerError(code);
  return date;
}

class OfficialLiveRepository {
  constructor({ pool, clock = Date.now }) {
    if (!pool || typeof pool.execute !== 'function') {
      throw listenerError('invalid_official_live_repository');
    }
    this.pool = pool;
    this.clock = clock;
  }

  async recordEventDigest({ digest, eventType, expiresAt }) {
    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO official_live_event_dedup
        (event_digest, event_type, first_seen_at, expires_at)
       VALUES (?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [digest, eventType, asDate(expiresAt, 'invalid_event_expiry')]
    );
    return Number(result?.affectedRows) === 1;
  }

  async listMemory(viewerKey, {
    now = new Date(this.clock()),
    limit = 12
  } = {}) {
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 12));
    const [rows] = await this.pool.execute(
      `SELECT message_role, content, created_at
         FROM official_ai_memory
        WHERE viewer_key = ?
          AND expires_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit}`,
      [viewerKey, asDate(now, 'invalid_memory_time')]
    );
    return rows.reverse().map((row) => Object.freeze({
      role: row.message_role,
      content: row.content,
      createdAt: row.created_at
    }));
  }

  async appendExchange({
    viewerKey,
    input,
    output,
    expiresAt
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO official_ai_memory
          (viewer_key, message_role, content, created_at, expires_at)
         VALUES (?, 'user', ?, CURRENT_TIMESTAMP(3), ?)`,
        [viewerKey, input, asDate(expiresAt, 'invalid_memory_expiry')]
      );
      await connection.execute(
        `INSERT INTO official_ai_memory
          (viewer_key, message_role, content, created_at, expires_at)
         VALUES (?, 'assistant', ?, CURRENT_TIMESTAMP(3), ?)`,
        [viewerKey, output, asDate(expiresAt, 'invalid_memory_expiry')]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteViewerMemory(viewerKey) {
    const [result] = await this.pool.execute(
      'DELETE FROM official_ai_memory WHERE viewer_key = ?',
      [viewerKey]
    );
    return Number(result?.affectedRows || 0);
  }

  async cleanupExpired({
    now = new Date(this.clock())
  } = {}) {
    const cutoff = asDate(now, 'invalid_cleanup_time');
    const [eventResult] = await this.pool.execute(
      'DELETE FROM official_live_event_dedup WHERE expires_at <= ?',
      [cutoff]
    );
    const [memoryResult] = await this.pool.execute(
      'DELETE FROM official_ai_memory WHERE expires_at <= ?',
      [cutoff]
    );
    return Object.freeze({
      events: Number(eventResult?.affectedRows || 0),
      memory: Number(memoryResult?.affectedRows || 0)
    });
  }
}

module.exports = {
  OfficialLiveRepository,
  asDate
};
