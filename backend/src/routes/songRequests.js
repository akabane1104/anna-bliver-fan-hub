const express = require('express');
const authMiddleware = require('../middleware/auth');
const { createSongRequestController } = require('../controllers/songRequestController');
const asyncHandler = require('../utils/asyncHandler');

function createSongRequestRouter({
  controller = createSongRequestController(),
  authenticate = authMiddleware
} = {}) {
  const router = express.Router();

  router.get('/current', asyncHandler(controller.current));
  router.post('/', authenticate, asyncHandler(controller.create));

  return router;
}

module.exports = { createSongRequestRouter };
