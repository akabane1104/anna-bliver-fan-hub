const CONFIRMED_STATUS = 'confirmed';
const FAILURE_STATUSES = new Set(['failed', 'unavailable']);
const GUARD_LEVELS = new Set([0, 1, 2, 3]);
const MEDAL_STATUSES = new Set(['unknown', 'active', 'inactive']);
const SOURCE_PATTERN = /^(?:transient_qr|server_provider)$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UID_PATTERN = /^\d{1,20}$/;

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('identity_invalid_timestamp');
  return parsed.toISOString();
}

function validateTarget(target) {
  const anchorUid = String(target?.anchorUid || '').trim();
  const roomId = String(target?.roomId || '').trim();
  if (!UID_PATTERN.test(anchorUid) || !UID_PATTERN.test(roomId)) {
    throw new Error('identity_target_not_configured');
  }
  return { anchorUid, roomId };
}

function validateConfirmedIdentity(value, { uid, target }) {
  const expectedUid = String(uid || '').trim();
  const expectedTarget = validateTarget(target);
  if (!value || value.status !== CONFIRMED_STATUS || value.complete !== true) {
    throw new Error('identity_incomplete_response');
  }
  if (String(value.uid || '').trim() !== expectedUid) {
    throw new Error('identity_uid_mismatch');
  }
  if (
    String(value.target_anchor_uid || '').trim() !== expectedTarget.anchorUid
    || String(value.target_room_id || '').trim() !== expectedTarget.roomId
  ) {
    throw new Error('identity_target_mismatch');
  }
  const guardLevel = Number(value.guard_level);
  if (!Number.isInteger(guardLevel) || !GUARD_LEVELS.has(guardLevel)) {
    throw new Error('identity_invalid_guard_level');
  }
  const medalLevel = value.fans_medal_level == null
    ? null
    : Number(value.fans_medal_level);
  if (
    medalLevel != null
    && (!Number.isInteger(medalLevel) || medalLevel < 0 || medalLevel > 1000)
  ) {
    throw new Error('identity_invalid_medal_level');
  }
  const medalStatus = String(value.fans_medal_status || 'unknown');
  if (!MEDAL_STATUSES.has(medalStatus)) {
    throw new Error('identity_invalid_medal_status');
  }
  const source = String(value.source || '');
  if (!SOURCE_PATTERN.test(source)) throw new Error('identity_invalid_source');
  const snapshotTotal = value.snapshot_total == null
    ? null
    : Number(value.snapshot_total);
  if (
    snapshotTotal != null
    && (!Number.isInteger(snapshotTotal) || snapshotTotal < 0)
  ) {
    throw new Error('identity_invalid_snapshot_total');
  }
  if (
    value.roster_member != null
    && typeof value.roster_member !== 'boolean'
  ) {
    throw new Error('identity_invalid_roster_member');
  }
  return Object.freeze({
    status: CONFIRMED_STATUS,
    complete: true,
    uid: expectedUid,
    target_anchor_uid: expectedTarget.anchorUid,
    target_room_id: expectedTarget.roomId,
    fans_medal_level: medalLevel,
    fans_medal_name: String(value.fans_medal_name || '').trim().slice(0, 100),
    fans_medal_status: medalStatus,
    guard_level: guardLevel,
    guard_started_at: isoOrNull(value.guard_started_at),
    guard_expires_at: isoOrNull(value.guard_expires_at),
    observed_at: isoOrNull(value.observed_at) || new Date().toISOString(),
    snapshot_version: isoOrNull(value.snapshot_version),
    snapshot_total: snapshotTotal,
    roster_member: value.roster_member === true,
    source
  });
}

function normalizeFailure(value) {
  const status = FAILURE_STATUSES.has(value?.status) ? value.status : 'failed';
  const errorCode = String(value?.error_code || 'identity_provider_failed');
  return Object.freeze({
    status,
    error_code: ERROR_CODE_PATTERN.test(errorCode)
      ? errorCode
      : 'identity_provider_failed',
    retryable: value?.retryable !== false
  });
}

function createUnavailableIdentityProvider({
  errorCode = 'identity_source_not_configured'
} = {}) {
  return Object.freeze({
    name: 'unavailable',
    supportsTransientCredentials: false,
    supportsReconciliation: false,
    supportsCompleteSnapshots: false,
    supportsListenerIdentityMapping: false,
    async resolveIdentity() {
      return Object.freeze({
        status: 'unavailable',
        error_code: ERROR_CODE_PATTERN.test(errorCode)
          ? errorCode
          : 'identity_source_not_configured',
        retryable: true
      });
    }
  });
}

function createIdentityProvider({
  resolveIdentity,
  name = 'configured',
  supportsTransientCredentials = false,
  supportsReconciliation = false,
  supportsListenerIdentityMapping = false
} = {}) {
  if (typeof resolveIdentity !== 'function') return createUnavailableIdentityProvider();
  return Object.freeze({
    name,
    supportsTransientCredentials: supportsTransientCredentials === true,
    supportsReconciliation: supportsReconciliation === true,
    supportsCompleteSnapshots: false,
    supportsListenerIdentityMapping: supportsListenerIdentityMapping === true,
    async resolveIdentity(input) {
      let value;
      try {
        value = await resolveIdentity(input);
      } catch (error) {
        return normalizeFailure({
          status: 'failed',
          error_code: error?.code,
          retryable: true
        });
      }
      if (value?.status !== CONFIRMED_STATUS) return normalizeFailure(value);
      try {
        return validateConfirmedIdentity(value, input);
      } catch (error) {
        return normalizeFailure({
          status: 'failed',
          error_code: error.message,
          retryable: false
        });
      }
    }
  });
}

module.exports = {
  CONFIRMED_STATUS,
  createIdentityProvider,
  createUnavailableIdentityProvider,
  normalizeFailure,
  validateConfirmedIdentity,
  validateTarget
};
