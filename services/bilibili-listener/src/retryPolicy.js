const { listenerError } = require('./errors');

function sourceReconnectDelay({
  attempt,
  initialMs,
  maxMs,
  random = Math.random
}) {
  const exponent = Math.max(0, Number(attempt) || 0);
  const capped = Math.min(maxMs, initialMs * (2 ** exponent));
  const jitter = 0.8 + (Math.min(1, Math.max(0, random())) * 0.4);
  return Math.max(1, Math.round(capped * jitter));
}

function deliveryRetryDelay({ attempt, initialMs, maxMs }) {
  const exponent = Math.max(0, (Number(attempt) || 1) - 1);
  return Math.min(maxMs, initialMs * (2 ** exponent));
}

function sleepWithSignal(ms, signal, {
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (signal?.aborted) return Promise.reject(listenerError('delivery_aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(listenerError('delivery_aborted'));
    };
    const timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  deliveryRetryDelay,
  sleepWithSignal,
  sourceReconnectDelay
};
