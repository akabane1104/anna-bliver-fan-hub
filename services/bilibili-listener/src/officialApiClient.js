const crypto = require('node:crypto');
const { listenerError } = require('./errors');
const {
  serializeOfficialBody,
  signOfficialRequest
} = require('./officialApiSigner');

const OFFICIAL_API_ORIGIN = 'https://live-open.biliapi.com';
const OFFICIAL_API_PATHS = Object.freeze({
  start: '/v2/app/start',
  heartbeat: '/v2/app/heartbeat',
  end: '/v2/app/end'
});
const MAX_OFFICIAL_RESPONSE_BYTES = 64 * 1024;

const OFFICIAL_CODE_CLASSIFICATION = Object.freeze({
  0: Object.freeze({ code: 'official_ok', transient: false }),
  4000: Object.freeze({ code: 'official_parameter_error', transient: false }),
  4001: Object.freeze({ code: 'official_access_key_error', transient: false }),
  4002: Object.freeze({ code: 'official_signature_error', transient: false }),
  4003: Object.freeze({ code: 'official_timestamp_error', transient: false }),
  4004: Object.freeze({ code: 'official_nonce_reused', transient: false }),
  4005: Object.freeze({ code: 'official_signature_method_error', transient: false }),
  4006: Object.freeze({ code: 'official_signature_version_error', transient: false }),
  4007: Object.freeze({ code: 'official_ip_not_allowed', transient: false }),
  4008: Object.freeze({ code: 'official_permission_denied', transient: false }),
  4009: Object.freeze({ code: 'official_rate_or_permission_error', transient: true }),
  4010: Object.freeze({ code: 'official_endpoint_error', transient: false }),
  4011: Object.freeze({ code: 'official_content_type_error', transient: false }),
  4012: Object.freeze({ code: 'official_content_md5_error', transient: false }),
  4013: Object.freeze({ code: 'official_accept_error', transient: false }),
  5000: Object.freeze({ code: 'official_service_error', transient: true }),
  5001: Object.freeze({ code: 'official_service_timeout', transient: true }),
  5002: Object.freeze({ code: 'official_internal_error', transient: true }),
  5003: Object.freeze({ code: 'official_configuration_error', transient: false }),
  5004: Object.freeze({ code: 'official_room_not_allowed', transient: false }),
  5005: Object.freeze({ code: 'official_blacklist_error', transient: false }),
  5011: Object.freeze({ code: 'official_app_permission_error', transient: false }),
  7000: Object.freeze({ code: 'official_session_not_found', transient: false }),
  7001: Object.freeze({ code: 'official_session_cooling_down', transient: true }),
  7002: Object.freeze({ code: 'official_session_duplicate', transient: false }),
  7003: Object.freeze({ code: 'official_session_heartbeat_expired', transient: false }),
  7007: Object.freeze({ code: 'official_identity_code_error', transient: false }),
  7008: Object.freeze({ code: 'official_plugin_duplicate', transient: false }),
  7009: Object.freeze({ code: 'official_gift_permission_error', transient: false }),
  7010: Object.freeze({ code: 'official_connection_limit', transient: true }),
  8002: Object.freeze({ code: 'official_project_access_denied', transient: false })
});

function officialApiError(code, {
  officialCode = null,
  requestId = null,
  transient = false,
  httpStatus = null
} = {}) {
  const error = listenerError(code);
  error.officialCode = officialCode;
  error.requestId = requestId;
  error.transient = transient;
  error.fatal = !transient;
  error.httpStatus = httpStatus;
  return error;
}

function classifyOfficialCode(code) {
  return OFFICIAL_CODE_CLASSIFICATION[code] || Object.freeze({
    code: 'official_unknown_error',
    transient: false
  });
}

