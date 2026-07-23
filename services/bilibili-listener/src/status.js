const COUNTER_NAMES = Object.freeze([
  'received',
  'mapped',
  'ignored',
  'invalid',
  'accepted',
  'duplicate',
  'conflict',
  'retried',
  'failed',
  'queue_rejected',
  'reconnect_count'
]);

class ListenerStatus {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.startedAtMs = clock();
    this.state = 'idle';
    this.connectionGeneration = 0;
    this.lastConnectedAt = null;
    this.lastDeliverySuccessAt = null;
    this.counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  }

  transition(state) {
    this.state = state;
  }

  setGeneration(value) {
    this.connectionGeneration = value;
  }

  markConnected() {
    this.lastConnectedAt = new Date(this.clock()).toISOString();
  }

  markDeliverySuccess() {
    this.lastDeliverySuccessAt = new Date(this.clock()).toISOString();
  }

  increment(name, amount = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.counters, name)) return;
    this.counters[name] += amount;
  }

  snapshot(queueDepth = 0) {
    return Object.freeze({
      state: this.state,
      uptime_ms: Math.max(0, this.clock() - this.startedAtMs),
      connection_generation: this.connectionGeneration,
      queue_depth: queueDepth,
      ...this.counters,
      last_connected_at: this.lastConnectedAt,
      last_delivery_success_at: this.lastDeliverySuccessAt
    });
  }
}

module.exports = {
  COUNTER_NAMES,
  ListenerStatus
};
