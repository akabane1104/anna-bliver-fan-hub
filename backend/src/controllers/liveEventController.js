const { TextDecoder } = require('node:util');
const { validateLiveEvent } = require('../schemas/liveEventSchema');
const { listenerStatusReportSchema } = require('../schemas/liveHomeSchemas');
const { isLiveEventTargetAllowed } = require('../utils/liveEventConfig');
const { defaultLiveHomeService } = require('../services/liveHomeService');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function writeAuditLog(logger, level, entry) {
  const method = logger?.[level] || logger?.log;
  if (typeof method !== 'function') return;
  try {
    method.call(logger, '[live-event-ingest]', entry);
  } catch {
    // Audit logging must not change an already determined ingest ACK.
  }
}

function auditMetadata(event) {
  if (!event) return {};
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    site_id: event.site_id,
    room_id: event.room_id,
    mode: event.mode
  };
}

function createLiveEventController({
  service,
  statusService = defaultLiveHomeService,
  logger = console,
  clock = () => process.hrtime.bigint()
}) {
  return {
    async ingest(req, res) {
      const startedAt = clock();
      let event = null;
      let status = 'rejected';
      let errorCode = null;

      try {
        let parsed;
        try {
          parsed = JSON.parse(utf8Decoder.decode(req.liveEventRawBody));
        } catch {
          errorCode = 'invalid_json';
          return res.status(400).json({ status: 'rejected', reason: errorCode });
        }

        const validation = validateLiveEvent(parsed);
        if (!validation.success) {
          errorCode = 'invalid_event_schema';
          return res.status(422).json({ status: 'rejected', reason: errorCode });
        }
        event = validation.data;

        if (!isLiveEventTargetAllowed(req.liveEventConfig, event.site_id, event.room_id)) {
          errorCode = 'target_not_allowed';
          return res.status(403).json({ status: 'rejected', reason: errorCode });
        }

        const result = await service.record(event);
        status = result.status;
        if (result.status === 'accepted') {
          return res.status(201).json({ status: 'accepted', event_id: event.event_id });
        }
        if (result.status === 'duplicate') {
          return res.status(200).json({ status: 'duplicate', event_id: event.event_id });
        }

        errorCode = result.reason || 'event_id_conflict';
        return res.status(409).json({
          status: 'rejected',
          reason: errorCode,
          event_id: event.event_id
        });
      } catch {
        errorCode = 'database_error';
        return res.status(500).json({ status: 'rejected', reason: errorCode });
      } finally {
        const durationMs = Number(clock() - startedAt) / 1e6;
        const entry = {
          ...auditMetadata(event),
          status,
          ...(errorCode ? { error_code: errorCode } : {}),
          duration_ms: Number(durationMs.toFixed(3))
        };
        writeAuditLog(logger, errorCode === 'database_error' ? 'error' : 'info', entry);
      }
    },

    async status(req, res) {
      try {
        let parsed;
        try {
          parsed = JSON.parse(utf8Decoder.decode(req.liveEventRawBody));
        } catch {
          return res.status(400).json({ status: 'rejected', reason: 'invalid_json' });
        }
        const validation = listenerStatusReportSchema.safeParse(parsed);
        if (!validation.success) {
          return res.status(422).json({
            status: 'rejected',
            reason: 'invalid_listener_status'
          });
        }
        const report = validation.data;
        if (!isLiveEventTargetAllowed(req.liveEventConfig, report.site_id, report.room_id)) {
          return res.status(403).json({ status: 'rejected', reason: 'target_not_allowed' });
        }
        const result = await statusService.recordTransportStatus(report);
        return res.status(201).json(result);
      } catch (error) {
        const status = Number(error?.status);
        if (status === 409) {
          return res.status(409).json({
            status: 'rejected',
            reason: error.code || 'listener_status_conflict'
          });
        }
        return res.status(500).json({
          status: 'rejected',
          reason: 'database_error'
        });
      }
    }
  };
}

module.exports = { createLiveEventController };
