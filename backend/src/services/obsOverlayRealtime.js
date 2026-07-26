const { EventEmitter } = require('node:events');

function createObsOverlayRealtime() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let revision = 0;

  return {
    getRevision() {
      return revision;
    },

    publish(reason = 'state_changed') {
      revision += 1;
      const update = {
        revision,
        reason,
        occurredAt: new Date().toISOString()
      };
      emitter.emit('update', update);
      return update;
    },

    subscribe(listener) {
      emitter.on('update', listener);
      return () => emitter.off('update', listener);
    }
  };
}

const defaultObsOverlayRealtime = createObsOverlayRealtime();

module.exports = {
  createObsOverlayRealtime,
  defaultObsOverlayRealtime
};
