const database = require('../config/database');
const {
  PERMISSIONS,
  ROLES,
  VIEWER_ROLES,
  isAdminRole
} = require('../config/accessControl');
const {
  validateTarget
} = require('./bilibiliIdentityProvider');
const {
  createConfiguredIdentityProvider
} = require('./bilibiliGuardTabTopListProvider');
const { runInTransaction } = require('../utils/databaseTransaction');

const VIEWER_ROLE_SET = new Set(VIEWER_ROLES);
const GUARD_ROLE = Object.freeze({
  0: ROLES.FAN_CLUB,
  1: ROLES.GOVERNOR,
  2: ROLES.ADMIRAL,
  3: ROLES.CAPTAIN
});
const ROLE_PRIORITY = Object.freeze({
  [ROLES.FAN_CLUB]: 0,
  [ROLES.CAPTAIN]: 1,
  [ROLES.ADMIRAL]: 2,
  [ROLES.GOVERNOR]: 3
});
const UID_PATTERN = /^\d{1,20}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const REASON_MAX_LENGTH = 500;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_FRESHNESS_MS = 5 * 60_000;
const DEFAULT_MANUAL_COOLDOWN_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
const EFFECTIVE_IDENTITY_FIELDS = Object.freeze([
  'target_anchor_uid',
  'target_room_id',
  'fans_medal_level',
  'fans_medal_name',
  'fans_medal_status',
  'guard_level',
  'guard_started_at',
  'guard_expires_at'
]);

function toMysql(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mysqlTimestampText(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/
  );
  if (!match) return null;
  return `${match[1]} ${match[2]}.${String(match[3] || '').padEnd(3, '0')}`;
}

function databaseIdentityTimestamp(value) {
  if (value == null || value === '') return null;
  if (!(value instanceof Date)) {
    return mysqlTimestampText(value) || toMysql(value);
  }
  const pad = (part, width = 2) => String(part).padStart(width, '0');
  return [
    `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`
  ].join(' ');
}

function effectiveIdentityState(value, { fromDatabase = false } = {}) {
  const normalizeTimestamp = fromDatabase ? databaseIdentityTimestamp : toMysql;
  return {
    target_anchor_uid: value.target_anchor_uid == null
      ? null
      : String(value.target_anchor_uid),
    target_room_id: value.target_room_id == null
      ? null
      : String(value.target_room_id),
    fans_medal_level: value.fans_medal_level == null
      ? null
      : Number(value.fans_medal_level),
    fans_medal_name: String(value.fans_medal_name || ''),
    fans_medal_status: String(value.fans_medal_status || 'unknown'),
    guard_level: value.guard_level == null ? null : Number(value.guard_level),
    guard_started_at: normalizeTimestamp(value.guard_started_at),
    guard_expires_at: normalizeTimestamp(value.guard_expires_at)
  };
}

