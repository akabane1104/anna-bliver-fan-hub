const crypto = require('node:crypto');
const { loadListenerConfig } = require('./config');
const {
  MAX_ACK_BYTES,
  parseAck,
  readAckBody,
  signRawBody
} = require('./deliveryClient');
const { listenerError, safeErrorCode } = require('./errors');
const {
  deliveryRetryDelay,
  sleepWithSignal
} = require('./retryPolicy');
const { assertBackendBaseUrl } = require('./urlSafety');

const STATUS_PATH = '/api/internal/live-events/v1/status';
const REPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOM_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function transportFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw listenerError('invalid_listener_status');
  }
  const state = String(snapshot.state || '');
  const authenticated =
    snapshot.runtime?.source?.websocket_authenticated === true;

  if (snapshot.enabled === false || state === 'disabled') {
    return { transport_state: 'disabled', authenticated: false };
  }
  if (state === 'healthy' || state === 'connected') {
    return {
      transport_state: 'connected',
      authenticated
    };
  }
  if ([
    'starting',
    'app_starting',
    'app_started',
    'wss_connecting',
    'authenticating',
    'authenticated',
    'reconnecting',
    'backing_off'
  ].includes(state)) {
    return { transport_state: 'connecting', authenticated: false };
  }
  if (['degraded', 'stopping', 'stopped'].includes(state)) {
    return { transport_state: 'disconnected', authenticated: false };
  }
  return { transport_state: 'unavailable', authenticated: false };
}

function prepareStatusReport(snapshot, config, {
  clock = Date.now,
  idFactory = crypto.randomUUID
} = {}) {
  const reportId = idFactory();
  if (!REPORT_ID_PATTERN.test(String(reportId || ''))) {
    throw listenerError('invalid_listener_status_report_id');
  }
  if (!SITE_ID_PATTERN.test(String(config?.siteId || ''))) {
    throw listenerError('invalid_listener_site_id');
  }
  if (!ROOM_ID_PATTERN.test(String(config?.roomId || ''))) {
    throw listenerError('invalid_listener_room_id');
  }
  const reportedAtDate = new Date(clock());
  if (!Number.isFinite(reportedAtDate.getTime())) {
    throw listenerError('invalid_listener_status_timestamp');
  }
  const reportedAt = reportedAtDate.toISOString();
  const transport = transportFromSnapshot(snapshot);
  const report = Object.freeze({
    report_id: reportId,
    site_id: config.siteId,
    room_id: config.roomId,
    ...transport,
    reported_at: reportedAt
  });
  return Object.freeze({
    reportId,
    rawBody: Buffer.from(JSON.stringify(report), 'utf8')
  });
}

function classifyStatusAck(httpStatus, ack) {
  const reason = (fallback) => safeErrorCode(
    { code: ack?.reason },
    fallback
  );
  if (httpStatus === 201 && ack?.status === 'accepted') {
    return { outcome: 'accepted', retryable: false };
  }
  if (
    httpStatus === 409 &&
    ack?.status === 'rejected' &&
    ack?.reason === 'listener_status_replay'
  ) {
    return { outcome: 'duplicate', retryable: false };
  }
  if (
    httpStatus === 409 &&
    ack?.status === 'rejected' &&
    ack?.reason === 'listener_status_stale'
  ) {
    return {
      outcome: 'stale',
      retryable: false,
      reason: 'listener_status_stale'
    };
  }
  if (httpStatus === 404) {
    return {
      outcome: 'ingest_disabled',
      retryable: false,
      reason: 'ingest_disabled'
    };
  }
  if ([401, 403].includes(httpStatus)) {
    return {
      outcome: 'authentication_failed',
      retryable: false,
      reason: reason('ingest_authentication_failed')
    };
  }
  if ([400, 409, 422].includes(httpStatus)) {
    return {
      outcome: 'permanent_rejection',
      retryable: false,
      reason: reason('invalid_listener_status')
    };
  }
  if (httpStatus === 503 && ack?.reason === 'ingest_unavailable') {
    return {
      outcome: 'ingest_disabled',
      retryable: false,
      reason: 'ingest_unavailable'
    };
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return {
      outcome: 'temporary_failure',
      retryable: true,
      reason: reason('temporary_http_error')
    };
  }
  return {
    outcome: 'permanent_failure',
    retryable: false,
    reason: reason('unexpected_ack')
  };
}

