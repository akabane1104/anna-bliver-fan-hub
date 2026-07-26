const { defaultLiveHomeService } = require('../services/liveHomeService');
const { sendSongRequestError } = require('./songRequestController');

function createLiveHomeController({
  liveHomeService = defaultLiveHomeService
} = {}) {
  return {
    async publicHome(req, res) {
      try {
        return res.json(await liveHomeService.getPublicHome());
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    }
  };
}

module.exports = { createLiveHomeController };
