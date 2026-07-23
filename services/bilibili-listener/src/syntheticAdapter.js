const { assertSourceAdapter } = require('./sourceAdapter');

class SyntheticAdapter {
  constructor({ connectFailures = 0 } = {}) {
    this.connectFailures = connectFailures;
    this.connectCount = 0;
    this.disconnectCount = 0;
    this.pauseCount = 0;
    this.resumeCount = 0;
    this.networkConnections = 0;
    this.connected = false;
    this.paused = false;
    this.handlers = {
      event: null,
      heartbeat: null,
      disconnect: null
    };
    this.handlerHistory = [];
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

  async connect({ signal } = {}) {
    this.connectCount += 1;
    this.handlerHistory.push({ ...this.handlers });
    if (signal?.aborted) {
      const error = new Error('Synthetic connection aborted');
      error.code = 'source_connect_aborted';
      throw error;
    }
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      const error = new Error('Synthetic connection failed');
      error.code = 'synthetic_connect_failure';
      throw error;
    }
    this.connected = true;
  }

  async disconnect() {
    this.disconnectCount += 1;
    this.connected = false;
  }

  async pause() {
    this.pauseCount += 1;
    this.paused = true;
  }

  async resume() {
    this.resumeCount += 1;
    this.paused = false;
  }

  async emitEvent(event) {
    if (typeof this.handlers.event === 'function') {
      return this.handlers.event(event);
    }
    return undefined;
  }

  async emitHeartbeat() {
    if (typeof this.handlers.heartbeat === 'function') {
      return this.handlers.heartbeat();
    }
    return undefined;
  }

  async emitDisconnect(reason = 'synthetic_disconnect') {
    this.connected = false;
    if (typeof this.handlers.disconnect === 'function') {
      return this.handlers.disconnect({ code: reason });
    }
    return undefined;
  }
}

function createSyntheticAdapter(options) {
  return assertSourceAdapter(new SyntheticAdapter(options));
}

module.exports = {
  SyntheticAdapter,
  createSyntheticAdapter
};
