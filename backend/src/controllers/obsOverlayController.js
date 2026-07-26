const {
  createEventSchema,
  eventListQuerySchema,
  publicIdParamSchema,
  snapshotQuerySchema
} = require('../schemas/obsOverlaySchemas');
const {
  defaultObsOverlayEventService
} = require('../services/obsOverlayEventService');
const {
  defaultObsOverlayRealtime
} = require('../services/obsOverlayRealtime');
const {
  defaultObsOverlayService
} = require('../services/obsOverlayService');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = new Error('OBS overlay request validation failed');
  error.status = 400;
  error.code = 'invalid_obs_overlay_request';
  throw error;
}

function sendError(res, error) {
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 500 ? status : 500).json({
    message: status >= 400 && status < 500
      ? error.message
      : 'OBS overlay service unavailable',
    ...(error?.code ? { code: error.code } : {})
  });
}

function createObsOverlayController({
  overlayService = defaultObsOverlayService,
  eventService = defaultObsOverlayEventService,
  realtime = defaultObsOverlayRealtime,
  heartbeatMs = 15000
} = {}) {
  async function snapshot(req, res) {
    try {
      const input = parse(snapshotQuerySchema, req.query);
      res.set({
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache'
      });
      return res.json(await overlayService.getSnapshot(input));
    } catch (error) {
      return sendError(res, error);
    }
  }

  return {
    snapshot,

    async stream(req, res) {
      const input = parse(snapshotQuerySchema, req.query);
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();

      let closed = false;
      let writing = false;
      let pending = false;

      const writeSnapshot = async () => {
        if (closed || writing) {
          pending = true;
          return;
        }
        writing = true;
        try {
          const value = await overlayService.getSnapshot(input);
          if (!closed) {
            res.write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`);
          }
        } catch {
          if (!closed) res.write('event: unavailable\ndata: {}\n\n');
        } finally {
          writing = false;
          if (pending && !closed) {
            pending = false;
            void writeSnapshot();
          }
        }
      };

      const unsubscribe = realtime.subscribe(() => void writeSnapshot());
      const heartbeat = setInterval(() => {
        if (!closed) res.write(': heartbeat\n\n');
      }, heartbeatMs);
      heartbeat.unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      await writeSnapshot();
    },

    async listEvents(req, res) {
      try {
        const { limit } = parse(eventListQuerySchema, req.query);
        return res.json({ events: await eventService.listRecent(limit) });
      } catch (error) {
        return sendError(res, error);
      }
    },

    async createEvent(req, res) {
      try {
        const input = parse(createEventSchema, req.body);
        const result = await eventService.create(input, req.userId);
        return res.status(result.duplicate ? 200 : 201).json({
          status: result.duplicate ? 'duplicate' : 'created',
          event: result.event
        });
      } catch (error) {
        return sendError(res, error);
      }
    },

    async dismissEvent(req, res) {
      try {
        const { publicId } = parse(publicIdParamSchema, req.params);
        await eventService.dismiss(publicId);
        return res.status(204).end();
      } catch (error) {
        return sendError(res, error);
      }
    }
  };
}

module.exports = {
  createObsOverlayController
};
