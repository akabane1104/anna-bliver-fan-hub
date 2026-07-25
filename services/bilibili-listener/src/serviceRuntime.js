const path = require('node:path');
const {
  loadListenerServiceConfig
} = require('./config');
const { listenerError, safeErrorCode } = require('./errors');
const {
  writeHealthSnapshot
} = require('./healthStatus');
const { acquireInstanceLock } = require('./instanceLock');
const {
  createProductionRuntime
} = require('./productionRuntime');

function requireDataDirectory(env) {
  const dataDir = String(env.LISTENER_DATA_DIR || '').trim();
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw listenerError('invalid_listener_data_dir');
  }
  return dataDir;
}

function createServiceRuntime({
  env = process.env,
  runtimeFactory = createProductionRuntime,
  lockFactory = acquireInstanceLock,
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  healthIntervalMs = 5000,
  ...runtimeOptions
} = {}) {
  const dataDir = requireDataDirectory(env);
  let serviceConfig = null;
  let lock = null;
  let runtime = null;
  let healthTimer = null;
  let state = 'idle';
  let failureReason = null;

  const snapshot = () => {
    const activeSnapshot = runtime?.snapshot?.() || null;
    const sourceState = activeSnapshot?.source?.source_state;
    let reportedState = state;
    if (state === 'running' || state === 'starting') {
      if (activeSnapshot?.state === 'fatal') {
        reportedState = activeSnapshot.degraded_reason ===
          'official_identity_code_error'
          ? 'credentials_expired'
          : 'configuration_error';
      } else if (activeSnapshot?.degraded === true) {
        reportedState = 'degraded';
      } else if (activeSnapshot?.state === 'backing_off') {
        reportedState = 'reconnecting';
      } else if (
        [
          'app_starting',
          'app_started',
          'wss_connecting',
          'authenticating',
          'authenticated'
        ].includes(sourceState)
      ) {
        reportedState = sourceState;
      } else if (
        activeSnapshot?.state === 'connected' &&
        activeSnapshot?.source?.websocket_authenticated === true
      ) {
        reportedState = 'healthy';
      }
    }
    const healthy = ['disabled', 'healthy'].includes(reportedState);
    return Object.freeze({
      healthy,
      enabled: serviceConfig?.listenerEnabled ?? null,
      state: reportedState,
      updated_at: new Date(clock()).toISOString(),
      feature_gates: Object.freeze({
        official_api: serviceConfig?.officialApiEnabled ?? null,
        official_wss: serviceConfig?.officialWssEnabled ?? null,
        backend_ingest: serviceConfig?.backendIngestEnabled ?? null,
        gift_auto_credit: serviceConfig?.giftAutoCreditEnabled ?? null
      }),
      ...(failureReason ? { error_code: failureReason } : {}),
      ...(activeSnapshot ? { runtime: activeSnapshot } : {})
    });
  };

  const writeHealth = () => writeHealthSnapshot(dataDir, snapshot());
  const scheduleHealth = () => {
    if (healthTimer !== null || state === 'stopped') return;
    healthTimer = setTimer(() => {
      healthTimer = null;
      writeHealth();
      scheduleHealth();
    }, healthIntervalMs);
  };

  return Object.freeze({
    async start() {
      if (state !== 'idle') throw listenerError('listener_already_started');
      lock = await lockFactory(dataDir);
      state = 'starting';
      writeHealth();
      scheduleHealth();
      try {
        serviceConfig = loadListenerServiceConfig(env);
      } catch (error) {
        failureReason = safeErrorCode(error, 'invalid_listener_config');
        state = 'configuration_error';
        writeHealth();
        return snapshot();
      }
      if (!serviceConfig.listenerEnabled) {
        state = 'disabled';
        writeHealth();
        return snapshot();
      }

      try {
        runtime = runtimeFactory({
          source: 'bilibili-official',
          env,
          clock,
          setTimer,
          clearTimer,
          ...runtimeOptions
        });
        await runtime.start();
        state = 'running';
        writeHealth();
        return snapshot();
      } catch (error) {
        failureReason = safeErrorCode(error, 'listener_start_failed');
        state = failureReason === 'official_identity_code_error'
          ? 'credentials_expired'
          : 'configuration_error';
        writeHealth();
        return snapshot();
      }
    },
    async stop() {
      if (healthTimer !== null) {
        clearTimer(healthTimer);
        healthTimer = null;
      }
      state = 'stopping';
      let stopError = null;
      try {
        await runtime?.stop?.();
      } catch (error) {
        failureReason = safeErrorCode(error, 'listener_stop_failed');
        stopError = error;
      }
      state = 'stopped';
      try {
        writeHealth();
      } catch (error) {
        stopError ||= error;
      }
      try {
        await lock?.release?.();
      } catch (error) {
        stopError ||= error;
      }
      lock = null;
      if (stopError) {
        throw listenerError(
          safeErrorCode(stopError, 'listener_stop_failed')
        );
      }
      return snapshot();
    },
    snapshot
  });
}

module.exports = {
  createServiceRuntime,
  requireDataDirectory
};
