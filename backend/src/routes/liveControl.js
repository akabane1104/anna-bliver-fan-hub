const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');
const { createLiveControlController } = require('../controllers/liveControlController');
const { createObsOverlayController } = require('../controllers/obsOverlayController');
const asyncHandler = require('../utils/asyncHandler');

function createLiveControlRouter({
  controller = createLiveControlController(),
  obsOverlayController = createObsOverlayController(),
  authenticate = authMiddleware,
  authorize = requirePermission(PERMISSIONS.LIVE_CONTROL_MANAGE),
  authorizeCatalog = requirePermission(PERMISSIONS.PLAYLIST_MANAGE)
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  router.get('/songs/:id/aliases', authorizeCatalog, asyncHandler(controller.listAliases));
  router.get('/songs/:id/policy', authorizeCatalog, asyncHandler(controller.getSongPolicy));
  router.put('/songs/:id/policy', authorizeCatalog, asyncHandler(controller.setSongPolicy));
  router.post('/songs/:id/aliases', authorizeCatalog, asyncHandler(controller.addAlias));
  router.delete('/aliases/:id', authorizeCatalog, asyncHandler(controller.deleteAlias));

  const controlRouter = express.Router();
  controlRouter.use(authorize);
  const authorizeAliasSave = (req, res, next) => (
    req.body?.save_alias === true ? authorizeCatalog(req, res, next) : next()
  );

  controlRouter.get('/home', asyncHandler(controller.liveHome));
  controlRouter.put('/home/override', asyncHandler(controller.setLiveHomeOverride));
  controlRouter.put('/home/song-requests', asyncHandler(controller.setSongRequestsOpen));
  controlRouter.put('/home/activity', asyncHandler(controller.setLiveHomeActivity));
  controlRouter.put('/home/eta', asyncHandler(controller.setEtaPaused));
  controlRouter.post('/home/undo', asyncHandler(controller.undoLastSongRequestAction));
  controlRouter.post('/home/requests/:publicId/advance', asyncHandler(controller.advanceCurrent));
  controlRouter.get('/status', asyncHandler(controller.liveStatus));
  controlRouter.get('/events', asyncHandler(controller.liveEvents));
  controlRouter.get('/obs-overlay/events', asyncHandler(obsOverlayController.listEvents));
  controlRouter.post('/obs-overlay/events', asyncHandler(obsOverlayController.createEvent));
  controlRouter.delete(
    '/obs-overlay/events/:publicId',
    asyncHandler(obsOverlayController.dismissEvent)
  );
  controlRouter.post('/sessions', asyncHandler(controller.createSession));
  controlRouter.get('/sessions/active', asyncHandler(controller.activeSessions));
  controlRouter.get('/sessions/recoverable', asyncHandler(controller.recoverableSessions));
  controlRouter.get('/sessions/current', asyncHandler(controller.currentSession));
  controlRouter.post('/sessions/:publicId/open', asyncHandler(controller.openSession));
  controlRouter.post('/sessions/:publicId/pause', asyncHandler(controller.pauseSession));
  controlRouter.post('/sessions/:publicId/resume', asyncHandler(controller.resumeSession));
  controlRouter.post('/sessions/:publicId/close', asyncHandler(controller.closeSession));
  controlRouter.get('/sessions/:publicId/requests', asyncHandler(controller.sessionRequests));
  controlRouter.put('/sessions/:publicId/reorder', asyncHandler(controller.reorder));

  controlRouter.get('/requests/observed', asyncHandler(controller.observedRequests));
  controlRouter.get('/history', asyncHandler(controller.history));
  controlRouter.get('/song-requests/settings', asyncHandler(controller.getSongRequestSettings));
  controlRouter.put('/song-requests/settings', asyncHandler(controller.updateSongRequestSettings));
  controlRouter.put('/song-requests/eta', asyncHandler(controller.setEtaPaused));
  controlRouter.post('/song-requests/undo', asyncHandler(controller.undoLastSongRequestAction));
  controlRouter.post('/requests', asyncHandler(controller.createManualRequest));
  controlRouter.post('/requests/:publicId/assign', asyncHandler(controller.assignRequest));
  controlRouter.post(
    '/requests/:publicId/match',
    authorizeAliasSave,
    asyncHandler(controller.matchRequest)
  );
  controlRouter.post('/requests/:publicId/accept-unmatched', asyncHandler(controller.acceptUnmatched));
  controlRouter.post('/requests/:publicId/reject', asyncHandler(controller.rejectRequest));
  controlRouter.post('/requests/:publicId/cancel', asyncHandler(controller.cancelRequest));
  controlRouter.post('/requests/:publicId/activate', asyncHandler(controller.activateRequest));
  controlRouter.post('/requests/:publicId/complete', asyncHandler(controller.completeRequest));
  controlRouter.post('/requests/:publicId/skip', asyncHandler(controller.skipRequest));
  controlRouter.post('/requests/:publicId/fail', asyncHandler(controller.failRequest));
  controlRouter.post('/requests/:publicId/requeue', asyncHandler(controller.requeueRequest));
  controlRouter.post('/requests/:publicId/restore', asyncHandler(controller.restoreSkippedRequest));
  controlRouter.post('/requests/:publicId/fulfillment', asyncHandler(controller.setFulfillment));

  router.use(controlRouter);

  return router;
}

module.exports = { createLiveControlRouter };
