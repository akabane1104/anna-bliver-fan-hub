const {
  catalogQuerySchema,
  ownRequestsQuerySchema,
  optionalTargetQuerySchema,
  parseIdempotencyKey,
  publicIdParamSchema,
  rerequestSchema,
  websiteSongRequestSchema,
  withdrawRequestSchema
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
    reason_code: safeStatus < 500 ? (error.code || 'request_rejected') : 'internal_error',
    public_reason: safeStatus < 500 ? (error.publicReason || error.message) : undefined,
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
        const request = typeof service.getOwnRequest === 'function'
          ? await service.getOwnRequest(result.request.public_id, req.userId)
          : await service.getPublicRequest(result.request.public_id);
        return res.status(result.duplicate ? 200 : 201).json({
          status: result.duplicate ? 'duplicate' : 'accepted',
          request
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async center(req, res) {
      try {
        return res.json(await service.getCenter(req.userId || null));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async mine(req, res) {
      try {
        const query = parseOrThrow(
          ownRequestsQuerySchema,
          req.query,
          'invalid_request_query'
        );
        return res.json(await service.getMine(req.userId, query));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async withdraw(req, res) {
      try {
        const publicId = parseOrThrow(
          publicIdParamSchema,
          req.params,
          'invalid_request_id'
        ).publicId;
        const input = parseOrThrow(withdrawRequestSchema, req.body);
        return res.json({
          status: 'accepted',
          request: await service.withdraw(
            publicId,
            req.userId,
            input.expected_revision ?? null
          )
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async rerequest(req, res) {
      try {
        const publicId = parseOrThrow(
          publicIdParamSchema,
          req.params,
          'invalid_request_id'
        ).publicId;
        parseOrThrow(rerequestSchema, req.body);
        const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
        if (!idempotencyKey) {
          throw new SongRequestError(
            400,
            'invalid_idempotency_key',
            '必须提供有效的 Idempotency-Key 请求头'
          );
        }
        const result = await service.rerequest(publicId, req.userId, idempotencyKey);
        return res.status(result.duplicate ? 200 : 201).json({
          status: result.duplicate ? 'duplicate' : 'accepted',
          request: await service.getOwnRequest(result.request.public_id, req.userId)
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
