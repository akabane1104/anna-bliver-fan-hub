const LEGACY_TO_CANONICAL_STATUS = Object.freeze({
  observed: 'pending_review',
  needs_match: 'pending_review',
  queued: 'queued',
  active: 'singing',
  completed: 'completed',
  skipped: 'skipped',
  failed: 'skipped',
  rejected: 'rejected',
  cancelled: 'withdrawn'
});

const CANONICAL_STATUSES = Object.freeze([
  'pending_review',
  'queued',
  'singing',
  'completed',
  'skipped',
  'rejected',
  'withdrawn'
]);

const CANONICAL_TO_LEGACY_STATUSES = Object.freeze({
  pending_review: Object.freeze(['observed', 'needs_match']),
  queued: Object.freeze(['queued']),
  singing: Object.freeze(['active']),
  completed: Object.freeze(['completed']),
  skipped: Object.freeze(['skipped', 'failed']),
  rejected: Object.freeze(['rejected']),
  withdrawn: Object.freeze(['cancelled'])
});

const ACTIVE_LEGACY_STATUSES = Object.freeze([
  'observed',
  'needs_match',
  'queued',
  'active'
]);

const PENDING_LEGACY_STATUSES = Object.freeze(['observed', 'needs_match']);
const WITHDRAWABLE_LEGACY_STATUSES = Object.freeze(['observed', 'needs_match', 'queued']);

const REASON_CODES = Object.freeze([
  'identity_binding_required',
  'requests_closed',
  'queue_capacity_reached',
  'user_active_limit',
  'duplicate_in_queue',
  'song_cooldown',
  'already_sung_today',
  'song_temporarily_blocked',
  'special_event_only',
  'title_unclear',
  'song_not_found',
  'manual_rejection',
  'manual_skip',
  'technical_issue',
  'singer_unavailable',
  'other'
]);

const REASON_MESSAGES = Object.freeze({
  identity_binding_required: '请先绑定 B站账号后再点歌',
  requests_closed: '当前暂未开放点歌',
  queue_capacity_reached: '当前候场人数较多，请稍后再试',
  user_active_limit: '每位观众同时只能有一首待处理歌曲',
  duplicate_in_queue: '这首歌已在当前队列中',
  song_cooldown: '这首歌刚刚唱过，请稍后再点',
  already_sung_today: '这首歌今天已经唱过',
  song_temporarily_blocked: '这首歌目前暂不可点',
  special_event_only: '这首歌仅在指定活动期间开放',
  title_unclear: '歌名不够明确，请选择候选歌曲',
  song_not_found: '歌单中没有找到这首歌',
  manual_rejection: '该点歌请求未通过',
  manual_skip: '该点歌请求已跳过',
  technical_issue: '因技术原因暂时无法处理',
  singer_unavailable: '主播当前无法演唱这首歌',
  other: '该点歌请求暂时无法处理'
});

function canonicalStatus(legacyStatus) {
  return LEGACY_TO_CANONICAL_STATUS[legacyStatus] || null;
}

function isActiveLegacyStatus(status) {
  return ACTIVE_LEGACY_STATUSES.includes(status);
}

function isWithdrawableLegacyStatus(status) {
  return WITHDRAWABLE_LEGACY_STATUSES.includes(status);
}

function normalizeReasonCode(value, fallback = 'other') {
  const normalized = String(value || '').trim();
  return REASON_CODES.includes(normalized) ? normalized : fallback;
}

function reasonMessage(code, supplement = null) {
  const normalizedCode = normalizeReasonCode(code);
  const text = String(supplement || '').trim();
  return text || REASON_MESSAGES[normalizedCode] || REASON_MESSAGES.other;
}

function maskDisplayName(value) {
  const characters = Array.from(String(value || '').trim());
  if (!characters.length) return '匿名观众';
  if (characters.length === 1) return `${characters[0]}***`;
  return `${characters[0]}***${characters[characters.length - 1]}`;
}

module.exports = {
  ACTIVE_LEGACY_STATUSES,
  CANONICAL_STATUSES,
  CANONICAL_TO_LEGACY_STATUSES,
  LEGACY_TO_CANONICAL_STATUS,
  PENDING_LEGACY_STATUSES,
  REASON_CODES,
  REASON_MESSAGES,
  WITHDRAWABLE_LEGACY_STATUSES,
  canonicalStatus,
  isActiveLegacyStatus,
  isWithdrawableLegacyStatus,
  maskDisplayName,
  normalizeReasonCode,
  reasonMessage
};
