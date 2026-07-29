const router = require('express').Router();
const controller = require('../controllers/viewerIdentityController');
const auth = require('../middleware/auth');
const {
  PERMISSIONS,
  requirePermission
} = require('../middleware/permissions');
const asyncHandler = require('../utils/asyncHandler');

router.use(auth);
router.use(requirePermission(PERMISSIONS.VIEWER_IDENTITY_MANAGE));
router.get('/users', asyncHandler(controller.listUsers));
router.get('/users/:userId/audit', asyncHandler(controller.listAudit));
router.post(
  '/users/:userId/bindings/:bilibiliUid/sync',
  asyncHandler(controller.resync)
);
router.put(
  '/users/:userId/bindings/:bilibiliUid/fallback',
  asyncHandler(controller.setFallback)
);
router.delete(
  '/users/:userId/bindings/:bilibiliUid/fallback',
  asyncHandler(controller.revokeFallback)
);

module.exports = router;
