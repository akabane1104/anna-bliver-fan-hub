const express = require('express');
const router = express.Router();
const marshmallowController = require('../controllers/marshmallowController');
const authMiddleware = require('../middleware/auth');
const optionalAuthMiddleware = require('../middleware/optionalAuth');
const { requirePermission, PERMISSIONS } = require('../middleware/permissions');
const asyncHandler = require('../utils/asyncHandler');

// Public routes (with optional auth)
router.post('/', optionalAuthMiddleware, asyncHandler(marshmallowController.createMarshmallow));

// Protected routes
router.get('/my', authMiddleware, asyncHandler(marshmallowController.getMyMarshmallows));
router.post('/bind', authMiddleware, asyncHandler(marshmallowController.bindMarshmallow));

// Admin/Marshmallow manager routes - requires marshmallow.manage permission
router.get('/admin', authMiddleware, requirePermission(PERMISSIONS.MARSHMALLOW_MANAGE), asyncHandler(marshmallowController.getAllMarshmallows));
router.post('/:id/obs', authMiddleware, requirePermission(PERMISSIONS.MARSHMALLOW_MANAGE), asyncHandler(marshmallowController.publishMarshmallowToObs));
router.put('/:id/reply', authMiddleware, requirePermission(PERMISSIONS.MARSHMALLOW_MANAGE), asyncHandler(marshmallowController.replyMarshmallow));
router.post('/:id/read', authMiddleware, requirePermission(PERMISSIONS.MARSHMALLOW_MANAGE), asyncHandler(marshmallowController.markAsRead));
router.post('/delete', authMiddleware, requirePermission(PERMISSIONS.MARSHMALLOW_MANAGE), asyncHandler(marshmallowController.deleteMarshmallows));

module.exports = router;
