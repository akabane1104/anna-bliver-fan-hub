const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { createLiveEventController } = require('../controllers/liveEventController');
const {
  createLiveEventAvailability,
  createLiveEventSignatureAuth,
  requireServiceOnlyRequest
} = require('../middleware/liveEventAuth');
const { createLiveEventService } = require('../services/liveEventService');
const { resolveLiveEventConfig } = require('../utils/liveEventConfig');

const MAX_LIVE_EVENT_BODY_BYTES = 64 * 1024;

function createLiveEventRouter({
  env = process.env,
  service = createLiveEventService(),
  statusService,
  logger = console,
  now = Date.now
} = {}) {
  const router = express.Router();
  const config = resolveLiveEventConfig(env);
  const controller = createLiveEventController({ service, statusService, logger });
  const rawJsonParser = express.raw({
    type: () => true,
    limit: MAX_LIVE_EVENT_BODY_BYTES,
    inflate: false
  });

  router.post(
    '/ingest',
    createLiveEventAvailability(config),
    requireServiceOnlyRequest,
    rawJsonParser,
    createLiveEventSignatureAuth({ now }),
    asyncHandler(controller.ingest)
  );
  router.post(
    '/status',
    createLiveEventAvailability(config),
    requireServiceOnlyRequest,
    rawJsonParser,
    createLiveEventSignatureAuth({ now }),
    asyncHandler(controller.status)
  );

  router.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ status: 'rejected', reason: 'payload_too_large' });
    }
    if (error?.type === 'encoding.unsupported') {
      return res.status(415).json({ status: 'rejected', reason: 'unsupported_content_encoding' });
    }
    return next(error);
  });

  return router;
}

module.exports = { MAX_LIVE_EVENT_BODY_BYTES, createLiveEventRouter };