class ListenerStatusReporter {
  constructor({
    config,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    idFactory = crypto.randomUUID,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = sleepWithSignal
  }) {
    if (typeof fetchImpl !== 'function') {
      throw listenerError('status_fetch_unavailable');
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.idFactory = idFactory;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sleep = sleep;
    this.lastReportedAtMs = null;
    this.endpoint = new URL(
      STATUS_PATH,
      assertBackendBaseUrl(config.backendUrl)
    );
  }

  prepare(snapshot) {
    const currentTime = Number(this.clock());
    if (!Number.isFinite(currentTime)) {
      throw listenerError('invalid_listener_status_timestamp');
    }
    const reportedAtMs = this.lastReportedAtMs === null
      ? currentTime
      : Math.max(currentTime, this.lastReportedAtMs + 1);
    this.lastReportedAtMs = reportedAtMs;
    return prepareStatusReport(snapshot, this.config, {
      clock: () => reportedAtMs,
      idFactory: this.idFactory
    });
  }

  async attempt(prepared, { signal, timestamp: suppliedTimestamp } = {}) {
    if (signal?.aborted) {
      return {
        outcome: 'temporary_failure',
        retryable: true,
        reason: 'delivery_aborted'
      };
    }
    const timestamp = String(
      suppliedTimestamp ?? Math.floor(this.clock() / 1000)
    );
    const signature = signRawBody({
      secret: this.config.secret,
      timestamp,
      rawBody: prepared.rawBody
    });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = this.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, this.config.deliveryTimeoutMs);

    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Live-Timestamp': timestamp,
          'X-Live-Signature': signature
        },
        body: prepared.rawBody,
        redirect: 'error',
        signal: controller.signal
      });
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_ACK_BYTES) {
        return {
          outcome: 'permanent_failure',
          retryable: false,
          reason: 'ack_too_large'
        };
      }
      if (response.status === 404) {
        return classifyStatusAck(response.status, null);
      }

      let ack;
      try {
        ack = parseAck(await readAckBody(response, {
          signal: controller.signal
        }));
      } catch (error) {
        if (error?.code === 'ack_too_large') {
          return {
            outcome: 'permanent_failure',
            retryable: false,
            reason: 'ack_too_large',
            httpStatus: response.status
          };
        }
        if (timedOut) {
          return {
            outcome: 'temporary_failure',
            retryable: true,
            reason: 'delivery_timeout',
            httpStatus: response.status
          };
        }
        if (signal?.aborted) {
          return {
            outcome: 'temporary_failure',
            retryable: true,
            reason: 'delivery_aborted',
            httpStatus: response.status
          };
        }
        if (
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599)
        ) {
          return {
            outcome: 'temporary_failure',
            retryable: true,
            reason: 'temporary_http_error',
            httpStatus: response.status
          };
        }
        if ([400, 401, 403, 409, 422].includes(response.status)) {
          return classifyStatusAck(response.status, null);
        }
        return {
          outcome: 'permanent_failure',
          retryable: false,
          reason: 'invalid_ack',
          httpStatus: response.status
        };
      }
      return {
        ...classifyStatusAck(response.status, ack),
        httpStatus: response.status
      };
    } catch {
      return {
        outcome: 'temporary_failure',
        retryable: true,
        reason: timedOut
          ? 'delivery_timeout'
          : (signal?.aborted ? 'delivery_aborted' : 'network_error')
      };
    } finally {
      this.clearTimer(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async deliverPrepared(prepared, {
    signal,
    onRetry = () => {}
  } = {}) {
    let previousTimestamp = null;
    for (
      let attempt = 1;
      attempt <= this.config.deliveryMaxAttempts;
      attempt += 1
    ) {
      const currentTimestamp = Math.floor(this.clock() / 1000);
      const timestamp = previousTimestamp === null
        ? currentTimestamp
        : Math.max(currentTimestamp, previousTimestamp + 1);
      previousTimestamp = timestamp;
      const result = await this.attempt(prepared, { signal, timestamp });
      if (!result.retryable) {
        return { ...result, attempts: attempt, retries: attempt - 1 };
      }
      if (signal?.aborted || result.reason === 'delivery_aborted') {
        return {
          outcome: 'failed',
          reason: 'delivery_aborted',
          attempts: attempt,
          retries: attempt - 1
        };
      }
      if (attempt >= this.config.deliveryMaxAttempts) {
        return {
          outcome: 'failed',
          reason: result.reason,
          attempts: attempt,
          retries: attempt - 1
        };
      }
      const delay = deliveryRetryDelay({
        attempt,
        initialMs: this.config.deliveryRetryInitialMs,
        maxMs: this.config.deliveryRetryMaxMs
      });
      try {
        await this.sleep(delay, signal, {
          setTimer: this.setTimer,
          clearTimer: this.clearTimer
        });
      } catch {
        return {
          outcome: 'failed',
          reason: 'delivery_aborted',
          attempts: attempt,
          retries: attempt - 1
        };
      }
      onRetry({ attempt: attempt + 1, reason: result.reason });
    }
    throw listenerError('unreachable_status_delivery_state');
  }

  async report(snapshot, options = {}) {
    return this.deliverPrepared(this.prepare(snapshot), options);
  }
}

function createStatusReporterFromEnv({
  env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  return new ListenerStatusReporter({
    config: loadListenerConfig(env, { mode: 'production' }),
    fetchImpl,
    clock,
    setTimer,
    clearTimer
  });
}

module.exports = {
  ListenerStatusReporter,
  REPORT_ID_PATTERN,
  STATUS_PATH,
  classifyStatusAck,
  createStatusReporterFromEnv,
  prepareStatusReport,
  transportFromSnapshot
};
