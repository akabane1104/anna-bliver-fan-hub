const axios = require('axios');
const {
  createUnavailableIdentityProvider,
  normalizeFailure,
  validateConfirmedIdentity,
  validateTarget
} = require('./bilibiliIdentityProvider');

const PROVIDER_NAME = 'guard_tab_top_list';
const PROVIDER_SOURCE = 'server_provider';
const ENDPOINT =
  'https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList';
const UID_PATTERN = /^\d{1,20}$/;
const GUARD_LEVELS = new Set([1, 2, 3]);
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function providerError(code, { retryable = false, retryAfterMs = null } = {}) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function strictInteger(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === '' || value == null) throw providerError(code);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw providerError(code);
  }
  return parsed;
}

function isTrue(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function safeLogger(logger, level, code, metadata = {}) {
  const method = logger?.[level] || logger?.log;
  if (typeof method !== 'function') return;
  const safe = {
    provider: PROVIDER_NAME,
    code,
    ...(UID_PATTERN.test(String(metadata.room_id || ''))
      ? { room_id: String(metadata.room_id) }
      : {}),
    ...(Number.isInteger(metadata.page) ? { page: metadata.page } : {}),
    ...(Number.isInteger(metadata.result_count)
      ? { result_count: metadata.result_count }
      : {}),
    ...(ERROR_CODE_PATTERN.test(String(metadata.error_code || ''))
      ? { error_code: metadata.error_code }
      : {})
  };
  try {
    method.call(logger, '[viewer-identity-provider]', safe);
  } catch {
    // Logging must never affect identity decisions.
  }
}

function parseRetryAfterMs(headers, now = Date.now()) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(String(raw));
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

function normalizeMedal(raw, target) {
  const unknown = {
    fans_medal_level: null,
    fans_medal_name: '',
    fans_medal_status: 'unknown',
    medal_target_confirmed: false
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown;

  const targetId = String(raw.target_id ?? '').trim();
  const roomId = String(raw.anchor_roomid ?? '').trim();
  if (targetId !== target.anchorUid || roomId !== target.roomId) return unknown;

  const level = raw.medal_level == null
    ? null
    : strictInteger(
      raw.medal_level,
      'identity_malformed_response',
      { min: 0, max: 1000 }
    );
  const name = typeof raw.medal_name === 'string'
    ? raw.medal_name.trim().slice(0, 100)
    : '';
  const wearing = raw.fans_medal_wearing_status ?? raw.medal_wearing_status;
  let status = 'unknown';
  if (wearing != null) {
    const normalized = strictInteger(
      wearing,
      'identity_malformed_response',
      { min: 0, max: 1 }
    );
    status = normalized === 1 ? 'active' : 'inactive';
  }
  return {
    fans_medal_level: level,
    fans_medal_name: name,
    fans_medal_status: status,
    medal_target_confirmed: true
  };
}

function normalizeEntry(raw, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw providerError('identity_malformed_response');
  }
  const uid = String(raw.uid ?? '').trim();
  if (!UID_PATTERN.test(uid)) throw providerError('identity_malformed_response');
  const guardLevel = strictInteger(
    raw.guard_level,
    'identity_malformed_response',
    { min: 1, max: 3 }
  );
  if (!GUARD_LEVELS.has(guardLevel)) {
    throw providerError('identity_invalid_guard_level');
  }
  return {
    uid,
    guard_level: guardLevel,
    ...normalizeMedal(raw.medal_info, target)
  };
}

function parseGuardTabPage(response, { requestedPage, target }) {
  const status = Number(response?.status);
  if (status === 429) {
    throw providerError('identity_rate_limited', {
      retryable: true,
      retryAfterMs: parseRetryAfterMs(response.headers)
    });
  }
  if (status >= 500 && status <= 599) {
    throw providerError('identity_upstream_5xx', { retryable: true });
  }
  if (status !== 200) {
    throw providerError('identity_upstream_http_error', { retryable: status >= 400 });
  }

  const body = response.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw providerError('identity_malformed_response');
  }
  if (Number(body.code) !== 0) {
    throw providerError('identity_upstream_rejected', { retryable: true });
  }
  const data = body.data;
  const info = data?.info;
  if (
    !data
    || typeof data !== 'object'
    || !info
    || typeof info !== 'object'
    || !Array.isArray(data.list)
    || !Array.isArray(data.top3)
  ) {
    throw providerError('identity_malformed_response');
  }

  const totalCount = strictInteger(
    info.num,
    'identity_malformed_response',
    { min: 0, max: 1_000_000 }
  );
  const totalPages = strictInteger(
    info.page,
    'identity_malformed_response',
    { min: 0, max: 100_000 }
  );
  const currentPage = strictInteger(
    info.now,
    'identity_malformed_response',
    { min: 1, max: 100_000 }
  );
  if (currentPage !== requestedPage) {
    throw providerError('identity_incomplete_pagination');
  }
  return {
    totalCount,
    totalPages,
    currentPage,
    list: data.list.map((item) => normalizeEntry(item, target)),
    top3: data.top3.map((item) => normalizeEntry(item, target))
  };
}

