const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { createLiveHomeController } = require('../controllers/liveHomeController');

function createLiveHomeRouter({
  controller = createLiveHomeController()
} = {}) {
  const router = express.Router();
  router.get('/', asyncHandler(controller.publicHome));
  return router;
}

module.exports = { createLiveHomeRouter };
