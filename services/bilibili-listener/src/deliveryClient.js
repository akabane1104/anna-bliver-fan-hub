const crypto = require('node:crypto');
const {
  validateLiveEvent
} = require('../../../backend/src/schemas/liveEventSchema');
const { listenerError } = require('./errors');
const {
  deliveryRetryDelay,
  sleepWithSignal
} = require('./retryPolicy');
const { assertLoopbackBaseUrl } = require('./urlSafety');

const INGEST_PATH = '/api/internal/live-events/v1/ingest';
const MAX_ACK_BYTES = 16 * 1024;

function signRawBody({ secret, timestamp, rawBody }) {
  if (
    typeof secret !== 'string' ||
    !secret.trim() ||
    Buffer.byteLength(secret, 'utf8') < 32
  ) {
    throw listenerError('invalid_ingest_secret');
  }
  const normalizedTimestamp = String(timestamp);
  if (!/^[0-9]{1,12}$/.test(normalizedTimestamp)) {
    throw listenerError('invalid_timestamp');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`${normalizedTimestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

async function readAckBody(response, {
  signal,
  maxBytes = MAX_ACK_BYTES
} = {}) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const textPromise = Promise.resolve().then(() => response.text());
    const text = await new Promise((resolve, reject) => {
      const onAbort = () => reject(listenerError('delivery_aborted'));
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
      throw listenerError('ack_too_large');
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
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
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative if cancellation also fails.
        }
        throw listenerError('ack_too_large');
      }
      chunks.push(chunk);
    }
    if (aborted) throw listenerError('delivery_aborted');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function parseAck(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_ACK_BYTES) {
    throw listenerError('ack_too_large');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    return value;
  } catch {
    throw listenerError('invalid_ack');
  }
}

function classifyAck(httpStatus, ack) {
  if (httpStatus === 201 && ack?.status === 'accepted') {
    return { outcome: 'accepted', retryable: false };
  }
  if (httpStatus === 200 && ack?.status === 'duplicate') {
    return { outcome: 'duplicate', retryable: false };
  }
  if (
    httpStatus === 409 &&
    ack?.status === 'rejected' &&
    ack?.reason === 'event_id_conflict'
  ) {
    return { outcome: 'conflict', retryable: false };
  }
  if (
    (httpStatus === 500 && ack?.reason === 'database_error') ||
    [429, 502, 504].includes(httpStatus)
  ) {
    return {
      outcome: 'temporary_failure',
      retryable: true,
      reason: ack?.reason || 'temporary_http_error'
    };
  }
  return {
    outcome: 'permanent_failure',
    retryable: false,
    reason: ack?.reason || 'unexpected_ack'
  };
}

function prepareEvent(event, {
  validator = validateLiveEvent
} = {}) {
  const validation = validator(event);
  if (!validation.success) throw listenerError('invalid_event_schema');
  const rawBody = Buffer.from(JSON.stringify(validation.data), 'utf8');
  return Object.freeze({
    eventId: validation.data.event_id,
    eventType: validation.data.event_type,
    rawBody,
    bodyHash: crypto.createHash('sha256').update(rawBody).digest('hex')
  });
}

class DeliveryClient {
  constructor({
    config,
    fetchImpl = fetch,
    clock = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = sleepWithSignal
  }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sleep = sleep;
    this.endpoint = new URL(
      INGEST_PATH,
      assertLoopbackBaseUrl(config.backendUrl)
    );
  }

  prepare(event) {
    return prepareEvent(event);
  }

  async attempt(prepared, { signal, timestamp: suppliedTimestamp } = {}) {
    if (signal?.aborted) {
      return { outcome: 'temporary_failure', retryable: true, reason: 'delivery_aborted' };
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
        if (error?.code !== 'invalid_ack') {
          return {
            outcome: 'temporary_failure',
            retryable: true,
            reason: 'network_error',
            httpStatus: response.status
          };
        }
        if ([429, 500, 502, 504].includes(response.status)) {
          return {
            outcome: 'temporary_failure',
            retryable: true,
            reason: 'temporary_http_error',
            httpStatus: response.status
          };
        }
        return {
          outcome: 'permanent_failure',
          retryable: false,
          reason: 'invalid_ack',
          httpStatus: response.status
        };
      }

      return {
        ...classifyAck(response.status, ack),
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
    for (let attempt = 1; attempt <= this.config.deliveryMaxAttempts; attempt += 1) {
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
      onRetry({
        attempt: attempt + 1,
        reason: result.reason,
        eventType: prepared.eventType
      });
    }
    throw listenerError('unreachable_delivery_state');
  }
}

module.exports = {
  INGEST_PATH,
  MAX_ACK_BYTES,
  DeliveryClient,
  classifyAck,
  parseAck,
  prepareEvent,
  readAckBody,
  signRawBody
};
