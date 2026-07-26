const database = require('../config/database');
const { createContentHash } = require('../utils/canonicalJson');
const { defaultSongRequestService } = require('./songRequestService');
const { defaultLiveHomeService } = require('./liveHomeService');

const INSERT_LIVE_EVENT_SQL = `
  INSERT INTO live_events (
    event_id,
    schema_version,
    event_type,
    site_id,
    room_id,
    mode,
    source_cmd,
    source_message_id,
    source_session_id,
    actor_open_id,
    actor_union_id,
    actor_display_name,
    occurred_at,
    received_at,
    normalized_payload,
    content_hash,
    status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded')
`;

function toMysqlUtcDateTime(value) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function createMysqlLiveEventRepository(queryable = database, { transactionRoot = true } = {}) {
  const repository = {
    queryable,

    async insert(record) {
      const [result] = await queryable.execute(INSERT_LIVE_EVENT_SQL, [
        record.eventId,
        record.schemaVersion,
        record.eventType,
        record.siteId,
        record.roomId,
        record.mode,
        record.sourceCmd,
        record.sourceMessageId,
        record.sourceSessionId,
        record.actorOpenId,
        record.actorUnionId,
        record.actorDisplayName,
        record.occurredAt,
        record.receivedAt,
        record.normalizedPayload,
        record.contentHash
      ]);
      return result.insertId;
    },

    async findByEventId(eventId) {
      const [rows] = await queryable.execute(
        'SELECT event_id, content_hash FROM live_events WHERE event_id = ? LIMIT 1',
        [eventId]
      );
      return rows[0] || null;
    }
  };

  if (transactionRoot && typeof queryable.getConnection === 'function') {
    repository.runInTransaction = async (work) => {
      const connection = await queryable.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(createMysqlLiveEventRepository(
          connection,
          { transactionRoot: false }
        ));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    };
  }

  return repository;
}

function toLiveEventRecord(event) {
  return {
    eventId: event.event_id,
    schemaVersion: event.schema_version,
    eventType: event.event_type,
    siteId: event.site_id,
    roomId: event.room_id,
    mode: event.mode,
    sourceCmd: event.source.cmd,
    sourceMessageId: event.source.message_id || null,
    sourceSessionId: event.source.session_id || null,
    actorOpenId: event.actor?.open_id || null,
    actorUnionId: event.actor?.union_id || null,
    actorDisplayName: event.actor?.display_name || null,
    occurredAt: toMysqlUtcDateTime(event.occurred_at),
    receivedAt: toMysqlUtcDateTime(event.received_at),
    normalizedPayload: JSON.stringify(event.payload),
    contentHash: createContentHash(event)
  };
}

async function recordWithRepository(event, repository, acceptedEventObserver) {
  const record = toLiveEventRecord(event);
  try {
    await repository.insert(record);
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    const existing = await repository.findByEventId(record.eventId);
    if (!existing) throw error;
    if (existing.content_hash === record.contentHash) {
      return { status: 'duplicate', contentHash: record.contentHash };
    }
    return {
      status: 'rejected',
      reason: 'event_id_conflict',
      contentHash: record.contentHash
    };
  }
  const observation = acceptedEventObserver
    ? await acceptedEventObserver(event, { connection: repository.queryable })
    : null;
  return { status: 'accepted', contentHash: record.contentHash, observation };
}

function createLiveEventService(options = {}) {
  const repository = options.repository || createMysqlLiveEventRepository();
  const acceptedEventObserver = Object.prototype.hasOwnProperty.call(
    options,
    'acceptedEventObserver'
  )
    ? options.acceptedEventObserver
    : (options.repository
      ? null
      : async (event, context) => {
        const liveState = await defaultLiveHomeService.observeAcceptedEvent(event, context);
        const songRequest = await defaultSongRequestService.observeAcceptedDanmaku(event, context);
        return event.event_type === 'danmaku' ? songRequest : liveState;
      });

  return {
    async record(event) {
      if (typeof repository.runInTransaction === 'function') {
        return repository.runInTransaction((transactionRepository) => (
          recordWithRepository(event, transactionRepository, acceptedEventObserver)
        ));
      }
      return recordWithRepository(event, repository, acceptedEventObserver);
    }
  };
}

module.exports = {
  INSERT_LIVE_EVENT_SQL,
  createLiveEventService,
  createMysqlLiveEventRepository,
  recordWithRepository,
  toLiveEventRecord
};