async function readLimitedResponse(response, {
  maxBytes = MAX_OFFICIAL_RESPONSE_BYTES,
  signal
} = {}) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw officialApiError('official_response_too_large');
  }

  if (!response?.body || typeof response.body.getReader !== 'function') {
    const textPromise = Promise.resolve().then(() => response.text());
    const text = await new Promise((resolve, reject) => {
      const onAbort = () => reject(listenerError('official_response_aborted'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      textPromise.then(
        (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw officialApiError('official_response_too_large');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw officialApiError('official_response_too_large');
      }
      chunks.push(chunk);
    }
    if (aborted) throw listenerError('official_response_aborted');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseOfficialResponse(text, httpStatus) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw officialApiError('invalid_official_response', { httpStatus });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isInteger(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length > 512 ||
    (
      value.request_id !== undefined &&
      (
        typeof value.request_id !== 'string' ||
        value.request_id.length > 128
      )
    )
  ) {
    throw officialApiError('invalid_official_response', { httpStatus });
  }
  if (httpStatus !== 200) {
    throw officialApiError('official_http_error', {
      httpStatus,
      requestId: value.request_id || null,
      transient: httpStatus === 429 || httpStatus >= 500
    });
  }
  const classification = classifyOfficialCode(value.code);
  if (value.code !== 0) {
    throw officialApiError(classification.code, {
      officialCode: value.code,
      requestId: value.request_id || null,
      transient: classification.transient,
      httpStatus
    });
  }
  return Object.freeze({
    code: value.code,
    message: value.message,
    requestId: value.request_id || null,
    data: value.data
  });
}

function assertCanonicalDecimal(value, code, {
  min = 1,
  max = Number.MAX_SAFE_INTEGER
} = {}) {
  const raw = typeof value === 'number' ? String(value) : String(value || '');
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  ) {
    throw listenerError(code);
  }
  return raw;
}

function validateStartData(data) {
  const gameId = data?.game_info?.game_id;
  const authBody = data?.websocket_info?.auth_body;
  const roomId = data?.anchor_info?.room_id;
  const wssLinks = data?.websocket_info?.wss_link;
  if (
    typeof gameId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,255}$/.test(gameId) ||
    typeof authBody !== 'string' ||
    Buffer.byteLength(authBody, 'utf8') < 2 ||
    Buffer.byteLength(authBody, 'utf8') > 16 * 1024 ||
    !Array.isArray(wssLinks) ||
    wssLinks.length < 1 ||
    wssLinks.length > 5 ||
    wssLinks.some((value) => (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 2048
    ))
  ) {
    throw officialApiError('invalid_official_start_response');
  }
  const normalizedRoomId = assertCanonicalDecimal(
    roomId,
    'invalid_official_start_response'
  );
  return Object.freeze({
    gameId,
    authBody,
    roomId: normalizedRoomId,
    wssLinks: Object.freeze([...wssLinks])
  });
}

class OfficialApiClient {
  constructor({
    accessKeyId,
    accessKeySecret,
    appId,
    identityCode,
    expectedRoomId,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    nonce = crypto.randomUUID,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.appId = assertCanonicalDecimal(appId, 'invalid_bilibili_app_id');
    this.appIdNumber = Number(this.appId);
    this.identityCode = identityCode;
    this.expectedRoomId = assertCanonicalDecimal(
      expectedRoomId,
      'invalid_listener_room_id'
    );
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.nonce = nonce;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  async request(path, body, { signal } = {}) {
    if (!Object.values(OFFICIAL_API_PATHS).includes(path)) {
      throw listenerError('invalid_official_api_path');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw listenerError('official_fetch_unavailable');
    }
    const rawBody = serializeOfficialBody(body);
    const timestamp = String(Math.floor(this.clock() / 1000));
    const signed = signOfficialRequest({
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
      rawBody,
      timestamp,
      nonce: this.nonce()
    });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = this.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        new URL(path, OFFICIAL_API_ORIGIN),
        {
          method: 'POST',
          headers: signed.headers,
          body: rawBody,
          redirect: 'error',
          signal: controller.signal
        }
      );
      const text = await readLimitedResponse(response, {
        signal: controller.signal
      });
      return parseOfficialResponse(text, response.status);
    } catch (error) {
      if (timedOut) {
        throw officialApiError('official_request_timeout', { transient: true });
      }
      if (signal?.aborted) {
        throw officialApiError('official_request_aborted', { transient: true });
      }
      if (error?.code) throw error;
      throw officialApiError(
        'official_network_error',
        { transient: true }
      );
    } finally {
      this.clearTimer(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async start({ signal } = {}) {
    const response = await this.request(OFFICIAL_API_PATHS.start, {
      code: this.identityCode,
      app_id: this.appIdNumber
    }, { signal });
    return validateStartData(response.data);
  }

  async heartbeat(gameId, { signal } = {}) {
    return this.request(OFFICIAL_API_PATHS.heartbeat, {
      game_id: gameId
    }, { signal });
  }

  async end(gameId, { signal } = {}) {
    return this.request(OFFICIAL_API_PATHS.end, {
      app_id: this.appIdNumber,
      game_id: gameId
    }, { signal });
  }
}

module.exports = {
  MAX_OFFICIAL_RESPONSE_BYTES,
  OFFICIAL_API_ORIGIN,
  OFFICIAL_API_PATHS,
  OFFICIAL_CODE_CLASSIFICATION,
  OfficialApiClient,
  assertCanonicalDecimal,
  classifyOfficialCode,
  parseOfficialResponse,
  readLimitedResponse,
  validateStartData
};
