const { listenerError, safeErrorCode } = require('./errors');
const {
  OPERATIONS,
  createAuthPacket,
  createHeartbeatPacket,
  parseJsonBody,
  parsePackets,
  toBuffer
} = require('./officialProtocol');
const { translateOfficialCommand } = require('./officialEventTranslator');
const {
  getOfficialWssAuthBody,
  revalidateOfficialWssLink,
  validateOfficialWssLinks
} = require('./officialWssUrl');

function addSocketListener(socket, name, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(name, handler);
    return () => socket.removeEventListener(name, handler);
  }
  if (typeof socket.on === 'function') {
    socket.on(name, handler);
    return () => {
      if (typeof socket.off === 'function') socket.off(name, handler);
      else if (typeof socket.removeListener === 'function') {
        socket.removeListener(name, handler);
      }
    };
  }
  throw listenerError('invalid_websocket_implementation');
}

function fatalListenerError(code) {
  const error = listenerError(code);
  error.fatal = true;
  return error;
}

async function socketDataToBuffer(data) {
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return toBuffer(data);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  throw listenerError('invalid_official_proto_frame');
}

class OfficialBilibiliAdapter {
  constructor({
    config,
    apiClient,
    webSocketFactory,
    logger,
    translator = translateOfficialCommand,
    lookup,
    clock = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    if (typeof webSocketFactory !== 'function') {
      throw listenerError('production_websocket_unavailable');
    }
    this.config = config;
    this.apiClient = apiClient;
    this.webSocketFactory = webSocketFactory;
    this.logger = logger || { write() {} };
    this.translator = translator;
    this.lookup = lookup;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = 'idle';
    this.generation = 0;
    this.connectPromise = null;
    this.disconnectPromise = null;
    this.connectionController = null;
    this.session = null;
    this.sessionEnded = true;
    this.socket = null;
    this.socketCleanup = [];
    this.authWaiter = null;
    this.apiHeartbeatTimer = null;
    this.wsHeartbeatTimer = null;
    this.wsHeartbeatReplyTimer = null;
    this.messageChain = Promise.resolve();
    this.disconnectNotifiedGeneration = null;
    this.websocketAuthenticated = false;
    this.lastApiHeartbeatSuccessAt = null;
    this.lastWsHeartbeatReplyAt = null;
    this.lastPacketAt = null;
    this.apiHeartbeatFailures = 0;
    this.handlers = {
      event: null,
      heartbeat: null,
      disconnect: null
    };
    this.counters = {
      wss_link_attempts: 0,
      api_heartbeat_success: 0,
      api_heartbeat_failure: 0,
      ws_heartbeat_sent: 0,
      ws_heartbeat_reply: 0,
      events_emitted: 0,
      ignored: 0,
      invalid: 0,
      disconnect_notifications: 0,
      end_attempts: 0
    };
  }

  onEvent(handler) {
    this.handlers.event = handler;
    return () => {
      if (this.handlers.event === handler) this.handlers.event = null;
    };
  }

  onHeartbeat(handler) {
    this.handlers.heartbeat = handler;
    return () => {
      if (this.handlers.heartbeat === handler) this.handlers.heartbeat = null;
    };
  }

  onDisconnect(handler) {
    this.handlers.disconnect = handler;
    return () => {
      if (this.handlers.disconnect === handler) this.handlers.disconnect = null;
    };
  }

  snapshot() {
    return Object.freeze({
      source_state: this.state,
      source_generation: this.generation,
      session_active: Boolean(this.session && !this.sessionEnded),
      websocket_connected: Boolean(this.socket && this.state === 'connected'),
      websocket_authenticated: this.websocketAuthenticated,
      last_rest_heartbeat_success_at: this.lastApiHeartbeatSuccessAt,
      last_wss_heartbeat_reply_at: this.lastWsHeartbeatReplyAt,
      last_packet_at: this.lastPacketAt,
      ...this.counters
    });
  }

  async connect({ roomId, signal } = {}) {
    if (roomId !== this.config.roomId) throw listenerError('source_target_mismatch');
    if (this.connectPromise) return this.connectPromise;
    if (this.state === 'connected') return;
    if (this.state === 'stopping') throw listenerError('source_connect_aborted');

    const generation = this.generation + 1;
    this.generation = generation;
    this.disconnectNotifiedGeneration = null;
    this.websocketAuthenticated = false;
    this.apiHeartbeatFailures = 0;
    this.lastApiHeartbeatSuccessAt = null;
    this.lastWsHeartbeatReplyAt = null;
    this.state = 'app_starting';
    const controller = new AbortController();
    this.connectionController = controller;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    this.connectPromise = (async () => {
      try {
        const startedSession = await this.apiClient.start({
          signal: controller.signal
        });
        this.session = startedSession;
        this.sessionEnded = false;
        this.state = 'app_started';
        if (startedSession.roomId !== this.config.roomId) {
          throw fatalListenerError('official_room_mismatch');
        }
        const validatedLinks = await validateOfficialWssLinks(
          startedSession.wssTrust,
          { lookup: this.lookup }
        );
        const session = Object.freeze({
          ...startedSession,
          wssLinks: validatedLinks
        });
        if (controller.signal.aborted || generation !== this.generation) {
          await this._endSpecificSession(session.gameId);
          this.sessionEnded = true;
          this.session = null;
          throw listenerError('source_connect_aborted');
        }
        this.session = session;
        this.logger.write('info', 'official_session_started', {
          state: this.state,
          room_id: this.config.roomId,
          result: 'started'
        });
        this.state = 'wss_connecting';
        let lastError = listenerError('official_wss_connect_failed');
        for (const link of session.wssLinks) {
          if (controller.signal.aborted || generation !== this.generation) {
            throw listenerError('source_connect_aborted');
          }
          try {
            await this._connectSocket(
              link,
              generation,
              controller.signal,
              session.wssTrust
            );
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            this.logger.write('warn', 'official_wss_link_failed', {
              state: this.state,
              error_code: safeErrorCode(error, 'official_wss_connect_failed'),
              retry_attempt: this.counters.wss_link_attempts
            });
            this._disposeSocket({ close: true });
          }
        }
        if (lastError) throw lastError;
        this.state = 'connected';
        this._scheduleApiHeartbeat(generation);
        this._scheduleWsHeartbeat(generation);
      } catch (error) {
        this.state = 'idle';
        this._cancelHeartbeatTimers();
        this._disposeSocket({ close: true });
        await this._endCurrentSession();
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (
          this.connectionController === controller &&
          this.state !== 'connected'
        ) {
          this.connectionController = null;
        }
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  async disconnect() {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = (async () => {
      const pendingConnect = this.connectPromise;
      this.state = 'stopping';
      this.generation += 1;
      this.websocketAuthenticated = false;
      this.connectionController?.abort();
      this._cancelHeartbeatTimers();
      this._rejectAuth('source_connect_aborted');
      this._disposeSocket({ close: true });
      await pendingConnect?.catch(() => {});
      await this._endCurrentSession();
      await this.messageChain.catch(() => {});
      this.connectionController = null;
      this.state = 'stopped';
    })();
    try {
      await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
    }
  }

  async _connectSocket(link, generation, signal, wssTrust) {
    const revalidatedLink = await revalidateOfficialWssLink(
      wssTrust,
      link,
      { lookup: this.lookup }
    );
    this.counters.wss_link_attempts += 1;
    const socket = this.webSocketFactory(revalidatedLink.href);
    if (!socket || typeof socket.send !== 'function' || typeof socket.close !== 'function') {
      throw listenerError('invalid_websocket_implementation');
    }
    this.socket = socket;
    this.state = 'authenticating';
    try {
      socket.binaryType = 'arraybuffer';
    } catch {
      // A compliant injected transport may expose a read-only binaryType.
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(authTimer);
        signal.removeEventListener('abort', onAbort);
        this.authWaiter = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(listenerError('source_connect_aborted'));
      const authTimer = this.setTimer(() => {
        finish(listenerError('official_auth_timeout'));
      }, this.config.authTimeoutMs);
      this.authWaiter = {
        resolve: () => finish(),
        reject: (code) => finish(
          code === 'official_auth_rejected'
            ? fatalListenerError(code)
            : listenerError(code)
        )
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const onOpen = () => {
        if (generation !== this.generation || signal.aborted) {
          finish(listenerError('source_connect_aborted'));
          return;
        }
        try {
          socket.send(createAuthPacket(
            getOfficialWssAuthBody(wssTrust, revalidatedLink)
          ));
        } catch {
          finish(listenerError('official_auth_send_failed'));
        }
      };
      const onMessage = (event) => {
        const data = event?.data ?? event;
        this.messageChain = this.messageChain
          .then(() => this._handleSocketData(data, generation))
          .catch(() => {
            if (this.state === 'authenticating') {
              this._rejectAuth('official_protocol_error');
              return;
            }
            this._signalDisconnect(generation, 'official_protocol_error');
          });
      };
      const onError = () => {
        if (this.state === 'authenticating') {
          finish(listenerError('official_wss_connect_failed'));
        } else {
          this._signalDisconnect(generation, 'official_wss_error');
        }
      };
      const onClose = (event) => {
        if (this.state === 'authenticating') {
          finish(listenerError('official_wss_closed_before_auth'));
        } else {
          this._signalDisconnect(
            generation,
            event?.code === 1000
              ? 'official_wss_closed_normal'
              : 'official_wss_closed_abnormal'
          );
        }
      };
      this.socketCleanup = [
        addSocketListener(socket, 'open', onOpen),
        addSocketListener(socket, 'message', onMessage),
        addSocketListener(socket, 'error', onError),
        addSocketListener(socket, 'close', onClose)
      ];
    });
  }

  async _handleSocketData(data, generation) {
    if (generation !== this.generation || ['stopping', 'stopped'].includes(this.state)) {
      return;
    }
    this.lastPacketAt = new Date(this.clock()).toISOString();
    const packets = parsePackets(await socketDataToBuffer(data));
    for (const packet of packets) {
      if (packet.operation === OPERATIONS.AUTH_REPLY) {
        const reply = parseJsonBody(packet.body);
        if (reply.code !== 0) {
          this._rejectAuth('official_auth_rejected');
          continue;
        }
        this.websocketAuthenticated = true;
        this.state = 'authenticated';
        this.authWaiter?.resolve();
        continue;
      }
      if (packet.operation === OPERATIONS.HEARTBEAT_REPLY) {
        this.counters.ws_heartbeat_reply += 1;
        this.lastWsHeartbeatReplyAt = new Date(this.clock()).toISOString();
        this._clearTimer('wsHeartbeatReplyTimer');
        this._emitHeartbeat();
        continue;
      }
      if (
        packet.operation !== OPERATIONS.MESSAGE ||
        !['authenticated', 'connected'].includes(this.state)
      ) {
        continue;
      }
      const message = parseJsonBody(packet.body);
      if (message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END') {
        const responseGameId = message.data?.game_id;
        if (
          responseGameId !== undefined &&
          responseGameId !== this.session?.gameId
        ) {
          this.counters.invalid += 1;
          continue;
        }
        this._signalDisconnect(generation, 'official_interaction_end');
        return;
      }
      let translated;
      try {
        translated = this.translator(message, {
          roomId: this.config.roomId,
          gameId: this.session.gameId
        });
      } catch (error) {
        this.counters.invalid += 1;
        this.logger.write('warn', 'official_event_invalid', {
          state: this.state,
          room_id: this.config.roomId,
          error_code: safeErrorCode(error, 'invalid_official_event'),
          result: 'invalid'
        });
        continue;
      }
      if (translated.status === 'ignored') {
        this.counters.ignored += 1;
        this.logger.write('info', 'official_event_ignored', {
          state: this.state,
          room_id: this.config.roomId,
          result: translated.reason
        });
        continue;
      }
      this.counters.events_emitted += 1;
      if (typeof this.handlers.event === 'function') {
        await Promise.resolve(this.handlers.event(translated.sourceEvent)).catch(() => {});
      }
    }
  }

  _scheduleApiHeartbeat(
    generation,
    delayMs = this.config.apiHeartbeatIntervalMs
  ) {
    if (generation !== this.generation || this.state !== 'connected') return;
    this.apiHeartbeatTimer = this.setTimer(async () => {
      this.apiHeartbeatTimer = null;
      if (generation !== this.generation || this.state !== 'connected') return;
      const startedAt = this.clock();
      try {
        await this.apiClient.heartbeat(this.session.gameId, {
          signal: this.connectionController?.signal
        });
        if (generation !== this.generation || this.state !== 'connected') return;
        this.counters.api_heartbeat_success += 1;
        this.apiHeartbeatFailures = 0;
        this.lastApiHeartbeatSuccessAt = new Date(this.clock()).toISOString();
        this._emitHeartbeat();
      } catch (error) {
        if (generation !== this.generation || this.state !== 'connected') return;
        this.counters.api_heartbeat_failure += 1;
        this.apiHeartbeatFailures = (this.apiHeartbeatFailures || 0) + 1;
        if (
          this.apiHeartbeatFailures >=
          this.config.apiHeartbeatFailureThreshold
        ) {
          this._signalDisconnect(
            generation,
            safeErrorCode(error, 'official_api_heartbeat_failed')
          );
          return;
        }
      }
      const elapsed = Math.max(0, this.clock() - startedAt);
      this._scheduleApiHeartbeat(
        generation,
        Math.max(0, this.config.apiHeartbeatIntervalMs - elapsed)
      );
    }, delayMs);
  }

  _scheduleWsHeartbeat(generation) {
    if (generation !== this.generation || this.state !== 'connected') return;
    this.wsHeartbeatTimer = this.setTimer(() => {
      this.wsHeartbeatTimer = null;
      if (generation !== this.generation || this.state !== 'connected') return;
      try {
        this.socket.send(createHeartbeatPacket());
        this.counters.ws_heartbeat_sent += 1;
      } catch {
        this._signalDisconnect(generation, 'official_ws_heartbeat_failed');
        return;
      }
      if (this.wsHeartbeatReplyTimer === null) {
        this.wsHeartbeatReplyTimer = this.setTimer(() => {
          this.wsHeartbeatReplyTimer = null;
          this._signalDisconnect(generation, 'official_ws_heartbeat_timeout');
        }, this.config.wsHeartbeatTimeoutMs);
      }
      this._scheduleWsHeartbeat(generation);
    }, this.config.wsHeartbeatIntervalMs);
  }

  _emitHeartbeat() {
    if (typeof this.handlers.heartbeat === 'function') {
      Promise.resolve(this.handlers.heartbeat()).catch(() => {});
    }
  }

  _signalDisconnect(generation, reason) {
    if (
      generation !== this.generation ||
      this.disconnectNotifiedGeneration === generation ||
      ['stopping', 'stopped'].includes(this.state)
    ) {
      return;
    }
    this.disconnectNotifiedGeneration = generation;
    this.websocketAuthenticated = false;
    this.counters.disconnect_notifications += 1;
    this._cancelHeartbeatTimers();
    this.logger.write('warn', 'official_source_disconnected', {
      state: this.state,
      room_id: this.config.roomId,
      result: reason
    });
    if (typeof this.handlers.disconnect === 'function') {
      Promise.resolve(this.handlers.disconnect({ code: reason })).catch(() => {});
    }
  }

  _rejectAuth(code) {
    this.authWaiter?.reject(code);
  }

  _disposeSocket({ close }) {
    for (const cleanup of this.socketCleanup.splice(0)) {
      try {
        cleanup();
      } catch {
        // Generation guards make stale callbacks harmless.
      }
    }
    const socket = this.socket;
    this.socket = null;
    this.websocketAuthenticated = false;
    if (close && socket) {
      try {
        socket.close();
      } catch {
        // Session cleanup still calls the official end endpoint.
      }
    }
  }

  _clearTimer(name) {
    if (this[name] !== null) {
      this.clearTimer(this[name]);
      this[name] = null;
    }
  }

  _cancelHeartbeatTimers() {
    this._clearTimer('apiHeartbeatTimer');
    this._clearTimer('wsHeartbeatTimer');
    this._clearTimer('wsHeartbeatReplyTimer');
  }

  async _endSpecificSession(gameId) {
    this.counters.end_attempts += 1;
    const controller = new AbortController();
    const timeout = this.setTimer(
      () => controller.abort(),
      this.config.endTimeoutMs
    );
    try {
      await this.apiClient.end(gameId, { signal: controller.signal });
    } catch {
      // Official end is best-effort during teardown and never exposes details.
    } finally {
      this.clearTimer(timeout);
    }
  }

  async _endCurrentSession() {
    if (!this.session || this.sessionEnded) return;
    const { gameId } = this.session;
    this.sessionEnded = true;
    this.session = null;
    await this._endSpecificSession(gameId);
  }
}

module.exports = {
  OfficialBilibiliAdapter,
  addSocketListener,
  fatalListenerError,
  socketDataToBuffer
};