function effectiveIdentityChanged(binding, identity, hadConfirmedIdentity) {
  if (!hadConfirmedIdentity) return true;
  const previous = effectiveIdentityState(binding, { fromDatabase: true });
  const next = effectiveIdentityState(identity);
  return EFFECTIVE_IDENTITY_FIELDS.some((field) => previous[field] !== next[field]);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function createIdentityError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function guardLevelToRole(value) {
  const level = Number(value);
  if (!Number.isInteger(level) || !Object.hasOwn(GUARD_ROLE, level)) {
    throw createIdentityError('identity_invalid_guard_level');
  }
  return GUARD_ROLE[level];
}

function highestViewerRole(bindings, now = new Date()) {
  const nowMs = now.getTime();
  let selected = ROLES.FAN_CLUB;
  for (const binding of bindings || []) {
    let candidate = guardLevelToRole(binding.guard_level == null ? 0 : binding.guard_level);
    const manualExpiresAt = toIso(binding.manual_expires_at);
    if (
      binding.manual_role
      && manualExpiresAt
      && new Date(manualExpiresAt).getTime() > nowMs
      && VIEWER_ROLE_SET.has(binding.manual_role)
      && binding.identity_sync_status !== 'success'
    ) {
      candidate = binding.manual_role;
    }
    if (ROLE_PRIORITY[candidate] > ROLE_PRIORITY[selected]) selected = candidate;
  }
  return selected;
}

function publicSyncStatus(row) {
  return {
    bilibili_uid: String(row.bilibili_uid),
    bilibili_uname: row.bilibili_uname || '',
    bilibili_face: row.bilibili_face || '',
    verified_at: toIso(row.verified_at),
    is_primary: Boolean(row.is_primary),
    target_anchor_uid: row.target_anchor_uid == null ? null : String(row.target_anchor_uid),
    target_room_id: row.target_room_id == null ? null : String(row.target_room_id),
    fans_medal_level: row.fans_medal_level == null ? null : Number(row.fans_medal_level),
    fans_medal_name: row.fans_medal_name || '',
    fans_medal_status: row.fans_medal_status || 'unknown',
    guard_level: row.guard_level == null ? null : Number(row.guard_level),
    guard_role: row.guard_level == null ? null : guardLevelToRole(row.guard_level),
    guard_started_at: toIso(row.guard_started_at),
    guard_expires_at: toIso(row.guard_expires_at),
    identity_sync_status: row.identity_sync_status || 'never',
    identity_source: row.identity_source || null,
    last_sync_attempt_at: toIso(row.last_sync_attempt_at),
    last_sync_success_at: toIso(row.last_sync_success_at),
    last_sync_error_code: row.last_sync_error_code || null,
    manual_role: row.manual_role || null,
    manual_expires_at: toIso(row.manual_expires_at),
    manual_reason: row.manual_reason || '',
    manual_created_at: toIso(row.manual_created_at)
  };
}

function safeLogger(logger, level, code, metadata = {}) {
  const method = logger?.[level] || logger?.log;
  if (typeof method !== 'function') return;
  const safe = {
    code,
    ...(metadata.user_id ? { user_id: Number(metadata.user_id) } : {}),
    ...(metadata.binding_id ? { binding_id: Number(metadata.binding_id) } : {}),
    ...(ERROR_CODE_PATTERN.test(String(metadata.error_code || ''))
      ? { error_code: metadata.error_code }
      : {})
  };
  try {
    method.call(logger, '[viewer-identity]', safe);
  } catch {
    // Logging must not affect identity decisions.
  }
}

function createViewerIdentityService({
  pool = database,
  provider = null,
  clock = () => new Date(),
  random = Math.random,
  logger = console,
  env = process.env
} = {}) {
  const identityProvider = provider || createConfiguredIdentityProvider({
    env,
    clock,
    random,
    logger
  });
  const freshnessMs = boundedInteger(
    env.VIEWER_IDENTITY_FRESHNESS_MS,
    DEFAULT_FRESHNESS_MS,
    60_000,
    24 * 60 * 60_000
  );
  const manualCooldownMs = boundedInteger(
    env.VIEWER_IDENTITY_MANUAL_COOLDOWN_MS,
    DEFAULT_MANUAL_COOLDOWN_MS,
    5_000,
    5 * 60_000
  );
  const batchSize = boundedInteger(
    env.VIEWER_IDENTITY_RECONCILE_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    500
  );

  async function resolveTarget(queryable = pool) {
    if (identityProvider.target) return validateTarget(identityProvider.target);
    const [rows] = await queryable.query(
      `SELECT setting_value
       FROM settings
       WHERE setting_key = 'bilibili_uid'
       LIMIT 1`
    );
    return validateTarget({
      anchorUid: rows[0]?.setting_value || env.BILIBILI_UID,
      roomId: env.LISTENER_ROOM_ID || env.POINTS_ROOM_ID
    });
  }

  async function audit(connection, {
    bindingId,
    targetUserId,
    bilibiliUid,
    action,
    actorUserId = null,
    actorRole = null,
    oldRole = null,
    newRole = null,
    source,
    reason = null,
    validUntil = null,
    eventKey = null
  }) {
    await connection.query(
      `INSERT INTO viewer_identity_audit (
         binding_id, target_user_id, bilibili_uid, action,
         actor_user_id, actor_role, old_role, new_role,
         source, reason, valid_until, event_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE event_key = VALUES(event_key)`,
      [
        bindingId,
        targetUserId,
        bilibiliUid,
        action,
        actorUserId,
        actorRole,
        oldRole,
        newRole,
        source,
        reason,
        validUntil,
        eventKey
      ]
    );
  }

  async function lockBindingWithUser(connection, bindingId) {
    const [references] = await connection.query(
      `SELECT user_id
       FROM user_bilibili_bindings
       WHERE id = ? AND status = 'verified'
       LIMIT 1`,
      [bindingId]
    );
    if (!references.length) throw createIdentityError('identity_binding_not_found', 404);
    const [users] = await connection.query(
      'SELECT id, role FROM users WHERE id = ? FOR UPDATE',
      [references[0].user_id]
    );
    if (!users.length) throw createIdentityError('identity_user_not_found', 404);
    const [bindings] = await connection.query(
      `SELECT *
       FROM user_bilibili_bindings
       WHERE id = ? AND status = 'verified'
       FOR UPDATE`,
      [bindingId]
    );
    if (!bindings.length) throw createIdentityError('identity_binding_not_found', 404);
    return { ...bindings[0], user_role: users[0].role };
  }

  async function recomputeUserRole(userId, queryable = null) {
    const work = async (connection) => {
      const [users] = await connection.query(
        'SELECT id, role FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      if (!users.length) throw createIdentityError('identity_user_not_found', 404);
      const currentRole = users[0].role;
      if ([ROLES.STREAMER, ROLES.ADMIN].includes(currentRole)) {
        return { protected: true, role: currentRole, changed: false };
      }
      const [bindings] = await connection.query(
        `SELECT id, bilibili_uid, guard_level, identity_sync_status,
                manual_role, manual_expires_at
         FROM user_bilibili_bindings
         WHERE user_id = ? AND status = 'verified'
         FOR UPDATE`,
        [userId]
      );
      const nextRole = highestViewerRole(bindings, clock());
      if (nextRole === currentRole) {
        return { protected: false, role: nextRole, changed: false };
      }
      await connection.query('UPDATE users SET role = ? WHERE id = ?', [nextRole, userId]);
      await audit(connection, {
        bindingId: null,
        targetUserId: userId,
        bilibiliUid: null,
        action: 'role_recomputed',
        oldRole: currentRole,
        newRole: nextRole,
        source: 'automatic'
      });
      return { protected: false, role: nextRole, changed: true, oldRole: currentRole };
    };
    return queryable ? work(queryable) : runInTransaction(pool, work);
  }

  function retryDelayMs(failureCount) {
    const exponent = Math.min(Math.max(0, failureCount - 1), 6);
    const base = Math.min(5 * 60_000, 5_000 * (2 ** exponent));
    return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25));
  }

  async function markAttempt(bindingId, { requireViewerTarget = false } = {}) {
    return runInTransaction(pool, async (connection) => {
      const binding = await lockBindingWithUser(connection, bindingId);
      if (requireViewerTarget && !VIEWER_ROLE_SET.has(binding.user_role)) {
        throw createIdentityError('identity_protected_role', 403);
      }
      const at = clock();
      // This is an async attempt generation, not a semantic identity revision.
      const version = Number(binding.identity_version || 0) + 1;
      const hadConfirmedIdentity = (
        binding.identity_sync_status === 'success'
        || binding.identity_observed_at != null
      );
      await connection.query(
        `UPDATE user_bilibili_bindings
         SET identity_sync_status = 'pending',
             last_sync_attempt_at = ?,
             identity_version = ?
         WHERE id = ?`,
        [toMysql(at), version, bindingId]
      );
      return { at, version, hadConfirmedIdentity };
    });
  }

  async function applyProviderFailure(
    bindingId,
    failure,
    attempt,
    { requireViewerTarget = false } = {}
  ) {
    return runInTransaction(pool, async (connection) => {
      const binding = await lockBindingWithUser(connection, bindingId);
      if (requireViewerTarget && !VIEWER_ROLE_SET.has(binding.user_role)) {
        throw createIdentityError('identity_protected_role', 403);
      }
      if (Number(binding.identity_version) !== attempt.version) {
        return { status: 'stale_ignored' };
      }
      const failureCount = Number(binding.sync_failure_count || 0) + 1;
      const nextSync = new Date(attempt.at.getTime() + retryDelayMs(failureCount));
      const errorCode = ERROR_CODE_PATTERN.test(String(failure.error_code || ''))
        ? failure.error_code
        : 'identity_provider_failed';
      await connection.query(
        `UPDATE user_bilibili_bindings
         SET identity_sync_status = ?,
             last_sync_error_code = ?,
             sync_failure_count = ?,
             next_sync_at = ?
         WHERE id = ?`,
        [
          failure.status === 'unavailable' ? 'unavailable' : 'failed',
          errorCode,
          failureCount,
          toMysql(nextSync),
          bindingId
        ]
      );
      await audit(connection, {
        bindingId,
        targetUserId: binding.user_id,
        bilibiliUid: binding.bilibili_uid,
        action: 'sync_failed',
        source: 'automatic',
        reason: errorCode
      });
      await recomputeUserRole(binding.user_id, connection);
      safeLogger(logger, 'warn', 'sync_failed', {
        user_id: binding.user_id,
        binding_id: bindingId,
        error_code: errorCode
      });
      return { status: failure.status, error_code: errorCode, retry_at: nextSync.toISOString() };
    });
  }

  async function applyConfirmedIdentity(
    bindingId,
    identity,
    attempt,
    { requireViewerTarget = false } = {}
  ) {
    return runInTransaction(pool, async (connection) => {
      const binding = await lockBindingWithUser(connection, bindingId);
      if (requireViewerTarget && !VIEWER_ROLE_SET.has(binding.user_role)) {
        throw createIdentityError('identity_protected_role', 403);
      }
      if (Number(binding.identity_version) !== attempt.version) {
        return { status: 'stale_ignored', role: binding.user_role };
      }
      const observedAt = new Date(identity.observed_at);
      const previousObservedAt = binding.identity_observed_at
        ? new Date(binding.identity_observed_at)
        : null;
      if (previousObservedAt && observedAt.getTime() <= previousObservedAt.getTime()) {
        return { status: 'stale_ignored', role: binding.user_role };
      }
      const hadManualFallback = Boolean(binding.manual_role);
      const identityChanged = effectiveIdentityChanged(
        binding,
        identity,
        attempt.hadConfirmedIdentity || binding.identity_observed_at != null
      );
      const expiryMs = identity.guard_expires_at
        ? new Date(identity.guard_expires_at).getTime()
        : Number.POSITIVE_INFINITY;
      const nextSyncAt = new Date(Math.min(
        attempt.at.getTime() + freshnessMs,
        expiryMs
      ));
      if (identityChanged || hadManualFallback) {
        await connection.query(
          `UPDATE user_bilibili_bindings
           SET target_anchor_uid = ?,
               target_room_id = ?,
               fans_medal_level = ?,
               fans_medal_name = ?,
               fans_medal_status = ?,
               guard_level = ?,
               guard_started_at = ?,
               guard_expires_at = ?,
               identity_sync_status = 'success',
               identity_source = ?,
               last_sync_attempt_at = ?,
               last_sync_success_at = ?,
               last_sync_error_code = NULL,
               identity_observed_at = ?,
               sync_failure_count = 0,
               next_sync_at = ?,
               manual_role = NULL,
               manual_expires_at = NULL,
               manual_actor_user_id = NULL,
               manual_reason = NULL,
               manual_overridden_at = ?
           WHERE id = ?`,
          [
            identity.target_anchor_uid,
            identity.target_room_id,
            identity.fans_medal_level,
            identity.fans_medal_name,
            identity.fans_medal_status,
            identity.guard_level,
            toMysql(identity.guard_started_at),
            toMysql(identity.guard_expires_at),
            identity.source,
            toMysql(attempt.at),
            toMysql(attempt.at),
            toMysql(observedAt),
            toMysql(nextSyncAt),
            hadManualFallback ? toMysql(attempt.at) : binding.manual_overridden_at,
            bindingId
          ]
        );
        await audit(connection, {
          bindingId,
          targetUserId: binding.user_id,
          bilibiliUid: binding.bilibili_uid,
          action: hadManualFallback ? 'manual_overridden' : 'sync_confirmed',
          oldRole: binding.user_role,
          newRole: guardLevelToRole(identity.guard_level),
          source: identity.source,
          reason: hadManualFallback ? 'automatic_sync_recovered' : null
        });
      } else {
        await connection.query(
          `UPDATE user_bilibili_bindings
           SET identity_sync_status = 'success',
               identity_source = ?,
               last_sync_attempt_at = ?,
               last_sync_success_at = ?,
               last_sync_error_code = NULL,
               identity_observed_at = ?,
               sync_failure_count = 0,
               next_sync_at = ?
           WHERE id = ?`,
          [
            identity.source,
            toMysql(attempt.at),
            toMysql(attempt.at),
            toMysql(observedAt),
            toMysql(nextSyncAt),
            bindingId
          ]
        );
      }
      const recomputed = await recomputeUserRole(binding.user_id, connection);
      return {
        status: 'success',
        role: recomputed.role,
        protected: recomputed.protected,
        guard_level: identity.guard_level
      };
    });
  }

  async function syncBinding({
    userId,
    bilibiliUid,
    transientCredentials = null,
    force = false,
    refreshSnapshot = false,
    requireViewerTarget = false
  }) {
    const uid = String(bilibiliUid || '').trim();
    if (!UID_PATTERN.test(uid)) throw createIdentityError('identity_invalid_uid');
    const [bindings] = await pool.query(
      `SELECT id, user_id, bilibili_uid, last_sync_attempt_at,
              guard_level, identity_sync_status
       FROM user_bilibili_bindings
       WHERE user_id = ? AND bilibili_uid = ? AND status = 'verified'
       LIMIT 1`,
      [userId, uid]
    );
    if (!bindings.length) throw createIdentityError('identity_binding_not_found', 404);
    const binding = bindings[0];
    const now = clock();
    if (
      !force
      && binding.last_sync_attempt_at
      && now.getTime() - new Date(binding.last_sync_attempt_at).getTime() < manualCooldownMs
    ) {
      throw createIdentityError('identity_sync_rate_limited', 429);
    }
    let target;
    try {
      target = await resolveTarget();
    } catch {
      const attempt = await markAttempt(binding.id, { requireViewerTarget });
      return applyProviderFailure(binding.id, {
        status: 'unavailable',
        error_code: 'identity_target_not_configured'
      }, attempt, { requireViewerTarget });
    }
    const attempt = await markAttempt(binding.id, { requireViewerTarget });
    let result = await identityProvider.resolveIdentity({
      uid,
      target,
      transientCredentials: identityProvider.supportsTransientCredentials === true
        ? transientCredentials
        : null,
      requested_at: attempt.at.toISOString(),
      forceRefresh: refreshSnapshot === true
    });
    if (result.status !== 'confirmed') {
      return applyProviderFailure(
        binding.id,
        result,
        attempt,
        { requireViewerTarget }
      );
    }
    const previousGuardLevel = binding.guard_level == null
      ? null
      : Number(binding.guard_level);
    const previousRolePriority = previousGuardLevel == null
      ? null
      : ROLE_PRIORITY[guardLevelToRole(previousGuardLevel)];
    const nextRolePriority = ROLE_PRIORITY[guardLevelToRole(result.guard_level)];
    const requiresDowngradeConfirmation = (
      identityProvider.supportsCompleteSnapshots === true
      && (
        result.roster_member === false
        || (
          previousRolePriority != null
          && nextRolePriority < previousRolePriority
        )
      )
    );
    if (requiresDowngradeConfirmation) {
      const confirmation = await identityProvider.confirmIdentities({
        uids: [uid],
        target,
        baseSnapshotVersion: result.snapshot_version
      });
      if (confirmation.status !== 'confirmed') {
        return applyProviderFailure(
          binding.id,
          confirmation,
          attempt,
          { requireViewerTarget }
        );
      }
      const confirmed = confirmation.identities[uid];
      if (
        !confirmed
        || Number(confirmed.guard_level) !== Number(result.guard_level)
        || confirmed.roster_member !== result.roster_member
      ) {
        return applyProviderFailure(
          binding.id,
          {
            status: 'failed',
            error_code: 'identity_downgrade_unconfirmed',
            retryable: true
          },
          attempt,
          { requireViewerTarget }
        );
      }
      result = confirmed;
    }
    return applyConfirmedIdentity(
      binding.id,
      result,
      attempt,
      { requireViewerTarget }
    );
  }

  async function syncUserBindings(userId, options = {}) {
    const [bindings] = await pool.query(
      `SELECT bilibili_uid
       FROM user_bilibili_bindings
       WHERE user_id = ? AND status = 'verified'
       ORDER BY id`,
      [userId]
    );
    const results = [];
    for (const binding of bindings) {
      try {
        results.push(await syncBinding({
          userId,
          bilibiliUid: binding.bilibili_uid,
          force: options.force === true
        }));
      } catch (error) {
        results.push({ status: 'failed', error_code: error.code || 'identity_sync_failed' });
      }
    }
    await recomputeUserRole(userId);
    return results;
  }

  async function refreshUserIfStale(userId) {
    const cutoff = toMysql(new Date(clock().getTime() - freshnessMs));
    const [rows] = await pool.query(
      `SELECT 1
       FROM user_bilibili_bindings
       WHERE user_id = ? AND status = 'verified'
         AND (last_sync_success_at IS NULL OR last_sync_success_at <= ?)
       LIMIT 1`,
      [userId, cutoff]
    );
    if (!rows.length) return { status: 'fresh' };
    await syncUserBindings(userId, { force: true });
    return { status: 'scheduled' };
  }

  async function observeTrustedGuardEvent(event, { connection } = {}) {
    if (
      event?.event_type !== 'guard_buy'
      || event.mode !== 'live'
      || !event.actor?.open_id
    ) {
      return { status: 'ignored', reason: 'identity_event_not_applicable' };
    }
    if (identityProvider.supportsReconciliation !== true) {
      return { status: 'ignored', reason: 'identity_reconciliation_unavailable' };
    }
    let target;
    try {
      target = await resolveTarget(connection || pool);
    } catch {
      return { status: 'ignored', reason: 'identity_target_not_configured' };
    }
    if (String(event.room_id) !== target.roomId) {
      return { status: 'ignored', reason: 'identity_target_mismatch' };
    }
    if (identityProvider.supportsListenerIdentityMapping !== true) {
      return { status: 'ignored', reason: 'identity_listener_mapping_unavailable' };
    }
    const work = async (queryable) => {
      const [references] = await queryable.query(
        `SELECT id
         FROM user_bilibili_bindings
         WHERE bilibili_open_id = ? AND status = 'verified'
         LIMIT 1`,
        [event.actor.open_id]
      );
      if (!references.length) {
        return { status: 'ignored', reason: 'identity_open_id_unmapped' };
      }
      const binding = await lockBindingWithUser(queryable, references[0].id);
      if (binding.bilibili_open_id !== event.actor.open_id) {
        return { status: 'ignored', reason: 'identity_open_id_unmapped' };
      }
      const observedAt = new Date(event.occurred_at);
      if (
        binding.identity_observed_at
        && observedAt.getTime() <= new Date(binding.identity_observed_at).getTime()
      ) {
        return { status: 'ignored', reason: 'identity_stale_event' };
      }
      const guardLevel = Number(event.payload.guard_level);
      guardLevelToRole(guardLevel);
      await queryable.query(
        `UPDATE user_bilibili_bindings
         SET target_anchor_uid = ?,
             target_room_id = ?,
             guard_level = ?,
             identity_sync_status = 'success',
             identity_source = 'official_listener',
             last_sync_attempt_at = ?,
             last_sync_success_at = ?,
             last_sync_error_code = NULL,
             identity_observed_at = ?,
             sync_failure_count = 0,
             next_sync_at = ?,
             manual_role = NULL,
             manual_expires_at = NULL,
             manual_actor_user_id = NULL,
             manual_reason = NULL,
              manual_overridden_at = ?
         WHERE id = ?`,
        [
          target.anchorUid,
          target.roomId,
          guardLevel,
          toMysql(observedAt),
          toMysql(observedAt),
          toMysql(observedAt),
          toMysql(new Date(clock().getTime() + freshnessMs)),
          binding.manual_role ? toMysql(clock()) : binding.manual_overridden_at,
          binding.id
        ]
      );
      await audit(queryable, {
        bindingId: binding.id,
        targetUserId: binding.user_id,
        bilibiliUid: binding.bilibili_uid,
        action: binding.manual_role ? 'manual_overridden' : 'listener_confirmed',
        oldRole: binding.user_role,
        newRole: guardLevelToRole(guardLevel),
        source: 'official_listener',
        eventKey: event.event_id
      });
      const recomputed = await recomputeUserRole(binding.user_id, queryable);
      return { status: 'updated', role: recomputed.role };
    };
    return connection ? work(connection) : runInTransaction(pool, work);
  }

  async function listIdentityUsers() {
    const [users] = await pool.query(
      `SELECT id, username, role
       FROM users
       ORDER BY id DESC`
    );
    const [bindings] = await pool.query(
      `SELECT *
       FROM user_bilibili_bindings
       WHERE status = 'verified'
       ORDER BY user_id, is_primary DESC, verified_at`
    );
    const byUser = new Map();
    for (const binding of bindings) {
      const list = byUser.get(Number(binding.user_id)) || [];
      list.push(publicSyncStatus(binding));
      byUser.set(Number(binding.user_id), list);
    }
    return users.map((user) => ({
      ...user,
      protected_role: [ROLES.STREAMER, ROLES.ADMIN].includes(user.role),
      bindings: byUser.get(Number(user.id)) || []
    }));
  }

  async function listAudit(targetUserId) {
    const [rows] = await pool.query(
      `SELECT id, binding_id, target_user_id, bilibili_uid, action,
              actor_user_id, actor_role, old_role, new_role,
              source, reason, valid_until, created_at
       FROM viewer_identity_audit
       WHERE target_user_id = ?
       ORDER BY id DESC
       LIMIT 100`,
      [targetUserId]
    );
    return rows.map((row) => ({
      ...row,
      bilibili_uid: row.bilibili_uid == null ? null : String(row.bilibili_uid),
      valid_until: toIso(row.valid_until),
      created_at: toIso(row.created_at)
    }));
  }

  async function setManualFallback({
    actorUserId,
    actorRole,
    targetUserId,
    bilibiliUid,
    role,
    reason,
    expiresAt
  }) {
    if (!VIEWER_ROLE_SET.has(role)) throw createIdentityError('identity_invalid_fallback_role');
    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason || normalizedReason.length > REASON_MAX_LENGTH) {
      throw createIdentityError('identity_invalid_fallback_reason');
    }
    const expiry = role === ROLES.FAN_CLUB ? null : new Date(expiresAt);
    if (role !== ROLES.FAN_CLUB && (
      !expiresAt
      || Number.isNaN(expiry.getTime())
      || expiry.getTime() <= clock().getTime()
    )) {
      throw createIdentityError('identity_fallback_expiry_required');
    }
    return runInTransaction(pool, async (connection) => {
      const [users] = await connection.query(
        'SELECT id, role FROM users WHERE id = ? FOR UPDATE',
        [targetUserId]
      );
      if (!users.length) throw createIdentityError('identity_user_not_found', 404);
      if (!VIEWER_ROLE_SET.has(users[0].role)) {
        throw createIdentityError('identity_protected_role', 403);
      }
      const [rows] = await connection.query(
        `SELECT *
         FROM user_bilibili_bindings
         WHERE user_id = ? AND bilibili_uid = ? AND status = 'verified'
         FOR UPDATE`,
        [targetUserId, String(bilibiliUid || '').trim()]
      );
      if (!rows.length) throw createIdentityError('identity_binding_not_found', 404);
      const binding = rows[0];
      if (binding.identity_sync_status === 'success') {
        throw createIdentityError('identity_automatic_classification_active', 409);
      }
      if (
        binding.manual_actor_user_id
        && Number(binding.manual_actor_user_id) !== Number(actorUserId)
        && !isAdminRole(actorRole)
      ) {
        throw createIdentityError('identity_fallback_owned_by_another_operator', 403);
      }
      await connection.query(
        `UPDATE user_bilibili_bindings
         SET manual_role = ?,
             manual_expires_at = ?,
             manual_actor_user_id = ?,
             manual_reason = ?,
             manual_created_at = ?,
             identity_source = 'manual_fallback'
         WHERE id = ?`,
        [
          role,
          toMysql(expiry),
          actorUserId,
          normalizedReason,
          toMysql(clock()),
          binding.id
        ]
      );
      await audit(connection, {
        bindingId: binding.id,
        targetUserId,
        bilibiliUid: binding.bilibili_uid,
        action: binding.manual_role ? 'manual_updated' : 'manual_created',
        actorUserId,
        actorRole,
        oldRole: users[0].role,
        newRole: role,
        source: 'manual_fallback',
        reason: normalizedReason,
        validUntil: toMysql(expiry)
      });
      const recomputed = await recomputeUserRole(targetUserId, connection);
      return { status: 'updated', role: recomputed.role };
    });
  }

  async function revokeManualFallback({
    actorUserId,
    actorRole,
    targetUserId,
    bilibiliUid
  }) {
    return runInTransaction(pool, async (connection) => {
      const [users] = await connection.query(
        'SELECT id, role FROM users WHERE id = ? FOR UPDATE',
        [targetUserId]
      );
      if (!users.length) throw createIdentityError('identity_user_not_found', 404);
      if (!VIEWER_ROLE_SET.has(users[0].role)) {
        throw createIdentityError('identity_protected_role', 403);
      }
      const [rows] = await connection.query(
        `SELECT *
         FROM user_bilibili_bindings
         WHERE user_id = ? AND bilibili_uid = ? AND status = 'verified'
         FOR UPDATE`,
        [targetUserId, String(bilibiliUid || '').trim()]
      );
      if (!rows.length) throw createIdentityError('identity_binding_not_found', 404);
      const binding = rows[0];
      if (!binding.manual_role) throw createIdentityError('identity_fallback_not_found', 404);
      if (
        Number(binding.manual_actor_user_id) !== Number(actorUserId)
        && !isAdminRole(actorRole)
      ) {
        throw createIdentityError('identity_fallback_owned_by_another_operator', 403);
      }
      await connection.query(
        `UPDATE user_bilibili_bindings
         SET manual_role = NULL,
             manual_expires_at = NULL,
             manual_actor_user_id = NULL,
             manual_reason = NULL,
             manual_overridden_at = ?
         WHERE id = ?`,
        [toMysql(clock()), binding.id]
      );
      await audit(connection, {
        bindingId: binding.id,
        targetUserId,
        bilibiliUid: binding.bilibili_uid,
        action: 'manual_revoked',
        actorUserId,
        actorRole,
        oldRole: users[0].role,
        newRole: ROLES.FAN_CLUB,
        source: 'manual_fallback'
      });
      const recomputed = await recomputeUserRole(targetUserId, connection);
      return { status: 'revoked', role: recomputed.role };
    });
  }

  async function expireManualFallbacks() {
    const now = clock();
    const [rows] = await pool.query(
      `SELECT id, user_id, bilibili_uid
       FROM user_bilibili_bindings
       WHERE status = 'verified'
         AND manual_role IS NOT NULL
         AND manual_expires_at IS NOT NULL
         AND manual_expires_at <= ?
       ORDER BY manual_expires_at, id
       LIMIT ?`,
      [toMysql(now), batchSize]
    );
    for (const row of rows) {
      try {
        await syncBinding({
          userId: row.user_id,
          bilibiliUid: row.bilibili_uid,
          force: true
        });
      } catch {
        // The fallback still expires even when automatic confirmation is unavailable.
      }
      await runInTransaction(pool, async (connection) => {
        const [current] = await connection.query(
          `SELECT *
           FROM user_bilibili_bindings
           WHERE id = ? AND manual_role IS NOT NULL
             AND manual_expires_at <= ?
           FOR UPDATE`,
          [row.id, toMysql(now)]
        );
        if (!current.length) return;
        await connection.query(
          `UPDATE user_bilibili_bindings
           SET manual_role = NULL,
               manual_expires_at = NULL,
               manual_actor_user_id = NULL,
               manual_reason = NULL,
               manual_overridden_at = ?,
               guard_level = 0
           WHERE id = ?`,
          [toMysql(now), row.id]
        );
        await audit(connection, {
          bindingId: row.id,
          targetUserId: row.user_id,
          bilibiliUid: row.bilibili_uid,
          action: 'manual_expired',
          source: 'automatic',
          newRole: ROLES.FAN_CLUB
        });
        await recomputeUserRole(row.user_id, connection);
      });
    }
    return rows.length;
  }

  async function reconcileDue() {
    await expireManualFallbacks();
    if (identityProvider.supportsReconciliation !== true) {
      return [{ status: 'unavailable', error_code: 'identity_source_not_configured' }];
    }
    const [rows] = await pool.query(
      `SELECT user_id, bilibili_uid
       FROM user_bilibili_bindings
       WHERE status = 'verified'
         AND (next_sync_at IS NULL OR next_sync_at <= ?)
       ORDER BY COALESCE(next_sync_at, verified_at), id
       LIMIT ?`,
      [toMysql(clock()), batchSize]
    );
    const results = [];
    for (const row of rows) {
      try {
        results.push(await syncBinding({
          userId: row.user_id,
          bilibiliUid: row.bilibili_uid,
          force: true
        }));
      } catch (error) {
        results.push({ status: 'failed', error_code: error.code || 'identity_sync_failed' });
      }
    }
    return results;
  }

  function scheduleReconciliation() {
    const intervalMs = boundedInteger(
      env.VIEWER_IDENTITY_RECONCILE_INTERVAL_MS,
      DEFAULT_RECONCILE_INTERVAL_MS,
      30_000,
      5 * 60_000
    );
    const run = () => reconcileDue().catch((error) => {
      safeLogger(logger, 'error', 'reconcile_failed', {
        error_code: ERROR_CODE_PATTERN.test(String(error?.code || ''))
          ? error.code
          : 'identity_reconcile_failed'
      });
    });
    const initial = setTimeout(run, 1_000);
    initial.unref?.();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    return {
      stop() {
        clearTimeout(initial);
        clearInterval(timer);
      },
      intervalMs
    };
  }

  return {
    permission: PERMISSIONS.VIEWER_IDENTITY_MANAGE,
    provider: identityProvider,
    expireManualFallbacks,
    highestViewerRole,
    listAudit,
    listIdentityUsers,
    observeTrustedGuardEvent,
    publicSyncStatus,
    reconcileDue,
    recomputeUserRole,
    refreshUserIfStale,
    revokeManualFallback,
    scheduleReconciliation,
    setManualFallback,
    syncBinding,
    syncUserBindings
  };
}

const defaultViewerIdentityService = createViewerIdentityService();

module.exports = {
  GUARD_ROLE,
  ROLE_PRIORITY,
  createIdentityError,
  createViewerIdentityService,
  defaultViewerIdentityService,
  guardLevelToRole,
  highestViewerRole,
  publicSyncStatus
};
