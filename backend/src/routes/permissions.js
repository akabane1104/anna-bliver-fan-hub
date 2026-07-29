const router = require('express').Router();
const controller = require('../controllers/permissionController');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/permissions');
const asyncHandler = require('../utils/asyncHandler');

router.use(auth);
router.get('/types', requireAdmin, controller.getPermissionTypes);
router.get('/my', asyncHandler(controller.getMyPermissions));
router.get('/users', requireAdmin, asyncHandler(controller.getAllUsersWithPermissions));
router.get('/users/:userId', requireAdmin, asyncHandler(controller.getUserPermissions));
router.put('/users/:userId', requireAdmin, asyncHandler(controller.updateUserPermissions));

module.exports = router;