function mergeEntry(entries, candidate) {
  const existing = entries.get(candidate.uid);
  if (!existing) {
    entries.set(candidate.uid, candidate);
    return;
  }
  if (existing.guard_level !== candidate.guard_level) {
    throw providerError('identity_conflicting_guard_level');
  }
  if (
    existing.medal_target_confirmed
    && candidate.medal_target_confirmed
    && (
      existing.fans_medal_level !== candidate.fans_medal_level
      || existing.fans_medal_name !== candidate.fans_medal_name
      || existing.fans_medal_status !== candidate.fans_medal_status
    )
  ) {
    throw providerError('identity_conflicting_medal');
  }
  if (!existing.medal_target_confirmed && candidate.medal_target_confirmed) {
    entries.set(candidate.uid, candidate);
  }
}

function classifyThrownError(error) {
  if (ERROR_CODE_PATTERN.test(String(error?.code || '')) && error.code.startsWith('identity_')) {
    return error;
  }
  if (
    error?.code === 'ECONNABORTED'
    || error?.code === 'ETIMEDOUT'
    || error?.name === 'AbortError'
  ) {
    return providerError('identity_timeout', { retryable: true });
  }
  if (
    ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND']
      .includes(error?.code)
  ) {
    return providerError('identity_network_error', { retryable: true });
  }
  return providerError('identity_provider_failed', { retryable: true });
}

