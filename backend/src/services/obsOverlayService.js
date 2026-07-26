const db = require('../config/database');
const { defaultLiveHomeService } = require('./liveHomeService');
const { requestForPublic } = require('./songRequestService');
const { taipeiDayBounds } = require('./songRequestPolicyService');
const {
  defaultObsOverlayEventService
} = require('./obsOverlayEventService');
const {
  defaultObsOverlayRealtime
} = require('./obsOverlayRealtime');

function songForOverlay(request) {
  if (!request) return null;
  const song = request.canonical_song || request.matched_song;
  return {
    displayKey: request.display_key,
    title: song?.title || '待确认歌曲',
    artist: song?.artist || null,
    requester: request.masked_display_name || '匿名观众',
    status: request.status,
    queuePosition: request.position ?? null,
    eta: request.eta || null
  };
}

function activityForOverlay(activity, nowMs) {
  if (!activity?.enabled || !activity.title) return null;
  const startsAt = activity.starts_at ? Date.parse(activity.starts_at) : NaN;
  const endsAt = activity.ends_at ? Date.parse(activity.ends_at) : NaN;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return null;
  }
  const status = nowMs < startsAt
    ? 'upcoming'
    : (nowMs >= endsAt ? 'ended' : 'active');
  const progress = status === 'upcoming'
    ? 0
    : (status === 'ended'
      ? 1
      : Math.min(1, Math.max(0, (nowMs - startsAt) / (endsAt - startsAt))));
  return {
    title: activity.title,
    content: activity.content || '',
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    status,
    progress
  };
}

function createObsOverlayStateRepository({
  pool = db,
  clock = Date.now
} = {}) {
  return {
    async getSongState() {
      const [sessions] = await pool.query(
        `SELECT id
         FROM live_sessions
         WHERE status IN ('open','paused')
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                  COALESCE(started_at, created_at) DESC, id DESC
         LIMIT 1`
      );
      const sessionId = sessions[0]?.id || null;
      const [rows] = sessionId
        ? await pool.query(
          `SELECT sr.public_id, sr.requester_display_name, sr.status,
                  sr.queue_order, sr.requested_at, sr.reason,
                  details.reason_code, details.public_reason,
                  s.title AS song_title, s.artist AS song_artist
           FROM song_requests sr
           LEFT JOIN song_request_details details ON details.request_id = sr.id
           LEFT JOIN songs s ON s.id = sr.matched_song_id
           WHERE sr.session_id = ?
             AND sr.status IN ('needs_match','queued','active')
           ORDER BY CASE WHEN sr.status = 'active' THEN 0 ELSE 1 END,
                    sr.queue_order, sr.id`,
          [sessionId]
        )
        : [[]];
      let waitingPosition = 0;
      const publicRows = rows.map((row) => {
        const position = row.status === 'active' ? 0 : ++waitingPosition;
        return {
          ...requestForPublic(
            row,
            row.song_title
              ? { title: row.song_title, artist: row.song_artist || null }
              : null
          ),
          position
        };
      });
      const bounds = taipeiDayBounds(new Date(clock()));
      const [todayRows] = await pool.query(
        `SELECT COUNT(*) AS request_count
         FROM song_requests
         WHERE status IN ('needs_match','queued','active','completed')
           AND requested_at >= ? AND requested_at < ?`,
        [bounds.start, bounds.end]
      );
      return {
        current: publicRows.find((row) => row.status === 'singing') || null,
        next: publicRows.find((row) => row.status !== 'singing') || null,
        queue: publicRows.filter((row) => row.status !== 'singing'),
        todayRequestCount: Number(todayRows[0]?.request_count || 0)
      };
    }
  };
}

function createObsOverlayService({
  stateRepository = createObsOverlayStateRepository(),
  liveHomeService = defaultLiveHomeService,
  eventService = defaultObsOverlayEventService,
  realtime = defaultObsOverlayRealtime,
  clock = Date.now
} = {}) {
  return {
    async getSnapshot({ maxEvents = 5, maxItems = 5 } = {}) {
      const nowMs = clock();
      const [songState, home, events] = await Promise.all([
        stateRepository.getSongState(),
        liveHomeService.getAdminHome(),
        eventService.listActive(maxEvents)
      ]);
      return {
        schemaVersion: '1',
        revision: realtime.getRevision(),
        serverNow: new Date(nowMs).toISOString(),
        currentSong: songForOverlay(songState.current),
        nextSong: songForOverlay(songState.next),
        queue: songState.queue.slice(0, maxItems).map(songForOverlay),
        todayRequestCount: songState.todayRequestCount,
        activity: activityForOverlay(home.control?.activity, nowMs),
        events
      };
    }
  };
}

const defaultObsOverlayService = createObsOverlayService();

module.exports = {
  activityForOverlay,
  createObsOverlayStateRepository,
  createObsOverlayService,
  defaultObsOverlayService,
  songForOverlay
};
