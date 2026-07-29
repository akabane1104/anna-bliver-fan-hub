const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createIdentityProvider,
  createUnavailableIdentityProvider
} = require('../src/services/bilibiliIdentityProvider');
const {
  createViewerIdentityService,
  guardLevelToRole,
  highestViewerRole
} = require('../src/services/viewerIdentityService');
const {
  ROLES,
  VIEWER_ROLES,
  permissionsForRole
} = require('../src/config/accessControl');
const {
  __test__: viewerControllerTest
} = require('../src/controllers/viewerIdentityController');

function createMemoryPool({
  users = [{ id: 1, username: 'viewer', role: ROLES.FAN_CLUB }],
  bindings = [{
    id: 10,
    user_id: 1,
    bilibili_uid: '10001',
    bilibili_open_id: 'trusted-open-id',
    status: 'verified',
    is_primary: 1,
    verified_at: '2026-07-27 00:00:00.000',
    identity_version: 0,
    sync_failure_count: 0,
    identity_sync_status: 'never',
    guard_level: null,
    manual_role: null,
    manual_expires_at: null
  }]
} = {}) {
  const state = {
    users: users.map((item) => ({ ...item })),
    bindings: bindings.map((item) => ({ ...item })),
    audits: [],
    userRoleUpdates: 0,
    settings: { bilibili_uid: '90001' }
  };

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.includes("FROM settings WHERE setting_key = 'bilibili_uid'")) {
      return [[{ setting_value: state.settings.bilibili_uid }]];
    }
    if (normalized.startsWith('SELECT user_id FROM user_bilibili_bindings')
      && normalized.includes("WHERE id = ? AND status = 'verified'")) {
      return [[state.bindings.find((item) => (
        Number(item.id) === Number(params[0]) && item.status === 'verified'
      ))].filter(Boolean).map(({ user_id }) => ({ user_id }))];
    }
    if (normalized.startsWith('SELECT * FROM user_bilibili_bindings')
      && normalized.includes("WHERE id = ? AND status = 'verified'")) {
      return [[state.bindings.find((item) => (
        Number(item.id) === Number(params[0]) && item.status === 'verified'
      ))].filter(Boolean)];
    }
    if (normalized.startsWith('SELECT id FROM user_bilibili_bindings')
      && normalized.includes("WHERE bilibili_open_id = ? AND status = 'verified'")) {
      return [[state.bindings.find((item) => (
        item.bilibili_open_id === params[0] && item.status === 'verified'
      ))].filter(Boolean).map(({ id }) => ({ id }))];
    }
    if (normalized.startsWith('SELECT id, user_id, bilibili_uid, last_sync_attempt_at')) {
      return [[state.bindings.find((item) => (
        Number(item.user_id) === Number(params[0])
        && String(item.bilibili_uid) === String(params[1])
        && item.status === 'verified'
      ))].filter(Boolean)];
    }
    if (normalized.startsWith('SELECT b.identity_version, u.role AS user_role')) {
      const binding = state.bindings.find((item) => Number(item.id) === Number(params[0]));
      const user = binding
        ? state.users.find((item) => Number(item.id) === Number(binding.user_id))
        : null;
      return [[binding && user ? {
        identity_version: binding.identity_version,
        user_role: user.role
      } : null].filter(Boolean)];
    }
    if (normalized.startsWith('SELECT identity_version')) {
      return [[state.bindings.find((item) => Number(item.id) === Number(params[0]))]
        .filter(Boolean)
        .map(({ identity_version }) => ({ identity_version }))];
    }
    if (normalized.startsWith('UPDATE user_bilibili_bindings SET identity_sync_status = \'pending\'')) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[2]));
      Object.assign(row, {
        identity_sync_status: 'pending',
        last_sync_attempt_at: params[0],
        identity_version: params[1]
      });
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('SELECT b.*, u.role AS user_role')
      && normalized.includes('WHERE b.id = ?')) {
      const binding = state.bindings.find((item) => Number(item.id) === Number(params[0]));
      const user = binding
        ? state.users.find((item) => Number(item.id) === Number(binding.user_id))
        : null;
      return [[binding && user ? { ...binding, user_role: user.role } : null].filter(Boolean)];
    }
    if (normalized.startsWith('UPDATE user_bilibili_bindings SET target_anchor_uid = ?')
      && normalized.includes('fans_medal_level = ?')) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[14]));
      Object.assign(row, {
        target_anchor_uid: params[0],
        target_room_id: params[1],
        fans_medal_level: params[2],
        fans_medal_name: params[3],
        fans_medal_status: params[4],
        guard_level: params[5],
        guard_started_at: params[6],
        guard_expires_at: params[7],
        identity_sync_status: 'success',
        identity_source: params[8],
        last_sync_attempt_at: params[9],
        last_sync_success_at: params[10],
        last_sync_error_code: null,
        identity_observed_at: params[11],
        sync_failure_count: 0,
        next_sync_at: params[12],
        manual_role: null,
        manual_expires_at: null,
        manual_actor_user_id: null,
        manual_reason: null,
        manual_overridden_at: params[13]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith(
      "UPDATE user_bilibili_bindings SET identity_sync_status = 'success'"
    )) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[5]));
      Object.assign(row, {
        identity_sync_status: 'success',
        identity_source: params[0],
        last_sync_attempt_at: params[1],
        last_sync_success_at: params[2],
        last_sync_error_code: null,
        identity_observed_at: params[3],
        sync_failure_count: 0,
        next_sync_at: params[4]
      });
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (normalized.startsWith('SELECT b.id, b.user_id, b.bilibili_uid, b.sync_failure_count')) {
      const binding = state.bindings.find((item) => Number(item.id) === Number(params[0]));
      const user = binding
        ? state.users.find((item) => Number(item.id) === Number(binding.user_id))
        : null;
      return [[binding && user ? {
        id: binding.id,
        user_id: binding.user_id,
        bilibili_uid: binding.bilibili_uid,
        sync_failure_count: binding.sync_failure_count,
        identity_version: binding.identity_version,
        user_role: user.role
      } : null].filter(Boolean)];
    }
    if (normalized.startsWith('UPDATE user_bilibili_bindings SET identity_sync_status = ?')) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[4]));
      Object.assign(row, {
        identity_sync_status: params[0],
        last_sync_error_code: params[1],
        sync_failure_count: params[2],
        next_sync_at: params[3]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('SELECT id, role FROM users WHERE id = ? FOR UPDATE')) {
      return [[state.users.find((item) => Number(item.id) === Number(params[0]))]
        .filter(Boolean)
        .map(({ id, role }) => ({ id, role }))];
    }
    if (normalized.startsWith('SELECT id, bilibili_uid, guard_level, identity_sync_status')) {
      return [state.bindings
        .filter((item) => Number(item.user_id) === Number(params[0]) && item.status === 'verified')
        .map((item) => ({ ...item }))];
    }
    if (normalized.startsWith('UPDATE users SET role = ? WHERE id = ?')) {
      const user = state.users.find((item) => Number(item.id) === Number(params[1]));
      user.role = params[0];
      state.userRoleUpdates += 1;
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('INSERT INTO viewer_identity_audit')) {
      state.audits.push({
        binding_id: params[0],
        target_user_id: params[1],
        bilibili_uid: params[2],
        action: params[3],
        actor_user_id: params[4],
        actor_role: params[5],
        old_role: params[6],
        new_role: params[7],
        source: params[8],
        reason: params[9],
        valid_until: params[10],
        event_key: params[11]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('SELECT b.*, u.role AS user_role')
      && normalized.includes('WHERE b.bilibili_open_id = ?')) {
      const binding = state.bindings.find((item) => item.bilibili_open_id === params[0]);
      const user = binding
        ? state.users.find((item) => Number(item.id) === Number(binding.user_id))
        : null;
      return [[binding && user ? { ...binding, user_role: user.role } : null].filter(Boolean)];
    }
    if (normalized.startsWith('UPDATE user_bilibili_bindings SET target_anchor_uid = ?')
      && normalized.includes("identity_source = 'official_listener'")) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[8]));
      Object.assign(row, {
        target_anchor_uid: params[0],
        target_room_id: params[1],
        guard_level: params[2],
        identity_sync_status: 'success',
        identity_source: 'official_listener',
        last_sync_attempt_at: params[3],
        last_sync_success_at: params[4],
        identity_observed_at: params[5],
        next_sync_at: params[6],
        manual_role: null,
        manual_expires_at: null,
        manual_actor_user_id: null,
        manual_reason: null,
        manual_overridden_at: params[7]
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith('SELECT * FROM user_bilibili_bindings')
      && normalized.includes('WHERE user_id = ? AND bilibili_uid = ?')) {
      return [[state.bindings.find((item) => (
        Number(item.user_id) === Number(params[0])
        && String(item.bilibili_uid) === String(params[1])
      ))].filter(Boolean)];
    }
    if (normalized.startsWith('UPDATE user_bilibili_bindings SET manual_role = ?')) {
      const row = state.bindings.find((item) => Number(item.id) === Number(params[5]));
      Object.assign(row, {
        manual_role: params[0],
        manual_expires_at: params[1],
        manual_actor_user_id: params[2],
        manual_reason: params[3],
        manual_created_at: params[4],
        identity_source: 'manual_fallback'
      });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unhandled test SQL: ${normalized}`);
  };

  const connection = {
    query,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {}
  };
  return {
    state,
    query,
    async getConnection() {
      return connection;
    }
  };
}

function confirmedIdentity(overrides = {}) {
  return {
    status: 'confirmed',
    complete: true,
    uid: '10001',
    target_anchor_uid: '90001',
    target_room_id: '80001',
    fans_medal_level: 36,
    fans_medal_name: '测试勋章',
    fans_medal_status: 'active',
    guard_level: 3,
    guard_started_at: '2026-07-27T00:00:00.000Z',
    guard_expires_at: '2026-08-27T00:00:00.000Z',
    observed_at: '2026-07-27T00:01:00.000Z',
    source: 'server_provider',
    ...overrides
  };
}

function confirmedBinding(overrides = {}) {
  const identity = confirmedIdentity();
  return {
    id: 10,
    user_id: 1,
    bilibili_uid: '10001',
    bilibili_open_id: 'trusted-open-id',
    status: 'verified',
    is_primary: 1,
    verified_at: new Date('2026-07-27T00:00:00.000Z'),
    target_anchor_uid: identity.target_anchor_uid,
    target_room_id: identity.target_room_id,
    fans_medal_level: identity.fans_medal_level,
    fans_medal_name: identity.fans_medal_name,
    fans_medal_status: identity.fans_medal_status,
    guard_level: identity.guard_level,
    guard_started_at: new Date(2026, 6, 27, 0, 0, 0, 0),
    guard_expires_at: new Date(2026, 7, 27, 0, 0, 0, 0),
    identity_sync_status: 'success',
    identity_source: identity.source,
    last_sync_attempt_at: new Date('2026-07-27T00:01:00.000Z'),
    last_sync_success_at: new Date('2026-07-27T00:01:00.000Z'),
    last_sync_error_code: null,
    identity_observed_at: new Date('2026-07-27T00:01:00.000Z'),
    identity_version: 0,
    sync_failure_count: 0,
    next_sync_at: new Date('2026-07-27T00:06:00.000Z'),
    manual_role: null,
    manual_expires_at: null,
    ...overrides
  };
}

function completeSnapshotProvider({
  first,
  confirmation = null
}) {
  const calls = { resolve: 0, confirm: 0 };
  return {
    calls,
    provider: {
      name: 'guard_tab_top_list',
      target: { anchorUid: '90001', roomId: '80001' },
      supportsTransientCredentials: false,
      supportsReconciliation: true,
      supportsCompleteSnapshots: true,
      supportsListenerIdentityMapping: false,
      async resolveIdentity() {
        calls.resolve += 1;
        return first;
      },
      async confirmIdentities() {
        calls.confirm += 1;
        return confirmation;
      }
    }
  };
}

test('guard levels map explicitly without numeric rank inference', () => {
  assert.equal(guardLevelToRole(0), ROLES.FAN_CLUB);
  assert.equal(guardLevelToRole(1), ROLES.GOVERNOR);
  assert.equal(guardLevelToRole(2), ROLES.ADMIRAL);
  assert.equal(guardLevelToRole(3), ROLES.CAPTAIN);
  assert.throws(() => guardLevelToRole(4), /identity_invalid_guard_level/);
});

test('multiple UIDs select the highest effective viewer identity only', () => {
  assert.equal(highestViewerRole([
    { guard_level: 3 },
    { guard_level: 2 },
    { guard_level: 1 }
  ]), ROLES.GOVERNOR);
  assert.equal(highestViewerRole([
    { guard_level: 0 },
    { guard_level: null }
  ]), ROLES.FAN_CLUB);
  assert.equal(highestViewerRole([
    { guard_level: 3 },
    { guard_level: 2 }
  ]), ROLES.ADMIRAL);
});

test('four viewer roles remain distinct values without extra capabilities', () => {
  assert.deepEqual(VIEWER_ROLES, [
    ROLES.FAN_CLUB,
    ROLES.CAPTAIN,
    ROLES.ADMIRAL,
    ROLES.GOVERNOR
  ]);
  assert.equal(new Set(VIEWER_ROLES).size, 4);
});

test('provider validates target, UID, completeness, guard and medal fields', async () => {
  const target = { anchorUid: '90001', roomId: '80001' };
  for (const invalid of [
    { complete: false },
    { uid: 'different' },
    { target_room_id: 'different' },
    { guard_level: 9 },
    { fans_medal_level: -1 },
    { fans_medal_status: 'invented' },
    { source: 'browser' }
  ]) {
    const provider = createIdentityProvider({
      resolveIdentity: async () => confirmedIdentity(invalid)
    });
    const result = await provider.resolveIdentity({ uid: '10001', target });
    assert.equal(result.status, 'failed');
  }
});

test('unavailable provider performs no network work and fails closed', async () => {
  const provider = createUnavailableIdentityProvider();
  assert.equal(provider.supportsTransientCredentials, false);
  assert.equal(provider.supportsReconciliation, false);
  assert.deepEqual(await provider.resolveIdentity(), {
    status: 'unavailable',
    error_code: 'identity_source_not_configured',
    retryable: true
  });
});

test('provider capabilities are opt-in instead of inferred', () => {
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity()
  });
  assert.equal(provider.supportsTransientCredentials, false);
  assert.equal(provider.supportsReconciliation, false);
  const capable = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity(),
    supportsTransientCredentials: true,
    supportsReconciliation: true
  });
  assert.equal(capable.supportsTransientCredentials, true);
  assert.equal(capable.supportsReconciliation, true);
});

test('transient QR credentials reach only an explicitly capable provider', async () => {
  const credentials = {
    cookies: { synthetic: 'not-a-real-cookie' },
    refreshToken: 'not-a-real-token'
  };
  for (const supportsTransientCredentials of [false, true]) {
    const pool = createMemoryPool();
    let receivedCredentials;
    const provider = createIdentityProvider({
      resolveIdentity: async (input) => {
        receivedCredentials = input.transientCredentials;
        return confirmedIdentity();
      },
      supportsTransientCredentials
    });
    const service = createViewerIdentityService({
      pool,
      provider,
      clock: () => new Date('2026-07-27T00:01:00.000Z'),
      env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
      logger: { warn() {}, error() {} }
    });
    await service.syncBinding({
      userId: 1,
      bilibiliUid: '10001',
      transientCredentials: credentials,
      force: true
    });
    assert.equal(
      receivedCredentials,
      supportsTransientCredentials ? credentials : null
    );
  }
});

test('confirmed sync stores medal separately and updates the viewer role', async () => {
  const pool = createMemoryPool();
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity()
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'success');
  assert.equal(pool.state.users[0].role, ROLES.CAPTAIN);
  assert.equal(pool.state.bindings[0].fans_medal_level, 36);
  assert.equal(pool.state.bindings[0].fans_medal_name, '测试勋章');
  assert.equal(pool.state.bindings[0].guard_level, 3);
  assert.equal(pool.state.bindings[0].identity_version, 1);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
});

test('captain to governor is an immediate upgrade despite the lower numeric guard level', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 0,
      identity_sync_status: 'success',
      guard_level: 3,
      manual_role: null
    }]
  });
  const configured = completeSnapshotProvider({
    first: confirmedIdentity({
      guard_level: 1,
      roster_member: true,
      snapshot_total: 1,
      snapshot_version: '2026-07-27T00:01:00.000Z'
    })
  });
  const service = createViewerIdentityService({
    pool,
    provider: configured.provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: {},
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'success');
  assert.equal(result.role, ROLES.GOVERNOR);
  assert.equal(configured.calls.resolve, 1);
  assert.equal(configured.calls.confirm, 0);
});

test('same-level renewal refreshes the snapshot without downgrade confirmation', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 0,
      identity_sync_status: 'success',
      identity_observed_at: '2026-07-26 23:55:00.000',
      guard_level: 3,
      manual_role: null
    }]
  });
  const configured = completeSnapshotProvider({
    first: confirmedIdentity({
      guard_level: 3,
      roster_member: true,
      snapshot_total: 1,
      snapshot_version: '2026-07-27T00:01:00.000Z'
    })
  });
  const service = createViewerIdentityService({
    pool,
    provider: configured.provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: {},
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'success');
  assert.equal(result.role, ROLES.CAPTAIN);
  assert.equal(pool.state.bindings[0].identity_observed_at, '2026-07-27 00:01:00.000');
  assert.equal(configured.calls.confirm, 0);
});

test('same confirmed identity refreshes runtime state without another audit', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [confirmedBinding()]
  });
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity({
      observed_at: '2026-07-27T00:07:00.000Z'
    })
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:07:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const capabilitiesBefore = permissionsForRole(pool.state.users[0].role);

  await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });

  assert.equal(pool.state.audits.length, 0);
  assert.equal(pool.state.bindings[0].identity_version, 1);
  assert.equal(pool.state.bindings[0].last_sync_success_at, '2026-07-27 00:07:00.000');
  assert.equal(pool.state.users[0].role, ROLES.CAPTAIN);
  assert.equal(pool.state.userRoleUpdates, 0);
  assert.deepEqual(permissionsForRole(pool.state.users[0].role), capabilitiesBefore);
});

test('ten identical confirmations keep identity audit and effective access stable', async () => {
  const pool = createMemoryPool();
  let nowMs = Date.parse('2026-07-27T00:01:00.000Z');
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity({
      observed_at: new Date(nowMs).toISOString()
    })
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date(nowMs),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });

  for (let round = 0; round < 10; round += 1) {
    await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
    nowMs += 60_000;
  }

  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
  assert.equal(pool.state.bindings[0].identity_version, 10);
  assert.equal(pool.state.users[0].role, ROLES.CAPTAIN);
  assert.equal(pool.state.userRoleUpdates, 1);
  assert.deepEqual(permissionsForRole(pool.state.users[0].role), []);
});

test('repeated confirmed absence keeps two-snapshot safety without audit growth', async () => {
  const pool = createMemoryPool({
    bindings: [confirmedBinding({
      fans_medal_level: null,
      fans_medal_name: '',
      fans_medal_status: 'unknown',
      guard_level: 0,
      guard_started_at: null,
      guard_expires_at: null
    })]
  });
  let nowMs = Date.parse('2026-07-27T00:07:00.000Z');
  let resolveCalls = 0;
  let confirmCalls = 0;
  const provider = {
    name: 'guard_tab_top_list',
    target: { anchorUid: '90001', roomId: '80001' },
    supportsTransientCredentials: false,
    supportsReconciliation: true,
    supportsCompleteSnapshots: true,
    supportsListenerIdentityMapping: false,
    async resolveIdentity() {
      resolveCalls += 1;
      return confirmedIdentity({
        fans_medal_level: null,
        fans_medal_name: '',
        fans_medal_status: 'unknown',
        guard_level: 0,
        guard_started_at: null,
        guard_expires_at: null,
        roster_member: false,
        snapshot_total: 0,
        snapshot_version: new Date(nowMs).toISOString(),
        observed_at: new Date(nowMs).toISOString()
      });
    },
    async confirmIdentities() {
      confirmCalls += 1;
      const observedAt = new Date(nowMs + 1_000).toISOString();
      return {
        status: 'confirmed',
        complete: true,
        snapshot_version: observedAt,
        snapshot_total: 0,
        identities: {
          10001: confirmedIdentity({
            fans_medal_level: null,
            fans_medal_name: '',
            fans_medal_status: 'unknown',
            guard_level: 0,
            guard_started_at: null,
            guard_expires_at: null,
            roster_member: false,
            snapshot_total: 0,
            snapshot_version: observedAt,
            observed_at: observedAt
          })
        }
      };
    }
  };
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date(nowMs),
    env: {},
    logger: { warn() {}, error() {} }
  });

  for (let round = 0; round < 2; round += 1) {
    await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
    nowMs += 6 * 60_000;
  }

  assert.equal(resolveCalls, 2);
  assert.equal(confirmCalls, 2);
  assert.equal(pool.state.audits.length, 0);
  assert.equal(pool.state.bindings[0].identity_version, 2);
  assert.equal(pool.state.bindings[0].guard_level, 0);
  assert.equal(pool.state.users[0].role, ROLES.FAN_CLUB);
});

test('a real captain to admiral transition records exactly one change', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [confirmedBinding()]
  });
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity({
      guard_level: 2,
      observed_at: '2026-07-27T00:07:00.000Z'
    })
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:07:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });

  await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });

  assert.equal(pool.state.bindings[0].guard_level, 2);
  assert.equal(pool.state.users[0].role, ROLES.ADMIRAL);
  assert.equal(pool.state.bindings[0].identity_version, 1);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
});

test('one complete snapshot missing a UID cannot downgrade it', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.GOVERNOR }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 0,
      identity_sync_status: 'success',
      guard_level: 1,
      manual_role: null
    }]
  });
  const configured = completeSnapshotProvider({
    first: confirmedIdentity({
      guard_level: 0,
      roster_member: false,
      snapshot_total: 0,
      snapshot_version: '2026-07-27T00:01:00.000Z'
    }),
    confirmation: {
      status: 'failed',
      error_code: 'identity_incomplete_pagination',
      retryable: true
    }
  });
  const service = createViewerIdentityService({
    pool,
    provider: configured.provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: {},
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'failed');
  assert.equal(pool.state.bindings[0].guard_level, 1);
  assert.equal(pool.state.users[0].role, ROLES.GOVERNOR);
  assert.equal(pool.state.bindings[0].last_sync_error_code, 'identity_incomplete_pagination');
  assert.equal(configured.calls.confirm, 1);
});

test('two complete empty snapshots are required before downgrade to fan club', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 0,
      identity_sync_status: 'success',
      guard_level: 3,
      manual_role: null
    }]
  });
  const first = confirmedIdentity({
    guard_level: 0,
    roster_member: false,
    snapshot_total: 0,
    snapshot_version: '2026-07-27T00:01:00.000Z',
    observed_at: '2026-07-27T00:01:00.000Z'
  });
  const second = confirmedIdentity({
    guard_level: 0,
    roster_member: false,
    snapshot_total: 0,
    snapshot_version: '2026-07-27T00:01:01.000Z',
    observed_at: '2026-07-27T00:01:01.000Z'
  });
  const configured = completeSnapshotProvider({
    first,
    confirmation: {
      status: 'confirmed',
      complete: true,
      snapshot_version: second.snapshot_version,
      snapshot_total: 0,
      identities: { 10001: second }
    }
  });
  const service = createViewerIdentityService({
    pool,
    provider: configured.provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: {},
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'success');
  assert.equal(result.role, ROLES.FAN_CLUB);
  assert.equal(pool.state.bindings[0].guard_level, 0);
  assert.equal(pool.state.bindings[0].identity_observed_at, '2026-07-27 00:01:01.000');
  assert.equal(pool.state.bindings[0].identity_source, 'server_provider');
  assert.equal(configured.calls.confirm, 1);
  assert.equal(pool.state.bindings[0].identity_version, 1);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
});

test('conflicting downgrade snapshots preserve the previous identity', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.GOVERNOR }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 0,
      identity_sync_status: 'success',
      guard_level: 1,
      manual_role: null
    }]
  });
  const first = confirmedIdentity({
    guard_level: 2,
    roster_member: true,
    snapshot_total: 1,
    snapshot_version: '2026-07-27T00:01:00.000Z'
  });
  const second = confirmedIdentity({
    guard_level: 3,
    roster_member: true,
    snapshot_total: 1,
    snapshot_version: '2026-07-27T00:01:01.000Z',
    observed_at: '2026-07-27T00:01:01.000Z'
  });
  const configured = completeSnapshotProvider({
    first,
    confirmation: {
      status: 'confirmed',
      complete: true,
      snapshot_version: second.snapshot_version,
      snapshot_total: 1,
      identities: { 10001: second }
    }
  });
  const service = createViewerIdentityService({
    pool,
    provider: configured.provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: {},
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'identity_downgrade_unconfirmed');
  assert.equal(pool.state.bindings[0].guard_level, 1);
  assert.equal(pool.state.users[0].role, ROLES.GOVERNOR);
  assert.equal(pool.state.bindings[0].identity_version, 1);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    0
  );
});

test('confirmed automatic sync overrides a temporary manual fallback', async () => {
  const pool = createMemoryPool({
    users: [{ id: 1, username: 'viewer', role: ROLES.CAPTAIN }],
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_version: 0,
      sync_failure_count: 1,
      identity_sync_status: 'failed',
      guard_level: 0,
      manual_role: ROLES.CAPTAIN,
      manual_expires_at: '2026-07-28 00:00:00.000',
      manual_actor_user_id: 8,
      manual_reason: '临时补录'
    }]
  });
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity({ guard_level: 1 })
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const result = await service.syncBinding({
    userId: 1,
    bilibiliUid: '10001',
    force: true
  });
  assert.equal(result.role, ROLES.GOVERNOR);
  assert.equal(pool.state.bindings[0].manual_role, null);
  assert.ok(pool.state.audits.some((item) => item.action === 'manual_overridden'));
});

test('timeouts, 429, 5xx, malformed and incomplete pages never downgrade', async () => {
  for (const errorCode of [
    'identity_timeout',
    'identity_rate_limited',
    'identity_upstream_5xx',
    'identity_malformed_response',
    'identity_incomplete_pagination'
  ]) {
    const pool = createMemoryPool({
      users: [{ id: 1, username: 'viewer', role: ROLES.GOVERNOR }],
      bindings: [{
        id: 10,
        user_id: 1,
        bilibili_uid: '10001',
        status: 'verified',
        identity_version: 0,
        sync_failure_count: 0,
        identity_sync_status: 'success',
        guard_level: 1,
        manual_role: null
      }]
    });
    const provider = createIdentityProvider({
      resolveIdentity: async () => ({
        status: 'failed',
        error_code: errorCode,
        retryable: true
      })
    });
    const service = createViewerIdentityService({
      pool,
      provider,
      clock: () => new Date('2026-07-27T00:01:00.000Z'),
      env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
      logger: { warn() {}, error() {} }
    });
    await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
    assert.equal(pool.state.users[0].role, ROLES.GOVERNOR);
    assert.equal(pool.state.bindings[0].guard_level, 1);
    assert.equal(pool.state.bindings[0].last_sync_error_code, errorCode);
    assert.equal(pool.state.bindings[0].identity_version, 1);
    assert.equal(
      pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
      0
    );
  }
});

test('streamer and admin roles are never overwritten by automatic sync', async () => {
  for (const protectedRole of [ROLES.STREAMER, ROLES.ADMIN]) {
    const pool = createMemoryPool({
      users: [{ id: 1, username: 'protected', role: protectedRole }]
    });
    const provider = createIdentityProvider({
      resolveIdentity: async () => confirmedIdentity({ guard_level: 1 })
    });
    const service = createViewerIdentityService({
      pool,
      provider,
      clock: () => new Date('2026-07-27T00:01:00.000Z'),
      env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
      logger: { warn() {}, error() {} }
    });
    await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
    assert.equal(pool.state.users[0].role, protectedRole);
    assert.equal(
      pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
      1
    );
  }
});

test('protected roles accept binding refreshes without repeated identity audits', async () => {
  for (const protectedRole of [ROLES.STREAMER, ROLES.ADMIN]) {
    const pool = createMemoryPool({
      users: [{ id: 1, username: 'protected', role: protectedRole }],
      bindings: [confirmedBinding()]
    });
    let nowMs = Date.parse('2026-07-27T00:07:00.000Z');
    const provider = createIdentityProvider({
      resolveIdentity: async () => confirmedIdentity({
        observed_at: new Date(nowMs).toISOString()
      })
    });
    const service = createViewerIdentityService({
      pool,
      provider,
      clock: () => new Date(nowMs),
      env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
      logger: { warn() {}, error() {} }
    });
    const capabilitiesBefore = permissionsForRole(protectedRole);

    for (let round = 0; round < 2; round += 1) {
      await service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
      nowMs += 6 * 60_000;
    }

    assert.equal(pool.state.users[0].role, protectedRole);
    assert.equal(pool.state.userRoleUpdates, 0);
    assert.equal(pool.state.audits.length, 0);
    assert.equal(pool.state.bindings[0].identity_version, 2);
    assert.deepEqual(permissionsForRole(pool.state.users[0].role), capabilitiesBefore);
  }
});

test('streamer-managed resync cannot modify streamer or admin targets', async () => {
  for (const protectedRole of [ROLES.STREAMER, ROLES.ADMIN]) {
    let providerCalls = 0;
    const pool = createMemoryPool({
      users: [{ id: 1, username: 'protected', role: protectedRole }]
    });
    const provider = createIdentityProvider({
      resolveIdentity: async () => {
        providerCalls += 1;
        return confirmedIdentity({ guard_level: 1 });
      }
    });
    const service = createViewerIdentityService({
      pool,
      provider,
      clock: () => new Date('2026-07-27T00:01:00.000Z'),
      env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
      logger: { warn() {}, error() {} }
    });
    await assert.rejects(
      service.syncBinding({
        userId: 1,
        bilibiliUid: '10001',
        force: true,
        requireViewerTarget: true
      }),
      (error) => error.code === 'identity_protected_role' && error.status === 403
    );
    assert.equal(providerCalls, 0);
    assert.equal(pool.state.bindings[0].identity_sync_status, 'never');
  }
});

test('older concurrent responses cannot overwrite the newest attempt', async () => {
  const pool = createMemoryPool();
  const pending = [];
  const provider = createIdentityProvider({
    resolveIdentity: () => new Promise((resolve) => pending.push(resolve))
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const older = service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const newer = service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  pending[1](confirmedIdentity({
    guard_level: 1,
    observed_at: '2026-07-27T00:02:00.000Z'
  }));
  await newer;
  pending[0](confirmedIdentity({
    guard_level: 3,
    observed_at: '2026-07-27T00:01:00.000Z'
  }));
  assert.equal((await older).status, 'stale_ignored');
  assert.equal(pool.state.users[0].role, ROLES.GOVERNOR);
  assert.equal(pool.state.bindings[0].identity_version, 2);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
});

test('concurrent identical confirmations create at most one identity audit', async () => {
  const pool = createMemoryPool();
  const pending = [];
  const provider = createIdentityProvider({
    resolveIdentity: () => new Promise((resolve) => pending.push(resolve))
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const first = service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = service.syncBinding({ userId: 1, bilibiliUid: '10001', force: true });
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));

  pending[1](confirmedIdentity({ observed_at: '2026-07-27T00:02:00.000Z' }));
  assert.equal((await second).status, 'success');
  pending[0](confirmedIdentity({ observed_at: '2026-07-27T00:01:00.000Z' }));
  assert.equal((await first).status, 'stale_ignored');

  assert.equal(pool.state.bindings[0].identity_version, 2);
  assert.equal(pool.state.users[0].role, ROLES.CAPTAIN);
  assert.equal(
    pool.state.audits.filter((item) => item.action === 'sync_confirmed').length,
    1
  );
});

test('Listener guard identity updates stay disabled without a trusted numeric UID mapping', async () => {
  const pool = createMemoryPool();
  const provider = createIdentityProvider({
    resolveIdentity: async () => confirmedIdentity(),
    supportsReconciliation: true
  });
  const service = createViewerIdentityService({
    pool,
    provider,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const mismatch = await service.observeTrustedGuardEvent({
    event_id: 'wrong-room',
    event_type: 'guard_buy',
    mode: 'live',
    room_id: 'other',
    occurred_at: '2026-07-27T00:01:00.000Z',
    actor: { open_id: 'trusted-open-id' },
    payload: { guard_level: '1' }
  });
  assert.equal(mismatch.reason, 'identity_target_mismatch');
  const unmapped = await service.observeTrustedGuardEvent({
    event_id: 'trusted-event',
    event_type: 'guard_buy',
    mode: 'live',
    room_id: '80001',
    occurred_at: '2026-07-27T00:01:00.000Z',
    actor: {
      uid: 0,
      open_id: 'trusted-open-id',
      display_name: 'Synthetic Name'
    },
    payload: { guard_level: '1' }
  });
  assert.deepEqual(unmapped, {
    status: 'ignored',
    reason: 'identity_listener_mapping_unavailable'
  });
  assert.equal(pool.state.users[0].role, ROLES.FAN_CLUB);
  assert.equal(pool.state.bindings[0].guard_level, null);
});

test('Listener cannot become the only identity source', async () => {
  const pool = createMemoryPool();
  const service = createViewerIdentityService({
    pool,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  const result = await service.observeTrustedGuardEvent({
    event_id: 'unreconciled-event',
    event_type: 'guard_buy',
    mode: 'live',
    room_id: '80001',
    occurred_at: '2026-07-27T00:01:00.000Z',
    actor: { open_id: 'trusted-open-id' },
    payload: { guard_level: '1' }
  });
  assert.deepEqual(result, {
    status: 'ignored',
    reason: 'identity_reconciliation_unavailable'
  });
  assert.equal(pool.state.users[0].role, ROLES.FAN_CLUB);
});

test('manual fallback requires a viewer target, reason, and expiry for guard roles', async () => {
  const pool = createMemoryPool({
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_sync_status: 'failed',
      identity_version: 1,
      sync_failure_count: 1,
      guard_level: 0,
      manual_role: null
    }]
  });
  const service = createViewerIdentityService({
    pool,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(
    service.setManualFallback({
      actorUserId: 8,
      actorRole: ROLES.STREAMER,
      targetUserId: 1,
      bilibiliUid: '10001',
      role: ROLES.CAPTAIN,
      reason: '上游暂时不可用'
    }),
    (error) => error.code === 'identity_fallback_expiry_required'
  );
  const result = await service.setManualFallback({
    actorUserId: 8,
    actorRole: ROLES.STREAMER,
    targetUserId: 1,
    bilibiliUid: '10001',
    role: ROLES.CAPTAIN,
    reason: '上游暂时不可用',
    expiresAt: '2026-07-28T00:00:00.000Z'
  });
  assert.equal(result.role, ROLES.CAPTAIN);
  const manualAudit = pool.state.audits.find((item) => (
    item.action === 'manual_created' || item.action === 'manual_updated'
  ));
  assert.ok(manualAudit, JSON.stringify(pool.state.audits));
  assert.equal(manualAudit.actor_role, ROLES.STREAMER);
});

test('manual fallback cannot override a successful automatic classification', async () => {
  const pool = createMemoryPool({
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_sync_status: 'success',
      identity_version: 1,
      sync_failure_count: 0,
      guard_level: 3,
      manual_role: null
    }]
  });
  const service = createViewerIdentityService({
    pool,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(
    service.setManualFallback({
      actorUserId: 8,
      actorRole: ROLES.STREAMER,
      targetUserId: 1,
      bilibiliUid: '10001',
      role: ROLES.GOVERNOR,
      reason: '不应覆盖',
      expiresAt: '2026-07-28T00:00:00.000Z'
    }),
    (error) => error.code === 'identity_automatic_classification_active'
  );
});

test('a streamer cannot change fallback records owned by another streamer', async () => {
  const pool = createMemoryPool({
    bindings: [{
      id: 10,
      user_id: 1,
      bilibili_uid: '10001',
      status: 'verified',
      identity_sync_status: 'failed',
      identity_version: 1,
      sync_failure_count: 1,
      guard_level: 0,
      manual_role: ROLES.CAPTAIN,
      manual_expires_at: '2026-07-28 00:00:00.000',
      manual_actor_user_id: 9,
      manual_reason: '其他主播补录'
    }]
  });
  const service = createViewerIdentityService({
    pool,
    clock: () => new Date('2026-07-27T00:01:00.000Z'),
    env: { BILIBILI_UID: '90001', LISTENER_ROOM_ID: '80001' },
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(
    service.setManualFallback({
      actorUserId: 8,
      actorRole: ROLES.STREAMER,
      targetUserId: 1,
      bilibiliUid: '10001',
      role: ROLES.ADMIRAL,
      reason: '无权修改',
      expiresAt: '2026-07-29T00:00:00.000Z'
    }),
    (error) => error.code === 'identity_fallback_owned_by_another_operator'
  );
});

test('binding, login and startup source wire immediate sync and persistent reconciliation', () => {
  const fs = require('node:fs');
  const bindingController = fs.readFileSync(
    require.resolve('../src/controllers/bilibiliBindingController.js'),
    'utf8'
  );
  const authController = fs.readFileSync(
    require.resolve('../src/controllers/authController.js'),
    'utf8'
  );
  const authMiddleware = fs.readFileSync(
    require.resolve('../src/middleware/auth.js'),
    'utf8'
  );
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(bindingController, /defaultViewerIdentityService\.syncBinding\(\{/);
  assert.match(bindingController, /transientCredentials/);
  assert.match(bindingController, /finally\s*\{[\s\S]*clearTransientCredentials/);
  assert.match(authController, /defaultViewerIdentityService\.refreshUserIfStale/);
  assert.match(authController, /SELECT role FROM users WHERE id = \?/);
  assert.match(authMiddleware, /SELECT role FROM users WHERE id = \?/);
  assert.match(server, /defaultViewerIdentityService\.scheduleReconciliation\(\)/);
});

test('management routes accept no client-supplied guard or target identity fields', () => {
  const fs = require('node:fs');
  const controller = fs.readFileSync(
    require.resolve('../src/controllers/viewerIdentityController.js'),
    'utf8'
  );
  assert.doesNotMatch(controller, /req\.body\?\.(?:guard_level|target_anchor_uid|target_room_id)/);
  assert.match(controller, /requireViewerTarget:\s*req\.userRole === ROLES\.STREAMER/);
});

test('source files never persist or log Bilibili cookies and tokens', () => {
  const fs = require('node:fs');
  const files = [
    '../src/services/viewerIdentityService.js',
    '../src/services/bilibiliIdentityProvider.js',
    '../src/services/bilibiliGuardTabTopListProvider.js',
    '../src/controllers/viewerIdentityController.js'
  ].map((relativePath) => fs.readFileSync(require.resolve(relativePath), 'utf8'));
  for (const source of files) {
    assert.doesNotMatch(source, /INSERT[^;]*(?:cookie|token|sessdata)/i);
    assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*(?:cookie|token|credential)/i);
  }
});

test('viewer identity management is restricted to streamer and admin operators', () => {
  const denied = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  assert.equal(
    viewerControllerTest.requireOperator({ userRole: ROLES.FAN_CLUB }, denied),
    false
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(
    viewerControllerTest.requireOperator({ userRole: ROLES.STREAMER }, denied),
    true
  );
  assert.equal(
    viewerControllerTest.requireOperator({ userRole: ROLES.ADMIN }, denied),
    true
  );
});