function createGuardTabTopListProvider({
  env = process.env,
  target,
  httpGet = (url, options) => axios.get(url, options),
  clock = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  logger = console,
  enabled = () => true,
  config = {}
} = {}) {
  const providerTarget = validateTarget(target);
  const pageSize = boundedInteger(
    config.pageSize ?? env.VIEWER_IDENTITY_GUARD_PAGE_SIZE,
    29,
    1,
    100
  );
  const maxPages = boundedInteger(
    config.maxPages ?? env.VIEWER_IDENTITY_GUARD_MAX_PAGES,
    500,
    1,
    5000
  );
  const timeoutMs = boundedInteger(
    config.timeoutMs ?? env.VIEWER_IDENTITY_HTTP_TIMEOUT_MS,
    5000,
    500,
    30_000
  );
  const maxRetries = boundedInteger(
    config.maxRetries ?? env.VIEWER_IDENTITY_HTTP_MAX_RETRIES,
    2,
    0,
    5
  );
  const retryBaseMs = boundedInteger(
    config.retryBaseMs ?? env.VIEWER_IDENTITY_HTTP_RETRY_BASE_MS,
    500,
    10,
    10_000
  );
  const maxRetryAfterMs = boundedInteger(
    config.maxRetryAfterMs ?? env.VIEWER_IDENTITY_HTTP_MAX_RETRY_AFTER_MS,
    5 * 60_000,
    1000,
    15 * 60_000
  );
  const cacheMs = boundedInteger(
    config.cacheMs ?? env.VIEWER_IDENTITY_SNAPSHOT_CACHE_MS,
    4 * 60_000,
    1000,
    5 * 60_000
  );
  const confirmationDelayMs = boundedInteger(
    config.confirmationDelayMs ?? env.VIEWER_IDENTITY_DOWNGRADE_CONFIRM_DELAY_MS,
    1000,
    10,
    30_000
  );

  let cached = null;
  let inFlight = null;
  let lastSnapshotTime = 0;
  const confirmationCache = new Map();
  const confirmationFlights = new Map();

  function nextSnapshotVersion() {
    const current = new Date(clock()).getTime();
    if (!Number.isFinite(current)) throw providerError('identity_invalid_timestamp');
    lastSnapshotTime = Math.max(current, lastSnapshotTime + 1);
    return new Date(lastSnapshotTime).toISOString();
  }

  function retryDelay(error, attempt) {
    if (error.retryAfterMs != null) {
      if (error.retryAfterMs > maxRetryAfterMs) return null;
      return error.retryAfterMs;
    }
    const exponential = retryBaseMs * (2 ** attempt);
    const jitter = exponential * Math.max(0, Math.min(1, random())) * 0.25;
    return Math.round(exponential + jitter);
  }

  async function requestPage(page) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await httpGet(ENDPOINT, {
          params: {
            roomid: providerTarget.roomId,
            ruid: providerTarget.anchorUid,
            page,
            page_size: pageSize
          },
          timeout: timeoutMs,
          maxRedirects: 0,
          responseType: 'json',
          validateStatus: () => true,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'anna-bliver-fan-hub/1.0'
          }
        });
        return parseGuardTabPage(response, {
          requestedPage: page,
          target: providerTarget
        });
      } catch (rawError) {
        const error = classifyThrownError(rawError);
        lastError = error;
        const delay = retryDelay(error, attempt);
        if (!error.retryable || attempt >= maxRetries || delay == null) break;
        safeLogger(logger, 'warn', 'page_retry', {
          room_id: providerTarget.roomId,
          page,
          error_code: error.code
        });
        await sleep(delay);
      }
    }
    throw lastError || providerError('identity_provider_failed', { retryable: true });
  }

  async function fetchCompleteSnapshot() {
    if (!enabled()) throw providerError('identity_source_not_configured', { retryable: true });
    const first = await requestPage(1);
    if (first.totalPages > maxPages) {
      throw providerError('identity_incomplete_pagination');
    }
    const entries = new Map();
    for (const item of [...first.top3, ...first.list]) mergeEntry(entries, item);

    const finalPage = Math.max(1, first.totalPages);
    for (let page = 2; page <= finalPage; page += 1) {
      const current = await requestPage(page);
      if (
        current.totalCount !== first.totalCount
        || current.totalPages !== first.totalPages
      ) {
        throw providerError('identity_incomplete_pagination');
      }
      for (const item of [...current.top3, ...current.list]) {
        mergeEntry(entries, item);
      }
    }
    if (entries.size !== first.totalCount) {
      throw providerError('identity_incomplete_pagination');
    }
    const snapshot = Object.freeze({
      target: providerTarget,
      version: nextSnapshotVersion(),
      totalCount: first.totalCount,
      totalPages: first.totalPages,
      entries
    });
    safeLogger(logger, 'info', 'snapshot_complete', {
      room_id: providerTarget.roomId,
      result_count: snapshot.totalCount
    });
    return snapshot;
  }

  async function getSnapshot({ forceRefresh = false } = {}) {
    if (!enabled()) throw providerError('identity_source_not_configured', { retryable: true });
    const now = new Date(clock()).getTime();
    if (
      !forceRefresh
      && cached
      && now - cached.cachedAt < cacheMs
    ) {
      return cached.snapshot;
    }
    if (inFlight) return inFlight;
    const pending = fetchCompleteSnapshot();
    inFlight = pending;
    try {
      const snapshot = await pending;
      cached = { snapshot, cachedAt: new Date(clock()).getTime() };
      confirmationCache.clear();
      return snapshot;
    } finally {
      if (inFlight === pending) inFlight = null;
    }
  }

  async function getConfirmationSnapshot(baseVersion) {
    if (!cached || cached.snapshot.version !== baseVersion) {
      throw providerError('identity_snapshot_stale', { retryable: true });
    }
    if (confirmationCache.has(baseVersion)) {
      return confirmationCache.get(baseVersion);
    }
    if (confirmationFlights.has(baseVersion)) {
      return confirmationFlights.get(baseVersion);
    }
    const pending = (async () => {
      const jitter = confirmationDelayMs * Math.max(0, Math.min(1, random())) * 0.25;
      await sleep(Math.round(confirmationDelayMs + jitter));
      const snapshot = await fetchCompleteSnapshot();
      confirmationCache.set(baseVersion, snapshot);
      return snapshot;
    })();
    confirmationFlights.set(baseVersion, pending);
    try {
      return await pending;
    } finally {
      confirmationFlights.delete(baseVersion);
    }
  }

  function identityFromSnapshot(snapshot, uid) {
    const normalizedUid = String(uid || '').trim();
    if (!UID_PATTERN.test(normalizedUid)) {
      throw providerError('identity_invalid_uid');
    }
    const member = snapshot.entries.get(normalizedUid);
    return validateConfirmedIdentity({
      status: 'confirmed',
      complete: true,
      uid: normalizedUid,
      target_anchor_uid: providerTarget.anchorUid,
      target_room_id: providerTarget.roomId,
      fans_medal_level: member?.fans_medal_level ?? null,
      fans_medal_name: member?.fans_medal_name || '',
      fans_medal_status: member?.fans_medal_status || 'unknown',
      guard_level: member?.guard_level ?? 0,
      guard_started_at: null,
      guard_expires_at: null,
      observed_at: snapshot.version,
      snapshot_version: snapshot.version,
      snapshot_total: snapshot.totalCount,
      roster_member: Boolean(member),
      source: PROVIDER_SOURCE
    }, {
      uid: normalizedUid,
      target: providerTarget
    });
  }

  async function resolveIdentities({ uids, forceRefresh = false } = {}) {
    try {
      const snapshot = await getSnapshot({ forceRefresh });
      const identities = {};
      for (const uid of uids || []) {
        const normalizedUid = String(uid || '').trim();
        identities[normalizedUid] = identityFromSnapshot(snapshot, normalizedUid);
      }
      return Object.freeze({
        status: 'confirmed',
        complete: true,
        snapshot_version: snapshot.version,
        snapshot_total: snapshot.totalCount,
        identities: Object.freeze(identities)
      });
    } catch (error) {
      return normalizeFailure({
        status: error?.code === 'identity_source_not_configured'
          ? 'unavailable'
          : 'failed',
        error_code: error?.code,
        retryable: error?.retryable !== false
      });
    }
  }

  async function confirmIdentities({ uids, baseSnapshotVersion } = {}) {
    try {
      const snapshot = await getConfirmationSnapshot(baseSnapshotVersion);
      const identities = {};
      for (const uid of uids || []) {
        const normalizedUid = String(uid || '').trim();
        identities[normalizedUid] = identityFromSnapshot(snapshot, normalizedUid);
      }
      return Object.freeze({
        status: 'confirmed',
        complete: true,
        snapshot_version: snapshot.version,
        snapshot_total: snapshot.totalCount,
        identities: Object.freeze(identities)
      });
    } catch (error) {
      return normalizeFailure({
        status: error?.code === 'identity_source_not_configured'
          ? 'unavailable'
          : 'failed',
        error_code: error?.code,
        retryable: error?.retryable !== false
      });
    }
  }

  async function readSafeSnapshotSummary({ forceRefresh = true } = {}) {
    try {
      const snapshot = await getSnapshot({ forceRefresh });
      const guardLevels = { 1: 0, 2: 0, 3: 0 };
      for (const item of snapshot.entries.values()) {
        guardLevels[item.guard_level] += 1;
      }
      return Object.freeze({
        status: 'confirmed',
        complete: true,
        page_count: snapshot.totalPages,
        unique_uid_count: snapshot.entries.size,
        guard_level_counts: Object.freeze(guardLevels)
      });
    } catch (error) {
      return normalizeFailure({
        status: error?.code === 'identity_source_not_configured'
          ? 'unavailable'
          : 'failed',
        error_code: error?.code,
        retryable: error?.retryable !== false
      });
    }
  }

  return Object.freeze({
    name: PROVIDER_NAME,
    target: providerTarget,
    supportsTransientCredentials: false,
    supportsCompleteSnapshots: true,
    supportsListenerIdentityMapping: false,
    get supportsReconciliation() {
      return enabled();
    },
    async resolveIdentity(input = {}) {
      const result = await resolveIdentities({
        uids: [input.uid],
        forceRefresh: input.forceRefresh === true
      });
      return result.status === 'confirmed'
        ? result.identities[String(input.uid || '').trim()]
        : result;
    },
    resolveIdentities,
    confirmIdentities,
    readSafeSnapshotSummary,
    invalidateCache() {
      cached = null;
      confirmationCache.clear();
    }
  });
}

