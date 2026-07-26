const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createServiceRuntime
} = require('../src/serviceRuntime');
const {
  createProductionAdapter
} = require('../src/sourceAdapter');
const {
  readHealthSnapshot
} = require('../src/healthStatus');
const { withNetworkGuard } = require('./helpers/networkGuard');

test('manual production adapter construction remains unavailable', () => {
  assert.throws(
    () => createProductionAdapter({
      source: 'bilibili-official',
      url: 'wss://manual.example.net/sub'
    }),
    { code: 'production_adapter_requires_runtime_factory' }
  );
});

test('disabled service stays healthy without credentials or network access', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-disabled-')
  );
  let runtimeFactoryCalls = 0;
  let statusReporterFactoryCalls = 0;
  let lockReleases = 0;
  try {
    await withNetworkGuard(async (networkCalls) => {
      const service = createServiceRuntime({
        env: {
          LISTENER_DATA_DIR: dataDir,
          BILIBILI_LISTENER_ENABLED: 'false'
        },
        runtimeFactory() {
          runtimeFactoryCalls += 1;
          throw new Error('active runtime must not be created');
        },
        statusReporterFactory() {
          statusReporterFactoryCalls += 1;
          throw new Error('status reporter must not be created');
        },
        async lockFactory() {
          return {
            async release() {
              lockReleases += 1;
            }
          };
        },
        setTimer() {
          return 1;
        },
        clearTimer() {}
      });
      const started = await service.start();
      assert.equal(started.state, 'disabled');
      assert.equal(started.healthy, true);
      assert.equal(readHealthSnapshot(dataDir).state, 'disabled');
      await service.stop();
      assert.deepEqual(networkCalls, []);
    });
    assert.equal(runtimeFactoryCalls, 0);
    assert.equal(statusReporterFactoryCalls, 0);
    assert.equal(lockReleases, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('enabled service reports its allowlisted transport snapshot without blocking health', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-status-reporting-')
  );
  const reports = [];
  let reporterFactoryCalls = 0;
  try {
    const service = createServiceRuntime({
      env: {
        LISTENER_DATA_DIR: dataDir,
        BILIBILI_LISTENER_ENABLED: 'true',
        BILIBILI_OFFICIAL_API_ENABLED: 'true',
        BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
        LIVE_EVENT_INGEST_ENABLED: 'true',
        BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'false'
      },
      async lockFactory() {
        return { async release() {} };
      },
      statusReporterFactory() {
        reporterFactoryCalls += 1;
        return {
          async report(value) {
            reports.push(value);
            return { outcome: 'accepted' };
          }
        };
      },
      runtimeFactory() {
        return {
          async start() {},
          async stop() {},
          snapshot() {
            return {
              state: 'connected',
              degraded: false,
              source: {
                source_state: 'connected',
                websocket_authenticated: true
              }
            };
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    const started = await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.state, 'healthy');
    assert.equal(reporterFactoryCalls, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].state, 'healthy');
    assert.equal(reports[0].runtime.source.websocket_authenticated, true);
    await service.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('status reporting failures never escape into the service health lifecycle', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-status-failure-')
  );
  try {
    const service = createServiceRuntime({
      env: {
        LISTENER_DATA_DIR: dataDir,
        BILIBILI_LISTENER_ENABLED: 'true',
        BILIBILI_OFFICIAL_API_ENABLED: 'true',
        BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
        LIVE_EVENT_INGEST_ENABLED: 'true',
        BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'false'
      },
      async lockFactory() {
        return { async release() {} };
      },
      statusReporterFactory() {
        return {
          report() {
            throw new Error('synthetic status delivery failure');
          }
        };
      },
      runtimeFactory() {
        return {
          async start() {},
          async stop() {},
          snapshot() {
            return {
              state: 'connected',
              degraded: false,
              source: {
                source_state: 'connected',
                websocket_authenticated: true
              }
            };
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    assert.equal((await service.start()).state, 'healthy');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.snapshot().state, 'healthy');
    await service.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid service gates stay alive as an unhealthy configuration error', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-configuration-error-')
  );
  let lockReleases = 0;
  try {
    const service = createServiceRuntime({
      env: {
        LISTENER_DATA_DIR: dataDir,
        BILIBILI_LISTENER_ENABLED: 'not-a-boolean'
      },
      async lockFactory() {
        return {
          async release() {
            lockReleases += 1;
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    const started = await service.start();
    assert.equal(started.state, 'configuration_error');
    assert.equal(started.healthy, false);
    const rawHealth = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'health.json'),
      'utf8'
    ));
    assert.equal(rawHealth.state, 'configuration_error');
    assert.equal(rawHealth.healthy, false);
    assert.throws(
      () => readHealthSnapshot(dataDir),
      { code: 'listener_unhealthy' }
    );
    await service.stop();
    assert.equal(lockReleases, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('service releases its instance lock when runtime shutdown fails', async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-stop-failure-')
  );
  let lockReleases = 0;
  try {
    const service = createServiceRuntime({
      env: {
        LISTENER_DATA_DIR: dataDir,
        BILIBILI_LISTENER_ENABLED: 'true',
        BILIBILI_OFFICIAL_API_ENABLED: 'true',
        BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
        LIVE_EVENT_INGEST_ENABLED: 'true',
        BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'false'
      },
      async lockFactory() {
        return {
          async release() {
            lockReleases += 1;
          }
        };
      },
      runtimeFactory() {
        return {
          async start() {},
          async stop() {
            const error = new Error('synthetic shutdown failure');
            error.code = 'synthetic_stop_failure';
            throw error;
          },
          snapshot() {
            return {
              state: 'connected',
              degraded: false,
              source: {
                source_state: 'connected',
                websocket_authenticated: true
              }
            };
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    await service.start();
    await assert.rejects(
      () => service.stop(),
      { code: 'synthetic_stop_failure' }
    );
    assert.equal(lockReleases, 1);
    assert.equal(service.snapshot().state, 'stopped');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('service health distinguishes authenticated, degraded, and expired states', async () => {
  const serviceEnv = (dataDir) => ({
    LISTENER_DATA_DIR: dataDir,
    BILIBILI_LISTENER_ENABLED: 'true',
    BILIBILI_OFFICIAL_API_ENABLED: 'true',
    BILIBILI_OFFICIAL_WSS_ENABLED: 'true',
    LIVE_EVENT_INGEST_ENABLED: 'true',
    BILIBILI_GIFT_AUTO_CREDIT_ENABLED: 'false'
  });
  const lockFactory = async () => ({ async release() {} });

  const healthyDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-healthy-')
  );
  try {
    let degraded = false;
    const service = createServiceRuntime({
      env: serviceEnv(healthyDir),
      lockFactory,
      runtimeFactory() {
        return {
          async start() {},
          async stop() {},
          snapshot() {
            return {
              state: 'connected',
              degraded,
              degraded_reason: degraded ? 'ingest_disabled' : null,
              source: {
                source_state: 'connected',
                websocket_authenticated: true
              }
            };
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    assert.equal((await service.start()).state, 'healthy');
    degraded = true;
    assert.equal(service.snapshot().state, 'degraded');
    assert.equal(service.snapshot().healthy, false);
    await service.stop();
  } finally {
    fs.rmSync(healthyDir, { recursive: true, force: true });
  }

  const expiredDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'listener-expired-')
  );
  try {
    const service = createServiceRuntime({
      env: serviceEnv(expiredDir),
      lockFactory,
      runtimeFactory() {
        return {
          async start() {
            const error = new Error('synthetic expired credential');
            error.code = 'official_identity_code_error';
            throw error;
          },
          async stop() {},
          snapshot() {
            return { state: 'fatal' };
          }
        };
      },
      setTimer() {
        return 1;
      },
      clearTimer() {}
    });
    const started = await service.start();
    assert.equal(started.state, 'credentials_expired');
    assert.equal(started.healthy, false);
    await service.stop();
  } finally {
    fs.rmSync(expiredDir, { recursive: true, force: true });
  }
});
