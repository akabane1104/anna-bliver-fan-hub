const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROVIDER_NAME,
  createConfiguredIdentityProvider,
  createGuardTabTopListProvider
} = require('../src/services/bilibiliGuardTabTopListProvider');

const TARGET = Object.freeze({ anchorUid: '90001', roomId: '80001' });

function entry(uid, guardLevel, overrides = {}) {
  return {
    uid: String(uid),
    guard_level: guardLevel,
    username: `Synthetic ${uid}`,
    medal_info: {
      target_id: TARGET.anchorUid,
      anchor_roomid: TARGET.roomId,
      medal_level: 12,
      medal_name: '测试勋章',
      ...overrides.medal_info
    },
    ...overrides
  };
}

function page({
  num,
  pages,
  now,
  list = [],
  top3 = [],
  status = 200,
  headers = {},
  code = 0
}) {
  return {
    status,
    headers,
    data: {
      code,
      data: {
        info: { num, page: pages, now },
        list,
        top3
      }
    }
  };
}

function createScriptedHttp(pages) {
  const calls = [];
  const httpGet = async (url, options) => {
    calls.push({ url, options });
    const requested = Number(options.params.page);
    const response = typeof pages === 'function'
      ? await pages(requested, calls.length)
      : pages[requested];
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`missing synthetic page ${requested}`);
    return response;
  };
  return { calls, httpGet };
}

function createProvider(httpGet, options = {}) {
  let now = new Date('2026-07-27T00:00:00.000Z');
  return createGuardTabTopListProvider({
    target: TARGET,
    httpGet,
    clock: options.clock || (() => now),
    sleep: options.sleep || (async () => {}),
    random: options.random || (() => 0),
    logger: options.logger || { info() {}, warn() {} },
    config: {
      pageSize: 1,
      maxPages: 50,
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseMs: 10,
      maxRetryAfterMs: 10_000,
      cacheMs: 60_000,
      confirmationDelayMs: 10,
      ...options.config
    }
  });
}

test('provider remains fail closed unless explicitly selected', async () => {
  let calls = 0;
  const provider = createConfiguredIdentityProvider({
    env: {
      VIEWER_IDENTITY_TARGET_ANCHOR_UID: TARGET.anchorUid,
      VIEWER_IDENTITY_TARGET_ROOM_ID: TARGET.roomId
    },
    httpGet: async () => {
      calls += 1;
    }
  });
  assert.equal(provider.name, 'unavailable');
  assert.deepEqual(await provider.resolveIdentity(), {
    status: 'unavailable',
    error_code: 'identity_source_not_configured',
    retryable: true
  });
  assert.equal(calls, 0);
});

