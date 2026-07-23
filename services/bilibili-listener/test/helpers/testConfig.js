const crypto = require('node:crypto');
const { loadListenerConfig } = require('../../src/config');
const {
  SYNTHETIC_INSTANCE_ID,
  SYNTHETIC_ROOM_ID,
  SYNTHETIC_SITE_ID
} = require('../../src/syntheticFixtures');

function randomSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function testConfig(overrides = {}) {
  return loadListenerConfig({
    LISTENER_SITE_ID: SYNTHETIC_SITE_ID,
    LISTENER_INSTANCE_ID: SYNTHETIC_INSTANCE_ID,
    LISTENER_ROOM_ID: SYNTHETIC_ROOM_ID,
    LISTENER_BACKEND_URL: 'http://127.0.0.1:5001',
    LIVE_EVENT_INGEST_SECRET: randomSecret()
  }, {
    mode: 'test',
    overrides: {
      connectTimeoutMs: 500,
      heartbeatTimeoutMs: 1000,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
      deliveryMaxAttempts: 3,
      deliveryTimeoutMs: 500,
      deliveryRetryInitialMs: 10,
      deliveryRetryMaxMs: 40,
      queueMaxLength: 4,
      deliveryConcurrency: 1,
      shutdownDrainTimeoutMs: 500,
      ...overrides
    }
  });
}

module.exports = {
  randomSecret,
  testConfig
};
