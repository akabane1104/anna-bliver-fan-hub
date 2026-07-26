const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');
const { createLiveControlController } = require('../controllers/liveControlController');
const asyncHandler = require('../utils/asyncHandler');

function createLiveControlRouter({
  controller = createLiveControlController(),
  authenticate = authMiddleware,
  authorize = requirePermission(PERMISSIONS.LIVE_CONTROL_MANAGE)
} = {}) {
  const router = express.Router();
  router.use(authenticate, authorize);

  router.get('/home', asyncHandler(controller.liveHome));
  router.put('/home/override', asyncHandler(controller.setLiveHomeOverride));
  router.put('/home/song-requests', asyncHandler(controller.setSongRequestsOpen));
  router.put('/home/activity', asyncHandler(controller.setLiveHomeActivity));
  router.post('/home/requests/:publicId/advance', asyncHandler(controller.advanceCurrent));
  router.get('/status', asyncHandler(controller.liveStatus));
  router.get('/events', asyncHandler(controller.liveEvents));
  router.post('/sessions', asyncHandler(controller.createSession));
  router.get('/sessions/active', asyncHandler(controller.activeSessions));
  router.get('/sessions/recoverable', asyncHandler(controller.recoverableSessions));
  router.get('/sessions/current', asyncHandler(controller.currentSession));
  router.post('/sessions/:publicId/open', asyncHandler(controller.openSession));
  router.post('/sessions/:publicId/pause', asyncHandler(controller.pauseSession));
  router.post('/sessions/:publicId/resume', asyncHandler(controller.resumeSession));
  router.post('/sessions/:publicId/close', asyncHandler(controller.closeSession));
  router.get('/sessions/:publicId/requests', asyncHandler(controller.sessionRequests));
  router.put('/sessions/:publicId/reorder', asyncHandler(controller.reorder));

  router.get('/requests/observed', asyncHandler(controller.observedRequests));
  router.get('/history', asyncHandler(controller.history));
  router.post('/requests', asyncHandler(controller.createManualRequest));
  router.post('/requests/:publicId/assign', asyncHandler(controller.assignRequest));
  router.post('/requests/:publicId/match', asyncHandler(controller.matchRequest));
  router.post('/requests/:publicId/accept-unmatched', asyncHandler(controller.acceptUnmatched));
  router.post('/requests/:publicId/reject', asyncHandler(controller.rejectRequest));
  router.post('/requests/:publicId/cancel', asyncHandler(controller.cancelRequest));
  router.post('/requests/:publicId/activate', asyncHandler(controller.activateRequest));
  router.post('/requests/:publicId/complete', asyncHandler(controller.completeRequest));
  router.post('/requests/:publicId/skip', asyncHandler(controller.skipRequest));
  router.post('/requests/:publicId/fail', asyncHandler(controller.failRequest));
  router.post('/requests/:publicId/requeue', asyncHandler(controller.requeueRequest));
  router.post('/requests/:publicId/fulfillment', asyncHandler(controller.setFulfillment));

  router.get('/songs/:id/aliases', asyncHandler(controller.listAliases));
  router.post('/songs/:id/aliases', asyncHandler(controller.addAlias));
  router.delete('/aliases/:id', asyncHandler(controller.deleteAlias));

  return router;
}

module.exports = { createLiveControlRouter };
