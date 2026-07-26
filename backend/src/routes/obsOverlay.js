const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const {
  createObsOverlayController
} = require('../controllers/obsOverlayController');

function createObsOverlayRouter({
  controller = createObsOverlayController()
} = {}) {
  const router = express.Router();
  router.get('/state', asyncHandler(controller.snapshot));
  router.get('/stream', asyncHandler(controller.stream));
  return router;
}

module.exports = {
  createObsOverlayRouter
};
