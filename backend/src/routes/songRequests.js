const express = require('express');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const optionalAuthMiddleware = require('../middleware/optionalAuth');
const { createSongRequestController } = require('../controllers/songRequestController');
const asyncHandler = require('../utils/asyncHandler');

function createSongRequestRouter({
  controller = createSongRequestController(),
  authenticate = authMiddleware,
  optionalAuthenticate = optionalAuthMiddleware,
  writeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
      status: 'rejected',
      code: 'rate_limited',
      message: '点歌请求过于频繁，请稍后再试'
    })
  })
} = {}) {
  const router = express.Router();

  router.get('/center', optionalAuthenticate, asyncHandler(controller.center));
  router.get('/me', authenticate, asyncHandler(controller.mine));
  router.get('/catalog', asyncHandler(controller.catalog));
  router.get('/current', asyncHandler(controller.current));
  router.post(
    '/:publicId/withdraw',
    authenticate,
    writeLimiter,
    asyncHandler(controller.withdraw)
  );
  router.post(
    '/:publicId/rerequest',
    authenticate,
    writeLimiter,
    asyncHandler(controller.rerequest)
  );
  router.post('/', authenticate, writeLimiter, asyncHandler(controller.create));

  return router;
}

module.exports = { createSongRequestRouter };