test('explicit provider reads all small pages and merges repeated top3', async () => {
  const top3 = [entry('101', 1), entry('102', 2), entry('103', 3)];
  const scripted = createScriptedHttp({
    1: page({ num: 5, pages: 2, now: 1, top3, list: [entry('104', 3)] }),
    2: page({ num: 5, pages: 2, now: 2, top3, list: [entry('105', 3)] })
  });
  const provider = createProvider(scripted.httpGet);
  const result = await provider.resolveIdentities({
    uids: ['101', '104', '999']
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.snapshot_total, 5);
  assert.equal(result.identities['101'].guard_level, 1);
  assert.equal(result.identities['104'].guard_level, 3);
  assert.equal(result.identities['999'].guard_level, 0);
  assert.equal(result.identities['999'].roster_member, false);
  assert.equal(scripted.calls.length, 2);
  assert.deepEqual(
    scripted.calls.map(({ options }) => options.params.page),
    [1, 2]
  );
  for (const call of scripted.calls) {
    assert.equal(call.options.params.roomid, TARGET.roomId);
    assert.equal(call.options.params.ruid, TARGET.anchorUid);
    assert.equal('Cookie' in call.options.headers, false);
    assert.equal('Authorization' in call.options.headers, false);
  }
  const summary = await provider.readSafeSnapshotSummary({ forceRefresh: false });
  assert.deepEqual(summary.guard_level_counts, { 1: 1, 2: 1, 3: 3 });
  assert.equal(summary.unique_uid_count, 5);
});

test('top3 duplicated inside list is deduplicated by numeric UID', async () => {
  const member = entry('101', 3);
  const scripted = createScriptedHttp({
    1: page({
      num: 1,
      pages: 1,
      now: 1,
      top3: [member],
      list: [{ ...member }]
    })
  });
  const result = await createProvider(scripted.httpGet)
    .resolveIdentity({ uid: '101' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.snapshot_total, 1);
  assert.equal(result.guard_level, 3);
});

test('conflicting guard levels for one UID reject the whole snapshot', async () => {
  const scripted = createScriptedHttp({
    1: page({
      num: 1,
      pages: 1,
      now: 1,
      top3: [entry('101', 3)],
      list: [entry('101', 2)]
    })
  });
  const result = await createProvider(scripted.httpGet)
    .resolveIdentity({ uid: '101' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'identity_conflicting_guard_level');
});

test('num, total pages, now and unique count mismatches reject snapshots', async (t) => {
  const cases = [
    {
      name: 'now mismatch',
      pages: {
        1: page({ num: 1, pages: 1, now: 2, list: [entry('101', 3)] })
      }
    },
    {
      name: 'page metadata changes',
      pages: {
        1: page({ num: 2, pages: 2, now: 1, list: [entry('101', 3)] }),
        2: page({ num: 2, pages: 3, now: 2, list: [entry('102', 3)] })
      }
    },
    {
      name: 'unique count mismatch',
      pages: {
        1: page({ num: 2, pages: 1, now: 1, list: [entry('101', 3)] })
      }
    }
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const result = await createProvider(
        createScriptedHttp(candidate.pages).httpGet
      ).resolveIdentity({ uid: '101' });
      assert.equal(result.status, 'failed');
      assert.equal(result.error_code, 'identity_incomplete_pagination');
    });
  }
});

test('a missing or failed later page rejects the entire snapshot', async () => {
  const scripted = createScriptedHttp({
    1: page({ num: 2, pages: 2, now: 1, list: [entry('101', 3)] }),
    2: { status: 503, headers: {}, data: {} }
  });
  const result = await createProvider(scripted.httpGet)
    .resolveIdentity({ uid: '101' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'identity_upstream_5xx');
  assert.equal(scripted.calls.length, 2);
});

test('num zero is a valid complete empty snapshot', async () => {
  const scripted = createScriptedHttp({
    1: page({ num: 0, pages: 0, now: 1 })
  });
  const result = await createProvider(scripted.httpGet)
    .resolveIdentity({ uid: '101' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.guard_level, 0);
  assert.equal(result.snapshot_total, 0);
  assert.equal(result.roster_member, false);
});

test('medal data is accepted only for the configured anchor and room', async () => {
  const scripted = createScriptedHttp({
    1: page({
      num: 2,
      pages: 1,
      now: 1,
      list: [
        entry('101', 3),
        entry('102', 3, {
          medal_info: {
            target_id: 'other-anchor',
            anchor_roomid: 'other-room',
            medal_level: 99,
            medal_name: '其他主播勋章'
          }
        })
      ]
    })
  });
  const result = await createProvider(scripted.httpGet)
    .resolveIdentities({ uids: ['101', '102', '999'] });
  assert.equal(result.identities['101'].fans_medal_level, 12);
  assert.equal(result.identities['101'].fans_medal_name, '测试勋章');
  assert.equal(result.identities['102'].fans_medal_level, null);
  assert.equal(result.identities['102'].fans_medal_name, '');
  assert.equal(result.identities['102'].fans_medal_status, 'unknown');
  assert.equal(result.identities['999'].fans_medal_level, null);
  assert.equal(result.identities['999'].fans_medal_status, 'unknown');
});

test('concurrent callers share one complete snapshot request', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const scripted = createScriptedHttp(async () => {
    await gate;
    return page({ num: 1, pages: 1, now: 1, list: [entry('101', 3)] });
  });
  const provider = createProvider(scripted.httpGet);
  const first = provider.resolveIdentity({ uid: '101' });
  const second = provider.resolveIdentity({ uid: '102' });
  while (scripted.calls.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scripted.calls.length, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.guard_level, 3);
  assert.equal(secondResult.guard_level, 0);
  assert.equal(scripted.calls.length, 1);
});

test('all downgrade confirmations for one base snapshot share one second snapshot', async () => {
  const scripted = createScriptedHttp((requestedPage, callNumber) => page({
    num: callNumber === 1 ? 2 : 0,
    pages: callNumber === 1 ? 1 : 0,
    now: requestedPage,
    list: callNumber === 1 ? [entry('101', 3), entry('102', 2)] : []
  }));
  const provider = createProvider(scripted.httpGet);
  const base = await provider.resolveIdentities({ uids: ['101', '102'] });
  const [first, second] = await Promise.all([
    provider.confirmIdentities({
      uids: ['101'],
      baseSnapshotVersion: base.snapshot_version
    }),
    provider.confirmIdentities({
      uids: ['102'],
      baseSnapshotVersion: base.snapshot_version
    })
  ]);
  assert.equal(first.identities['101'].guard_level, 0);
  assert.equal(second.identities['102'].guard_level, 0);
  assert.equal(scripted.calls.length, 2);
});

test('429 obeys Retry-After and retries without exposing response data', async () => {
  const delays = [];
  const scripted = createScriptedHttp((requestedPage, callNumber) => (
    callNumber === 1
      ? { status: 429, headers: { 'retry-after': '2' }, data: { private: 'secret' } }
      : page({ num: 0, pages: 0, now: requestedPage })
  ));
  const provider = createProvider(scripted.httpGet, {
    sleep: async (ms) => delays.push(ms),
    config: { maxRetries: 1 }
  });
  const result = await provider.resolveIdentity({ uid: '101' });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(delays, [2000]);
  assert.equal(scripted.calls.length, 2);
});

test('timeout, 5xx and malformed responses fail without confirmed absence', async (t) => {
  const timeout = new Error('synthetic timeout');
  timeout.code = 'ECONNABORTED';
  const cases = [
    {
      name: 'timeout',
      response: timeout,
      code: 'identity_timeout'
    },
    {
      name: '5xx',
      response: { status: 503, headers: {}, data: {} },
      code: 'identity_upstream_5xx'
    },
    {
      name: 'malformed',
      response: { status: 200, headers: {}, data: { code: 0, data: {} } },
      code: 'identity_malformed_response'
    }
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const result = await createProvider(
        createScriptedHttp({ 1: candidate.response }).httpGet
      ).resolveIdentity({ uid: '101' });
      assert.equal(result.status, 'failed');
      assert.equal(result.error_code, candidate.code);
    });
  }
});

