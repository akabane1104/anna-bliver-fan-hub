const {
  catalogQuerySchema,
  optionalTargetQuerySchema,
  parseIdempotencyKey,
  websiteSongRequestSchema
} = require('../schemas/songRequestSchemas');
const { defaultSongCatalogService } = require('../services/songCatalogService');
const { defaultSongRequestService } = require('../services/songRequestService');
const { SongRequestError } = require('../utils/songRequestError');

function parseOrThrow(schema, value, code = 'invalid_request') {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SongRequestError(422, code, '请求内容校验失败');
  }
  return result.data;
}

function sendSongRequestError(res, error) {
  const status = Number(error?.status);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({
    status: 'rejected',
    code: safeStatus < 500 ? (error.code || 'request_rejected') : 'internal_error',
    message: safeStatus < 500 ? error.message : '服务器内部错误'
  });
}

function createSongRequestController({
  service = defaultSongRequestService,
  catalogService = defaultSongCatalogService
} = {}) {
  return {
    async create(req, res) {
      try {
        const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
        if (!idempotencyKey) {
          throw new SongRequestError(
            400,
            'invalid_idempotency_key',
            '必须提供有效的 Idempotency-Key 请求头'
          );
        }
        const input = parseOrThrow(websiteSongRequestSchema, req.body);
        const result = await service.createWebsiteRequest(input, {
          userId: req.userId,
          idempotencyKey
        });
        const request = await service.getPublicRequest(result.request.public_id);
        return res.status(result.duplicate ? 200 : 201).json({
          status: result.duplicate ? 'duplicate' : 'accepted',
          request
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async current(req, res) {
      try {
        const target = parseOrThrow(optionalTargetQuerySchema, req.query, 'invalid_target');
        return res.json(await service.getCurrentQueue(target.site_id, target.room_id));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async catalog(req, res) {
      try {
        const query = parseOrThrow(catalogQuerySchema, req.query, 'invalid_catalog_query');
        return res.json(await catalogService.list(query));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    }
  };
}

module.exports = {
  createSongRequestController,
  parseOrThrow,
  sendSongRequestError
};