function createConfiguredIdentityProvider({
  env = process.env,
  httpGet,
  clock,
  sleep,
  random,
  logger
} = {}) {
  if (String(env.VIEWER_IDENTITY_PROVIDER || '').trim() !== PROVIDER_NAME) {
    return createUnavailableIdentityProvider();
  }
  if (isTrue(env.VIEWER_IDENTITY_PROVIDER_KILL_SWITCH)) {
    return createUnavailableIdentityProvider();
  }
  let target;
  try {
    target = validateTarget({
      anchorUid: env.VIEWER_IDENTITY_TARGET_ANCHOR_UID,
      roomId: env.VIEWER_IDENTITY_TARGET_ROOM_ID
    });
  } catch {
    return createUnavailableIdentityProvider({
      errorCode: 'identity_target_not_configured'
    });
  }
  return createGuardTabTopListProvider({
    env,
    target,
    httpGet,
    clock,
    sleep,
    random,
    logger,
    enabled: () => (
      String(env.VIEWER_IDENTITY_PROVIDER || '').trim() === PROVIDER_NAME
      && !isTrue(env.VIEWER_IDENTITY_PROVIDER_KILL_SWITCH)
    )
  });
}

module.exports = {
  ENDPOINT,
  PROVIDER_NAME,
  createConfiguredIdentityProvider,
  createGuardTabTopListProvider,
  parseGuardTabPage,
  parseRetryAfterMs
};
