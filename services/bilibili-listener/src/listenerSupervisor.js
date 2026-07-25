const { BoundedEventQueue } = require('./eventQueue');
const { safeErrorCode, listenerError } = require('./errors');
const { mapSourceEvent } = require('./eventMapper');
const { createSafeLogger } = require('./logger');
const { sourceReconnectDelay } = require('./retryPolicy');
const { assertSourceAdapter } = require('./sourceAdapter');
const { ListenerStatus } = require('./status');

class ListenerSupervisor {
  constructor({
    config,
    adapter,
    deliveryClient,
    spool = null,
    mapper = mapSourceEvent,
    logger = createSafeLogger(),
    clock = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    this.config = config;
    this.adapter = assertSourceAdapter(adapter);
    this.deliveryClient = deliveryClient;
    this.spool = spool;
    this.mapper = mapper;
    this.logger = logger;
    this.clock = clock;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.status = new ListenerStatus({ clock });
    this.generation = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectPromise = null;
    this.connectAbortController = null;
    this.connectTimeoutTimer = null;
    this.stopPromise = null;
    this.durableRetryTimers = new Map();
    this.queuedDurableKeys = new Set();
    this.unsubscribers = [];
    this.disconnectHandledGeneration = null;
    this.pausedForBackpressure = false;
    this.deliveryAbortController = new AbortController();
    this.queue = new BoundedEventQueue({
      maxLength: config.queueMaxLength,
      concurrency: config.deliveryConcurrency,
      handler: (item) => this._deliver(item),
      onDepthChange: (depth) => this._handleQueueDepth(depth),
      setTimer,
      clearTimer
    });
  }

  snapshot() {
    return this.status.snapshot(
      this.queue.depth,
      this.spool ? this.spool.snapshot() : null
    );
  }

  async start() {
    if (!['idle', 'stopped'].includes(this.status.state)) {
      throw listenerError('listener_already_started');
    }
    if (this.status.state === 'stopped') {
      this.deliveryAbortController = new AbortController();
      this.stopPromise = null;
    }
    this.status.transition('starting');
    this.queue.start();
    if (this.spool) {
      const pending = this.spool.initialize(
        (event) => this.deliveryClient.prepare(event)
      );
      for (const item of pending) {
        const queued = this._enqueueDurable(item);
        if (!queued.accepted) this._scheduleDurableRetry(item);
      }
    }
    await this._connect();
    return this.snapshot();
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.status.state === 'stopped') {
        return { drained: true, remaining: 0 };
      }
      this.status.transition('stopping');
      this.generation += 1;
      this.status.setGeneration(this.generation);
      this._cancelConnect();
      this._clearReconnectTimer();
      this._clearHeartbeatTimer();
      this._clearDurableRetryTimers();
      this._unbindAdapter();
      this.queue.stopAccepting();
      try {
        await this.adapter.disconnect();
      } catch {
        // Source shutdown continues even if an adapter reports a close error.
      }

      let drainResult = await this.queue.drain(
        this.config.shutdownDrainTimeoutMs
      );
      if (!drainResult.drained) {
        this.deliveryAbortController.abort();
        this.queue.cancelPending('shutdown_timeout');
        drainResult = await this.queue.drain(
          Math.min(1000, this.config.shutdownDrainTimeoutMs)
        );
      } else {
        this.deliveryAbortController.abort();
      }
      this.status.transition('stopped');
      return drainResult;
    })();
    return this.stopPromise;
  }

  waitForIdle(timeoutMs = this.config.shutdownDrainTimeoutMs) {
    return this.queue.drain(timeoutMs);
  }

  async _connect() {
    if (this.connectPromise || ['stopping', 'stopped', 'fatal'].includes(this.status.state)) {
      return this.connectPromise;
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.status.setGeneration(generation);
    this.disconnectHandledGeneration = null;
    this.status.transition('connecting');
    this._bindAdapter(generation);
    const connectAbortController = new AbortController();
    this.connectAbortController = connectAbortController;

    this.connectPromise = (async () => {
      let abortCode = 'source_connect_aborted';
      const aborted = new Promise((resolve, reject) => {
        void resolve;
        connectAbortController.signal.addEventListener('abort', () => {
          reject(listenerError(abortCode));
        }, { once: true });
      });
      try {
        this.connectTimeoutTimer = this.setTimer(() => {
          abortCode = 'source_connect_timeout';
          connectAbortController.abort();
        }, this.config.connectTimeoutMs);
        await Promise.race([
          this.adapter.connect({
            siteId: this.config.siteId,
            roomId: this.config.roomId,
            instanceId: this.config.instanceId,
            signal: connectAbortController.signal
          }),
          aborted
        ]);
        if (
          generation !== this.generation ||
          ['stopping', 'stopped'].includes(this.status.state)
        ) {
          return;
        }
        this.reconnectAttempt = 0;
        this.status.transition('connected');
        this.status.clearDegraded();
        this.status.markConnected();
        this._armHeartbeat(generation);
        this._handleQueueDepth(this.queue.depth);
        this.logger.write('info', 'source_connected', {
          state: this.status.state,
          site_id: this.config.siteId,
          instance_id: this.config.instanceId,
          room_id: this.config.roomId
        });
      } catch (error) {
        if (
          generation === this.generation &&
          !['stopping', 'stopped'].includes(this.status.state)
        ) {
          this._unbindAdapter();
          try {
            await this.adapter.disconnect();
          } catch {
            // A failed connect must still yield to bounded reconnect logic.
          }
          this.logger.write('warn', 'source_connect_failed', {
            state: this.status.state,
            error_code: safeErrorCode(error, 'source_connect_failed')
          });
          this.status.markDegraded(
            safeErrorCode(error, 'source_connect_failed')
          );
          if (error?.fatal === true) {
            this.status.transition('fatal');
            return;
          }
          this._scheduleReconnect(generation);
        }
      } finally {
        if (this.connectTimeoutTimer !== null) {
          this.clearTimer(this.connectTimeoutTimer);
          this.connectTimeoutTimer = null;
        }
        if (this.connectAbortController === connectAbortController) {
          this.connectAbortController = null;
        }
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  _bindAdapter(generation) {
    this._unbindAdapter();
    this.unsubscribers = [
      this.adapter.onEvent((event) => this._handleEvent(event, generation)),
      this.adapter.onHeartbeat(() => this._handleHeartbeat(generation)),
      this.adapter.onDisconnect(() => this._handleDisconnect(generation))
    ].filter((unsubscribe) => typeof unsubscribe === 'function');
  }

  _unbindAdapter() {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A stale callback is also guarded by connection generation.
      }
    }
  }

  async _handleEvent(sourceEvent, generation) {
    if (
      generation !== this.generation ||
      this.status.state !== 'connected'
    ) {
      return { accepted: false, reason: 'stale_source_event' };
    }
    this.status.increment('received');
    let mapped;
    try {
      mapped = this.mapper(sourceEvent, this.config);
    } catch (error) {
      this.status.increment('invalid');
      this.logger.write('warn', 'source_event_invalid', {
        state: this.status.state,
        error_code: safeErrorCode(error, 'invalid_source_event')
      });
      return { accepted: false, reason: 'invalid_source_event' };
    }
    if (mapped.status === 'ignored') {
      this.status.increment('ignored');
      return { accepted: false, reason: mapped.reason };
    }

    this.status.increment('mapped');
    let item;
    try {
      if (this.spool) {
        const persisted = this.spool.persist(
          mapped.event,
          (event) => this.deliveryClient.prepare(event)
        );
        item = persisted.item;
        if (
          persisted.status === 'already_pending' &&
          (
            this.queuedDurableKeys.has(item.key) ||
            this.durableRetryTimers.has(item.key)
          )
        ) {
          return { accepted: true, reason: 'already_pending' };
        }
      } else {
        item = {
          prepared: this.deliveryClient.prepare(mapped.event),
          eventFingerprint: mapped.eventFingerprint
        };
      }
    } catch (error) {
      const reason = safeErrorCode(error, 'invalid_event_schema');
      if (['spool_full', 'spool_disk_full', 'spool_write_failed'].includes(reason)) {
        this.status.increment('queue_rejected');
        this.status.markDegraded(reason);
        await this._applyBackpressure();
      } else {
        this.status.increment('invalid');
      }
      return {
        accepted: false,
        reason
      };
    }
    const queued = this.spool
      ? this._enqueueDurable(item)
      : this.queue.enqueue(item);
    if (!queued.accepted) {
      this.status.increment('queue_rejected');
      await this._applyBackpressure();
      this.logger.write('warn', 'queue_rejected', {
        state: this.status.state,
        event_type: item.prepared.eventType,
        event_fingerprint: mapped.eventFingerprint,
        queue_depth: this.queue.depth,
        result: queued.reason
      });
      if (this.spool) this._scheduleDurableRetry(item);
    }
    return queued;
  }

  async _deliver(item) {
    let result;
    try {
      result = await this.deliveryClient.deliverPrepared(item.prepared, {
        signal: this.deliveryAbortController.signal,
        onRetry: ({ attempt, reason, eventType }) => {
          this.status.increment('retried');
          this.logger.write('warn', 'delivery_retry', {
            state: this.status.state,
            event_type: eventType,
            event_fingerprint: item.eventFingerprint,
            retry_attempt: attempt,
            result: reason
          });
        }
      });
    } catch (error) {
      result = {
        outcome: 'failed',
        reason: safeErrorCode(error, 'delivery_error')
      };
    }
    if (result.outcome === 'accepted' || result.outcome === 'duplicate') {
      this.status.increment(result.outcome);
      this.status.markDeliverySuccess();
      if (this.spool) {
        try {
          this.spool.acknowledge(item);
          this.status.clearDegraded();
        } catch (error) {
          this.status.markDegraded(
            safeErrorCode(error, 'spool_ack_failed')
          );
        }
      }
    } else if (result.outcome === 'conflict') {
      this.status.increment('conflict');
      this._quarantineDurable(item, 'event_id_conflict');
    } else if (
      result.outcome === 'permanent_rejection' ||
      result.outcome === 'permanent_failure'
    ) {
      this.status.increment('failed');
      this._quarantineDurable(item, result.reason);
    } else if (result.outcome === 'authentication_failed') {
      this.status.increment('failed');
      this.status.markDegraded('ingest_authentication_failed');
    } else if (result.outcome === 'ingest_disabled') {
      this.status.increment('failed');
      this.status.markDegraded('ingest_disabled');
      this._scheduleDurableRetry(
        item,
        this.config.ingestDisabledRetryMs
      );
    } else {
      this.status.increment('failed');
      this.status.markDegraded(result.reason || 'delivery_failed');
      this._scheduleDurableRetry(item);
    }
    this.logger.write(
      result.outcome === 'failed' ? 'error' : 'info',
      'delivery_result',
      {
        state: this.status.state,
        event_type: item.prepared.eventType,
        event_fingerprint: item.eventFingerprint,
        result: result.outcome
      }
    );
    return result;
  }

  _enqueueDurable(item) {
    if (this.queuedDurableKeys.has(item.key)) {
      return { accepted: true, reason: 'already_queued' };
    }
    const queued = this.queue.enqueue(item);
    if (!queued.accepted) return queued;
    this.queuedDurableKeys.add(item.key);
    queued.completion.finally(() => {
      this.queuedDurableKeys.delete(item.key);
    });
    return queued;
  }

  _scheduleDurableRetry(
    item,
    delay = this.config.durableRetryDelayMs
  ) {
    if (
      !this.spool ||
      this.durableRetryTimers.has(item.key) ||
      ['stopping', 'stopped'].includes(this.status.state)
    ) {
      return;
    }
    const timer = this.setTimer(() => {
      this.durableRetryTimers.delete(item.key);
      if (['stopping', 'stopped'].includes(this.status.state)) return;
      const queued = this._enqueueDurable(item);
      if (!queued.accepted) this._scheduleDurableRetry(item, delay);
    }, delay);
    this.durableRetryTimers.set(item.key, timer);
  }

  _clearDurableRetryTimers() {
    for (const timer of this.durableRetryTimers.values()) {
      this.clearTimer(timer);
    }
    this.durableRetryTimers.clear();
  }

  _quarantineDurable(item, reason) {
    if (!this.spool) return;
    try {
      this.spool.quarantine(item, reason);
    } catch (error) {
      this.status.markDegraded(
        safeErrorCode(error, 'spool_quarantine_failed')
      );
    }
  }

  _handleHeartbeat(generation) {
    if (generation !== this.generation || this.status.state !== 'connected') return;
    this._armHeartbeat(generation);
  }

  async _handleDisconnect(generation) {
    if (
      generation !== this.generation ||
      this.disconnectHandledGeneration === generation ||
      ['stopping', 'stopped'].includes(this.status.state)
    ) {
      return;
    }
    this.disconnectHandledGeneration = generation;
    this._clearHeartbeatTimer();
    try {
      await this.adapter.disconnect();
    } catch {
      // Reconnect scheduling does not depend on a clean source close.
    }
    this._scheduleReconnect(generation);
  }

  _armHeartbeat(generation) {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      if (generation === this.generation && this.status.state === 'connected') {
        this._handleDisconnect(generation);
      }
    }, this.config.heartbeatTimeoutMs);
  }

  _scheduleReconnect(generation) {
    if (
      this.reconnectTimer ||
      generation !== this.generation ||
      ['stopping', 'stopped', 'fatal'].includes(this.status.state)
    ) {
      return;
    }
    this.status.transition('backing_off');
    const delay = sourceReconnectDelay({
      attempt: this.reconnectAttempt,
      initialMs: this.config.reconnectInitialMs,
      maxMs: this.config.reconnectMaxMs,
      random: this.random
    });
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (
        generation !== this.generation ||
        ['stopping', 'stopped'].includes(this.status.state)
      ) {
        return;
      }
      this.status.increment('reconnect_count');
      this._connect();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _cancelConnect() {
    if (this.connectTimeoutTimer !== null) {
      this.clearTimer(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.connectAbortController && !this.connectAbortController.signal.aborted) {
      this.connectAbortController.abort();
    }
  }

  _clearHeartbeatTimer() {
    if (this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _applyBackpressure() {
    if (this.pausedForBackpressure || typeof this.adapter.pause !== 'function') return;
    this.pausedForBackpressure = true;
    try {
      await this.adapter.pause();
    } catch {
      // Rejection remains explicit even if the source cannot pause.
    }
  }

  _handleQueueDepth(depth) {
    if (
      this.status.state !== 'connected' ||
      !this.pausedForBackpressure ||
      depth >= this.config.queueMaxLength ||
      typeof this.adapter.resume !== 'function'
    ) {
      return;
    }
    this.pausedForBackpressure = false;
    Promise.resolve(this.adapter.resume()).catch(() => {});
  }
}

module.exports = {
  ListenerSupervisor
};
