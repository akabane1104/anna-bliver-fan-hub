const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const { requireAdmin } = require('../middleware/permissions');
const asyncHandler = require('../utils/asyncHandler');

router.post('/send-code', asyncHandler(authController.sendVerificationCode));
router.post('/register', asyncHandler(authController.register));
router.post('/login', asyncHandler(authController.login));
router.get('/profile', authMiddleware, asyncHandler(authController.getProfile));
router.get('/users', authMiddleware, requireAdmin, asyncHandler(authController.getAllUsers));
router.put('/users/:id/role', authMiddleware, requireAdmin, asyncHandler(authController.updateUserRole));

module.exports = router;
