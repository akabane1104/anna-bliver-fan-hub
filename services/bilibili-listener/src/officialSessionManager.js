const { listenerError, safeErrorCode } = require('./errors');
const {
  OPERATIONS,
  createAuthPacket,
  createHeartbeatPacket,
  parseJsonBody,
  parsePackets
} = require('./officialProtocol');
const {
  addSocketListener,
  socketDataToBuffer
} = require('./officialBilibiliAdapter');
const {
  getOfficialWssAuthBody,
  revalidateOfficialWssLink,
  validateOfficialWssLinks
} = require('./officialWssUrl');

const OFFICIAL_SESSION_STATES = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  WAITING_FOR_OFFICIAL_SESSION: 'WAITING_FOR_OFFICIAL_SESSION',
  ACTIVE: 'ACTIVE',
  RECONNECTING: 'RECONNECTING',
  STOPPING: 'STOPPING',
  FAILED: 'FAILED'
});

function delay(ms, {
  signal,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimer(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function randomBetween(min, max, random = Math.random) {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

class OfficialSessionManager {
  constructor({
    config,
    apiClient,
    sessionLock,
    eventProcessor,
    webSocketFactory,
    logger,
    lookup,
    clock = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = null
  }) {
    if (
      typeof webSocketFactory !== 'function' ||
      !apiClient ||
      !sessionLock ||
      !eventProcessor
    ) {
      throw listenerError('invalid_official_session_manager');
    }
    this.config = config;
    this.apiClient = apiClient;
    this.sessionLock = sessionLock;
    this.eventProcessor = eventProcessor;
    this.webSocketFactory = webSocketFactory;
    this.logger = logger || { write() {} };
    this.lookup = lookup;
    this.clock = clock;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sleep = sleep || ((ms, signal) => delay(ms, {
      signal,
      setTimer,
      clearTimer
    }));
    this.state = OFFICIAL_SESSION_STATES.STOPPED;
    this.controller = null;
    this.loopPromise = null;
    this.session = null;
    this.sessionEnded = true;
    this.sessionInvalidated = false;
    this.resolveSessionInvalidated = null;
    this.socket = null;
    this.socketCleanup = [];
    this.socketGeneration = 0;
    this.socketAuthenticated = false;
    this.socketConnectPromise = null;
    this.socketMessageChain = Promise.resolve();
    this.projectHeartbeatTimer = null;
    this.wsHeartbeatTimer = null;
    this.wsHeartbeatReplyTimer = null;
    this.cleanupTimer = null;
    this.projectHeartbeatFailures = 0;
    this.lastErrorCode = null;
    this.initialRecoveryWaitCompleted = false;
    this.counters = {
      lock_attempts: 0,
      lock_contention: 0,
      start_attempts: 0,
      start_successes: 0,
      duplicate_responses: 0,
      project_heartbeat_successes: 0,
      project_heartbeat_failures: 0,
      wss_auth_successes: 0,
      wss_heartbeat_sent: 0,
      wss_heartbeat_replies: 0,
      wss_reconnects: 0,
      wss_cluster_switches: 0,
      end_attempts: 0,
      end_successes: 0
    };
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      session_active: Boolean(this.session && !this.sessionEnded),
      websocket_authenticated: this.socketAuthenticated,
      last_error_code: this.lastErrorCode,
      ...this.counters,
      events: this.eventProcessor.snapshot()
    });
  }

  async start() {
    if (this.loopPromise) throw listenerError('listener_already_started');
    this.controller = new AbortController();
    this.state = OFFICIAL_SESSION_STATES.STARTING;
    this.loopPromise = this._run(this.controller.signal)
      .catch((error) => {
        if (!this.controller?.signal.aborted) {
          this.lastErrorCode = safeErrorCode(
            error,
            'official_session_manager_failed'
          );
          this.state = OFFICIAL_SESSION_STATES.FAILED;
          this.logger.write('error', 'official_session_manager_failed', {
            error_code: this.lastErrorCode,
            state: this.state
          });
        }
      });
    return this.snapshot();
  }

  async stop() {
    if (!this.loopPromise && this.state === OFFICIAL_SESSION_STATES.STOPPED) {
      return this.snapshot();
    }
    this.state = OFFICIAL_SESSION_STATES.STOPPING;
    this.controller?.abort();
    this._resolveInvalidated();
    this._clearAllTimers();
    this._disposeSocket();
    await this.socketMessageChain.catch(() => {});
    await this._endSessionOnce();
    await this.sessionLock.release().catch(() => {});
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    this.controller = null;
    this.state = OFFICIAL_SESSION_STATES.STOPPED;
    return this.snapshot();
  }

  async controlledReconnect() {
    if (!this.session || this.sessionEnded) {
      return Object.freeze({ status: 'not_active' });
    }
    const startAttempts = this.counters.start_attempts;
    this.counters.wss_reconnects += 1;
    this.state = OFFICIAL_SESSION_STATES.RECONNECTING;
    this._disposeSocket();
    await this._connectUntilAuthenticated(this.controller.signal);
    return Object.freeze({
      status: this.socketAuthenticated ? 'reconnected' : 'failed',
      startAttemptsUnchanged: this.counters.start_attempts === startAttempts
    });
  }

  async _run(signal) {
    while (!signal.aborted) {
      if (!(await this._ensureLock(signal))) continue;
      if (!this.initialRecoveryWaitCompleted) {
        await this._waitForOfficialSession({
          delayMs: this.config.initialRecoveryWaitMs,
          errorCode: 'official_initial_recovery_wait',
          signal
        });
        this.initialRecoveryWaitCompleted = true;
        if (signal.aborted) break;
      }

      this.state = OFFICIAL_SESSION_STATES.STARTING;
      this.counters.start_attempts += 1;
      let started;
      try {
        started = await this.apiClient.start({ signal });
      } catch (error) {
        const code = safeErrorCode(error, 'official_start_failed');
        this.lastErrorCode = code;
        if (code === 'official_session_duplicate') {
          this.counters.duplicate_responses += 1;
          await this._waitForOfficialSession({
            delayMs: this._duplicateRetryDelay(),
            errorCode: code,
            signal
          });
          continue;
        }
        if (error?.transient) {
          await this._waitForOfficialSession({
            delayMs: this._duplicateRetryDelay(),
            errorCode: code,
            signal
          });
          continue;
        }
        throw error;
      }
      if (started.roomId !== this.config.roomId) {
        await this.apiClient.end(started.gameId, { signal }).catch(() => {});
        throw listenerError('official_room_mismatch');
      }
      this.session = Object.freeze({ ...started, wssLinks: [] });
      this.sessionEnded = false;
      let wssLinks;
      try {
        wssLinks = await validateOfficialWssLinks(started.wssTrust, {
          lookup: this.lookup
        });
      } catch (error) {
        const code = safeErrorCode(error, 'official_wss_validation_failed');
        this.lastErrorCode = code;
        await this._endSessionOnce();
        await this._waitForOfficialSession({
          delayMs: this._duplicateRetryDelay(),
          errorCode: code,
          signal
        });
        continue;
      }
      this.session = Object.freeze({ ...started, wssLinks });
      this.sessionInvalidated = false;
      this.projectHeartbeatFailures = 0;
      this.counters.start_successes += 1;
      this.lastErrorCode = null;
      this._scheduleProjectHeartbeat();
      this._scheduleCleanup();

      await this._connectUntilAuthenticated(signal);
      if (
        signal.aborted ||
        this.sessionInvalidated ||
        !this.session ||
        this.sessionEnded
      ) {
        await this._endSessionOnce();
        continue;
      }
      this.state = OFFICIAL_SESSION_STATES.ACTIVE;
      await new Promise((resolve) => {
        this.resolveSessionInvalidated = resolve;
        if (this.sessionInvalidated || signal.aborted) resolve();
      });
      this.resolveSessionInvalidated = null;
      this._clearSessionTimers();
      this._disposeSocket();
      await this._endSessionOnce();
      if (!signal.aborted) {
        await this._waitForOfficialSession({
          delayMs: this._duplicateRetryDelay(),
          errorCode: this.lastErrorCode || 'official_session_restarting',
          signal
        });
      }
    }
  }

  async _ensureLock(signal) {
    this.counters.lock_attempts += 1;
    let acquired = false;
    try {
      acquired = await this.sessionLock.acquire();
    } catch (error) {
      this.lastErrorCode = safeErrorCode(error, 'official_lock_failed');
    }
    if (acquired) return true;
    this.counters.lock_contention += 1;
    await this._waitForOfficialSession({
      delayMs: this.config.lockRetryMs,
      errorCode: this.lastErrorCode || 'official_lock_contended',
      signal
    });
    return false;
  }

  async _waitForOfficialSession({ delayMs, errorCode, signal }) {
    this.state = OFFICIAL_SESSION_STATES.WAITING_FOR_OFFICIAL_SESSION;
    this.logger.write('info', 'official_session_retry_scheduled', {
      state: this.state,
      result: 'healthy',
      error_code: errorCode,
      retry_attempt: this.counters.start_attempts,
      duration_ms: delayMs
    });
    return this.sleep(delayMs, signal);
  }

  _duplicateRetryDelay() {
    return randomBetween(
      this.config.duplicateRetryMinMs,
      this.config.duplicateRetryMaxMs,
      this.random
    );
  }

  async _connectUntilAuthenticated(signal) {
    if (this.socketConnectPromise) return this.socketConnectPromise;
    this.socketConnectPromise = (async () => {
      let attempt = 0;
      while (
        !signal.aborted &&
        this.session &&
        !this.sessionEnded &&
        !this.sessionInvalidated
      ) {
        this.state = attempt === 0
          ? OFFICIAL_SESSION_STATES.STARTING
          : OFFICIAL_SESSION_STATES.RECONNECTING;
        const links = this.session.wssLinks;
        for (let index = 0; index < links.length; index += 1) {
          if (
            signal.aborted ||
            this.sessionInvalidated ||
            this.sessionEnded
          ) {
            return;
          }
          try {
            await this._connectSocket(links[index], signal);
            if (index > 0) this.counters.wss_cluster_switches += 1;
            if (attempt > 0) this.counters.wss_reconnects += 1;
            this.state = OFFICIAL_SESSION_STATES.ACTIVE;
            return;
          } catch (error) {
            this.lastErrorCode = safeErrorCode(
              error,
              'official_wss_connect_failed'
            );
            this._disposeSocket();
          }
        }
        attempt += 1;
        const backoff = Math.min(
          this.config.wssReconnectMaxMs,
          this.config.wssReconnectInitialMs * (2 ** Math.min(attempt - 1, 10))
        );
        await this.sleep(backoff, signal);
      }
    })();
    try {
      await this.socketConnectPromise;
    } finally {
      this.socketConnectPromise = null;
    }
  }

  async _connectSocket(link, signal) {
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    const revalidated = await revalidateOfficialWssLink(
      this.session.wssTrust,
      link,
      { lookup: this.lookup }
    );
    const socket = this.webSocketFactory(revalidated.href);
    if (
      !socket ||
      typeof socket.send !== 'function' ||
      typeof socket.close !== 'function'
    ) {
      throw listenerError('invalid_websocket_implementation');
    }
    this.socket = socket;
    this.socketAuthenticated = false;
    try {
      socket.binaryType = 'arraybuffer';
    } catch {
      // Injected transports may expose a read-only binaryType.
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(authTimer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(listenerError('source_connect_aborted'));
      const authTimer = this.setTimer(
        () => finish(listenerError('official_auth_timeout')),
        this.config.authTimeoutMs
      );
      const onOpen = () => {
        try {
          socket.send(createAuthPacket(
            getOfficialWssAuthBody(this.session.wssTrust, revalidated)
          ));
        } catch {
          finish(listenerError('official_auth_send_failed'));
        }
      };
      const onMessage = (event) => {
        const data = event?.data ?? event;
        this.socketMessageChain = this.socketMessageChain
          .then(() => this._handleSocketData(data, generation, finish))
          .catch((error) => {
            finish(error);
            if (this.socketAuthenticated) {
              this._handleSocketDisconnect('official_protocol_error');
            }
          });
      };
      const onError = () => {
        if (this.socketAuthenticated) {
          this._handleSocketDisconnect('official_wss_error');
        } else {
          finish(listenerError('official_wss_connect_failed'));
        }
      };
      const onClose = () => {
        if (this.socketAuthenticated) {
          this._handleSocketDisconnect('official_wss_closed');
        } else {
          finish(listenerError('official_wss_closed_before_auth'));
        }
      };
      this.socketCleanup = [
        addSocketListener(socket, 'open', onOpen),
        addSocketListener(socket, 'message', onMessage),
        addSocketListener(socket, 'error', onError),
        addSocketListener(socket, 'close', onClose)
      ];
      signal.addEventListener('abort', onAbort, { once: true });
    });
    this._scheduleWsHeartbeat(generation);
  }

  async _handleSocketData(data, generation, authFinish) {
    if (
      generation !== this.socketGeneration ||
      !this.session ||
      this.sessionEnded
    ) {
      return;
    }
    const packets = parsePackets(await socketDataToBuffer(data));
    for (const packet of packets) {
      if (packet.operation === OPERATIONS.AUTH_REPLY) {
        const reply = parseJsonBody(packet.body);
        if (reply.code !== 0) {
          authFinish(listenerError('official_auth_rejected'));
          continue;
        }
        this.socketAuthenticated = true;
        this.counters.wss_auth_successes += 1;
        authFinish();
        continue;
      }
      if (packet.operation === OPERATIONS.HEARTBEAT_REPLY) {
        this.counters.wss_heartbeat_replies += 1;
        this._clearTimer('wsHeartbeatReplyTimer');
        continue;
      }
      if (packet.operation !== OPERATIONS.MESSAGE || !this.socketAuthenticated) {
        continue;
      }
      const message = parseJsonBody(packet.body);
      await this.eventProcessor.process(message);
      if (message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END') {
        this._invalidateSession('official_interaction_end');
      }
    }
  }

  _scheduleProjectHeartbeat() {
    this._clearTimer('projectHeartbeatTimer');
    if (!this.session || this.sessionEnded || this.controller.signal.aborted) {
      return;
    }
    this.projectHeartbeatTimer = this.setTimer(async () => {
      this.projectHeartbeatTimer = null;
      if (!this.session || this.sessionEnded || this.controller.signal.aborted) {
        return;
      }
      try {
        if (!(await this.sessionLock.isHeld())) {
          this._invalidateSession('official_lock_lost');
          return;
        }
        await this.apiClient.heartbeat(this.session.gameId, {
          signal: this.controller.signal
        });
        this.counters.project_heartbeat_successes += 1;
        this.projectHeartbeatFailures = 0;
      } catch (error) {
        this.counters.project_heartbeat_failures += 1;
        this.projectHeartbeatFailures += 1;
        this.lastErrorCode = safeErrorCode(
          error,
          'official_project_heartbeat_failed'
        );
        if (
          this.projectHeartbeatFailures >=
          this.config.apiHeartbeatFailureThreshold
        ) {
          this._invalidateSession(this.lastErrorCode);
          return;
        }
      }
      this._scheduleProjectHeartbeat();
    }, this.config.apiHeartbeatIntervalMs);
  }

  _scheduleWsHeartbeat(generation) {
    this._clearTimer('wsHeartbeatTimer');
    if (
      generation !== this.socketGeneration ||
      !this.socketAuthenticated ||
      !this.socket
    ) {
      return;
    }
    this.wsHeartbeatTimer = this.setTimer(() => {
      this.wsHeartbeatTimer = null;
      if (
        generation !== this.socketGeneration ||
        !this.socketAuthenticated ||
        !this.socket
      ) {
        return;
      }
      try {
        this.socket.send(createHeartbeatPacket());
        this.counters.wss_heartbeat_sent += 1;
      } catch {
        this._handleSocketDisconnect('official_ws_heartbeat_failed');
        return;
      }
      this.wsHeartbeatReplyTimer = this.setTimer(() => {
        this.wsHeartbeatReplyTimer = null;
        this._handleSocketDisconnect('official_ws_heartbeat_timeout');
      }, this.config.wsHeartbeatTimeoutMs);
      this._scheduleWsHeartbeat(generation);
    }, this.config.wsHeartbeatIntervalMs);
  }

  _handleSocketDisconnect(code) {
    if (
      !this.session ||
      this.sessionEnded ||
      this.sessionInvalidated ||
      this.controller?.signal.aborted
    ) {
      return;
    }
    this.lastErrorCode = code;
    this.counters.wss_reconnects += 1;
    this.state = OFFICIAL_SESSION_STATES.RECONNECTING;
    this._disposeSocket();
    this._connectUntilAuthenticated(this.controller.signal).catch(() => {});
  }

  _scheduleCleanup() {
    this._clearTimer('cleanupTimer');
    this.cleanupTimer = this.setTimer(async () => {
      this.cleanupTimer = null;
      await this.eventProcessor.repository?.cleanupExpired?.().catch(() => {});
      if (!this.controller?.signal.aborted) this._scheduleCleanup();
    }, this.config.aiCleanupIntervalMs);
  }

  _invalidateSession(code) {
    if (this.sessionInvalidated) return;
    this.sessionInvalidated = true;
    this.lastErrorCode = code;
    this._resolveInvalidated();
  }

  _resolveInvalidated() {
    if (this.resolveSessionInvalidated) this.resolveSessionInvalidated();
  }

  async _endSessionOnce() {
    if (!this.session || this.sessionEnded) return;
    const gameId = this.session.gameId;
    this.sessionEnded = true;
    this.session = null;
    this.counters.end_attempts += 1;
    try {
      await this.apiClient.end(gameId);
      this.counters.end_successes += 1;
    } catch {
      // A precise single end attempt is best-effort during safe teardown.
    }
  }

  _disposeSocket() {
    this._clearTimer('wsHeartbeatTimer');
    this._clearTimer('wsHeartbeatReplyTimer');
    this.socketGeneration += 1;
    this.socketAuthenticated = false;
    for (const cleanup of this.socketCleanup.splice(0)) {
      try {
        cleanup();
      } catch {
        // Generation guards make stale callbacks harmless.
      }
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Project lifecycle cleanup is independent from socket close errors.
      }
    }
  }

  _clearTimer(name) {
    if (this[name] !== null && this[name] !== undefined) {
      this.clearTimer(this[name]);
      this[name] = null;
    }
  }

  _clearSessionTimers() {
    this._clearTimer('projectHeartbeatTimer');
    this._clearTimer('wsHeartbeatTimer');
    this._clearTimer('wsHeartbeatReplyTimer');
    this._clearTimer('cleanupTimer');
  }

  _clearAllTimers() {
    this._clearSessionTimers();
  }
}

module.exports = {
  OFFICIAL_SESSION_STATES,
  OfficialSessionManager,
  delay,
  randomBetween
};
