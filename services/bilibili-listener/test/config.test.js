const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadListenerConfig,
  loadListenerServiceConfig,
  NUMERIC_SETTINGS
} = require('../src/config');
const { randomSecret, testConfig } = require('./helpers/testConfig');

test('valid test config resolves explicit env without reading a dotenv file', () => {
  const config = testConfig();
  assert.equal(config.mode, 'test');
  assert.equal(config.eventMode, 'simulation');
  assert.equal(config.backendUrl, 'http://127.0.0.1:5001');
  assert.equal(config.deliveryConcurrency, 1);
  assert.equal(Object.isFrozen(config), true);
});

test('production and test modes require a non-placeholder secret', () => {
  for (const secret of [
    '',
    ' '.repeat(64),
    '\t'.repeat(32),
    'example-placeholder-value',
    'change-this-value-now'
  ]) {
    assert.throws(() => loadListenerConfig({
      LISTENER_SITE_ID: 'phase4e-site',
      LISTENER_INSTANCE_ID: 'phase4e-instance',
      LISTENER_ROOM_ID: '99000000000000000002',
      LISTENER_BACKEND_URL: 'http://localhost:5000',
      LISTENER_DATA_DIR: path.resolve('synthetic-listener-data'),
      LIVE_EVENT_INGEST_SECRET: secret
    }, { mode: 'production' }), { code: 'invalid_ingest_secret' });
  }
  assert.doesNotThrow(() => loadListenerConfig({
    LISTENER_SITE_ID: 'phase4e-site',
    LISTENER_INSTANCE_ID: 'phase4e-instance',
    LISTENER_ROOM_ID: '99000000000000000002',
    LISTENER_BACKEND_URL: 'http://localhost:5000',
    LISTENER_DATA_DIR: path.resolve('synthetic-listener-data'),
    LIVE_EVENT_INGEST_SECRET: randomSecret()
  }, { mode: 'production' }));
});

test('service gates are independent and active mode fails closed when incomplete', () => {
  assert.deepEqual(loadListenerServiceConfig({}), {
    listenerEnabled: false,
    officialApiEnabled: false,
    officialWssEnabled: false,
    officialLiveEnabled: false,
    backendIngestEnabled: false,
    giftAutoCreditEnabled: false
  });
  assert.throws(
    () => loadListenerServiceConfig({
      BILIBILI_LISTENER_ENABLED: 'true'
    }),
    { code: 'listener_feature_gate_incomplete' }
  );
  assert.throws(
    () => loadListenerServiceConfig({
      BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'true'
    }),
    { code: 'gift_auto_credit_not_authorized' }
  );
  assert.doesNotThrow(() => loadListenerServiceConfig({
    BILIBILI_LISTENER_ENABLED: 'true',
    BILIBILI_OFFICIAL_API_ENABLED: 'true',
    BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
    BILI_OFFICIAL_LIVE_ENABLED: 'true',
    LIVE_EVENT_INGEST_ENABLED: 'false'
  }));
});

test('dry-run does not require a secret but still requires an explicit safe target', () => {
  const config = loadListenerConfig({}, {
    mode: 'dry-run',
    overrides: {
      siteId: 'phase4e-site',
      instanceId: 'phase4e-instance',
      roomId: '99000000000000000002',
      backendUrl: 'http://localhost:5000'
    }
  });
  assert.equal(config.secret, '');
  assert.throws(
    () => loadListenerConfig({}, { mode: 'dry-run' }),
    { code: 'invalid_listener_site_id' }
  );
});

test('site, instance, and room identifiers use strict bounded formats', () => {
  assert.throws(
    () => testConfig({ siteId: 'Uppercase-Site' }),
    { code: 'invalid_listener_site_id' }
  );
  assert.throws(
    () => testConfig({ instanceId: '../listener' }),
    { code: 'invalid_listener_instance_id' }
  );
  assert.throws(
    () => testConfig({ roomId: '0' }),
    { code: 'invalid_listener_room_id' }
  );
});

test('every numeric setting enforces its lower and upper bounds', () => {
  for (const [key, definition] of Object.entries(NUMERIC_SETTINGS)) {
    assert.throws(
      () => testConfig({ [key]: definition.min - 1 }),
      { code: 'invalid_numeric_config' },
      `${key} minimum`
    );
    assert.throws(
      () => testConfig({ [key]: definition.max + 1 }),
      { code: 'invalid_numeric_config' },
      `${key} maximum`
    );
  }
});

test('retry maximums cannot be lower than their initial delay', () => {
  assert.throws(
    () => testConfig({ reconnectInitialMs: 200, reconnectMaxMs: 100 }),
    { code: 'invalid_reconnect_range' }
  );
  assert.throws(
    () => testConfig({ deliveryRetryInitialMs: 100, deliveryRetryMaxMs: 50 }),
    { code: 'invalid_delivery_retry_range' }
  );
});

test('config errors expose only stable codes, never environment values', () => {
  const marker = `sensitive-${Date.now()}`;
  let error;
  try {
    loadListenerConfig({
      LISTENER_SITE_ID: marker,
      LISTENER_INSTANCE_ID: marker,
      LISTENER_ROOM_ID: marker,
      LISTENER_BACKEND_URL: marker,
      LIVE_EVENT_INGEST_SECRET: marker
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.doesNotMatch(`${error.message}:${error.code}`, new RegExp(marker));
});

test('passing an empty env object never falls back to process.env', () => {
  const previous = process.env.LISTENER_SITE_ID;
  process.env.LISTENER_SITE_ID = 'phase4e-process-env-must-not-be-read';
  try {
    assert.throws(
      () => loadListenerConfig({}, { mode: 'dry-run' }),
      { code: 'invalid_listener_site_id' }
    );
  } finally {
    if (previous === undefined) delete process.env.LISTENER_SITE_ID;
    else process.env.LISTENER_SITE_ID = previous;
  }
});
