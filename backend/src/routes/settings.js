const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const authMiddleware = require('../middleware/auth');
const { requireAdmin, requirePermission, PERMISSIONS } = require('../middleware/permissions');
const asyncHandler = require('../utils/asyncHandler');

router.get('/captcha', settingsController.getCaptchaConfig);
router.get('/registration', asyncHandler(settingsController.getRegistrationStatus));
router.get('/site', asyncHandler(settingsController.getSiteConfig));
router.put('/registration', authMiddleware, requireAdmin, asyncHandler(settingsController.updateRegistrationStatus));
router.put('/site', authMiddleware, requirePermission(PERMISSIONS.SITE_CONFIG_MANAGE), asyncHandler(settingsController.updateSiteConfig));
router.post('/site/logo', authMiddleware, requirePermission(PERMISSIONS.SITE_CONFIG_MANAGE), asyncHandler(settingsController.uploadNavbarLogo));

module.exports = router;