test('runtime kill switch returns to fail closed without another request', async () => {
  const env = {
    VIEWER_IDENTITY_PROVIDER: PROVIDER_NAME,
    VIEWER_IDENTITY_PROVIDER_KILL_SWITCH: 'false',
    VIEWER_IDENTITY_TARGET_ANCHOR_UID: TARGET.anchorUid,
    VIEWER_IDENTITY_TARGET_ROOM_ID: TARGET.roomId
  };
  const scripted = createScriptedHttp({
    1: page({ num: 0, pages: 0, now: 1 })
  });
  const provider = createConfiguredIdentityProvider({
    env,
    httpGet: scripted.httpGet,
    sleep: async () => {},
    random: () => 0,
    logger: { info() {}, warn() {} }
  });
  assert.equal((await provider.resolveIdentity({ uid: '101' })).status, 'confirmed');
  env.VIEWER_IDENTITY_PROVIDER_KILL_SWITCH = 'true';
  assert.equal(provider.supportsReconciliation, false);
  assert.deepEqual(await provider.resolveIdentity({ uid: '101' }), {
    status: 'unavailable',
    error_code: 'identity_source_not_configured',
    retryable: true
  });
  assert.equal(scripted.calls.length, 1);
});

test('provider logs contain only bounded operational metadata', async () => {
  const logs = [];
  const logger = {
    info(...args) {
      logs.push(args);
    },
    warn(...args) {
      logs.push(args);
    }
  };
  const scripted = createScriptedHttp({
    1: page({
      num: 1,
      pages: 1,
      now: 1,
      list: [entry('123456789', 3, { username: 'Sensitive Name' })]
    })
  });
  await createProvider(scripted.httpGet, { logger })
    .resolveIdentity({ uid: '123456789' });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /123456789|Sensitive Name|Cookie|Token|Authorization/i);
  assert.match(serialized, /snapshot_complete/);
});
