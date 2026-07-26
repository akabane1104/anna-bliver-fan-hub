const SESSION_TRANSITIONS = Object.freeze({
  draft: new Set(['open', 'closed']),
  open: new Set(['paused', 'closed']),
  paused: new Set(['open', 'closed']),
  closed: new Set()
});

const REQUEST_TRANSITIONS = Object.freeze({
  observed: new Set(['needs_match', 'queued', 'rejected', 'cancelled']),
  needs_match: new Set(['queued', 'rejected', 'cancelled']),
  queued: new Set(['active', 'cancelled', 'skipped']),
  active: new Set(['completed', 'skipped', 'failed']),
  completed: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
  skipped: new Set(['queued', 'cancelled']),
  failed: new Set(['queued', 'cancelled'])
});

const TERMINAL_REQUEST_STATUSES = new Set(['completed', 'rejected', 'cancelled', 'skipped']);

function canTransitionSession(fromStatus, toStatus) {
  return Boolean(SESSION_TRANSITIONS[fromStatus]?.has(toStatus));
}

function canTransitionRequest(fromStatus, toStatus) {
  return Boolean(REQUEST_TRANSITIONS[fromStatus]?.has(toStatus));
}

function canSetFulfillmentType(status) {
  return status === 'queued' || status === 'active';
}

function isTerminalRequestStatus(status) {
  return TERMINAL_REQUEST_STATUSES.has(status);
}

module.exports = {
  REQUEST_TRANSITIONS,
  SESSION_TRANSITIONS,
  canSetFulfillmentType,
  canTransitionRequest,
  canTransitionSession,
  isTerminalRequestStatus
};
