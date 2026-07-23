const { listenerError } = require('./errors');

const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'connect',
  'disconnect',
  'onEvent',
  'onHeartbeat',
  'onDisconnect'
]);

function assertSourceAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw listenerError('invalid_source_adapter');
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw listenerError('invalid_source_adapter');
    }
  }
  for (const optional of ['pause', 'resume']) {
    if (adapter[optional] !== undefined && typeof adapter[optional] !== 'function') {
      throw listenerError('invalid_source_adapter');
    }
  }
  return adapter;
}

function createProductionAdapter() {
  throw listenerError('bilibili_adapter_not_implemented');
}

module.exports = {
  REQUIRED_ADAPTER_METHODS,
  assertSourceAdapter,
  createProductionAdapter
};
