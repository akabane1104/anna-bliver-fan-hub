const crypto = require('crypto');

function rejected(res, statusCode, reason) {
  return res.status(statusCode).json({ status: 'rejected', reason });
}

function createLiveEventAvailability(config) {
  return function liveEventAvailability(req, res, next) {
    if (!config.enabled) return res.status(404).end();
    if (!config.ready) return rejected(res, 503, 'ingest_unavailable');
    req.liveEventConfig = config;
    return next();
  };
}

function requireServiceOnlyRequest(req, res, next) {
  if (req.headers.authorization || req.headers.cookie || req.headers.origin) {
    return rejected(res, 403, 'service_identity_required');
  }
  if (!req.is('application/json')) {
    return rejected(res, 415, 'unsupported_media_type');
  }
  const contentEncoding = String(req.headers['content-encoding'] || 'identity').toLowerCase();
  if (contentEncoding !== 'identity') {
    return rejected(res, 415, 'unsupported_content_encoding');
  }
  return next();
}

function createLiveEventSignatureAuth({ now = Date.now } = {}) {
  return function liveEventSignatureAuth(req, res, next) {
    const config = req.liveEventConfig;
    const rawTimestamp = String(req.headers['x-live-timestamp'] || '');
    const rawSignature = String(req.headers['x-live-signature'] || '');

    if (!/^[0-9]{1,12}$/.test(rawTimestamp) || !/^[a-f0-9]{64}$/i.test(rawSignature)) {
      return rejected(res, 401, 'invalid_service_signature');
    }

    const timestampSeconds = Number(rawTimestamp);
    const nowSeconds = Math.floor(now() / 1000);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > config.maxSkewSeconds
    ) {
      return rejected(res, 401, 'timestamp_out_of_range');
    }

    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      return rejected(res, 400, 'invalid_json');
    }

    const expected = crypto
      .createHmac('sha256', config.secret)
      .update(`${rawTimestamp}.`, 'utf8')
      .update(rawBody)
      .digest();
    const provided = Buffer.from(rawSignature, 'hex');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return rejected(res, 401, 'invalid_service_signature');
    }

    req.liveEventRawBody = rawBody;
    return next();
  };
}

module.exports = {
  createLiveEventAvailability,
  createLiveEventSignatureAuth,
  requireServiceOnlyRequest
};
