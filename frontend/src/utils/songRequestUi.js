export const REQUEST_STATUS_LABELS = Object.freeze({
  pending_review: '待主播确认',
  queued: '等待中',
  singing: '正在唱',
  completed: '已完成',
  skipped: '已跳过',
  rejected: '已拒绝',
  withdrawn: '已撤回'
});

export const REQUEST_REASON_LABELS = Object.freeze({
  identity_binding_required: '请先绑定B站账号',
  requests_closed: '目前未开放点歌',
  queue_capacity_reached: '队列已达到容量上限',
  user_active_limit: '你已有进行中的点歌',
  duplicate_in_queue: '这首歌已在队列中',
  song_cooldown: '这首歌仍在冷却时间',
  already_sung_today: '这首歌今天已经唱过',
  song_temporarily_blocked: '这首歌暂时不能点',
  special_event_only: '这首歌仅限指定活动',
  title_unclear: '歌名不够明确',
  song_not_found: '歌曲库中找不到这首歌',
  manual_rejection: '主播已拒绝这次点歌',
  manual_skip: '主播已跳过这首歌',
  technical_issue: '因技术问题暂时无法演唱',
  singer_unavailable: '主播目前无法演唱',
  other: '其他原因'
});

const LEGACY_STATUS_MAP = Object.freeze({
  observed: 'pending_review',
  needs_match: 'pending_review',
  active: 'singing',
  cancelled: 'withdrawn',
  failed: 'skipped'
});

export function normalizeRequestStatus(status) {
  return LEGACY_STATUS_MAP[status] || status || 'pending_review';
}

export const REQUEST_SOURCE_LABELS = Object.freeze({
  bilibili_danmaku: 'B站弹幕',
  website: '网站点歌',
  manual: '主播手动',
  simulation: '离线模拟',
  replay: '事件重放'
});

export function createIdempotencyKey() {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return `website:${window.crypto.randomUUID()}`;
  }
  return `website:${Date.now()}:${Math.random().toString(36).slice(2, 14)}`;
}

export function createRequestCoordinator() {
  let mounted = true;
  let generation = 0;
  let sequence = 0;
  const latestByScope = new Map();

  return {
    begin(scope) {
      const token = {
        scope,
        generation,
        sequence: ++sequence
      };
      latestByScope.set(scope, token.sequence);
      return token;
    },

    invalidateAll() {
      generation += 1;
      sequence += 1;
      latestByScope.clear();
    },

    isCurrent(token) {
      return Boolean(
        mounted
        && token
        && token.generation === generation
        && latestByScope.get(token.scope) === token.sequence
      );
    },

    isMounted() {
      return mounted;
    },

    activate() {
      mounted = true;
    },

    dispose() {
      mounted = false;
      generation += 1;
      sequence += 1;
      latestByScope.clear();
    }
  };
}

export function getRequestDisplayTitle(request) {
  return (
    request?.canonicalSong?.title
    || request?.canonical_song?.title
    || request?.matched_song?.title
    || request?.requested_title
    || request?.originalInput
    || request?.original_input
    || '未命名歌曲'
  );
}

export function splitCurrentQueue(data) {
  if (Array.isArray(data?.queue) || data?.current || data?.next) {
    const waiting = Array.isArray(data.queue) ? data.queue : [];
    return {
      active: data.current || null,
      next: data.next || waiting[0] || null,
      waiting,
      waitingCount: Number(data.capacityCount ?? data.capacity_count ?? waiting.length)
    };
  }
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const active = requests.find(({ status }) => normalizeRequestStatus(status) === 'singing') || null;
  const waiting = requests
    .filter(({ status }) => ['pending_review', 'queued'].includes(normalizeRequestStatus(status)))
    .sort((left, right) => {
      const leftOrder = Number(left.queue_order ?? Number.MAX_SAFE_INTEGER);
      const rightOrder = Number(right.queue_order ?? Number.MAX_SAFE_INTEGER);
      return leftOrder - rightOrder;
    });
  return {
    active,
    next: waiting[0] || null,
    waiting,
    waitingCount: waiting.length
  };
}

export function requestErrorMessage(error, action = '操作') {
  const status = Number(error?.response?.status);
  const code = error?.response?.data?.reason_code || error?.response?.data?.code;
  if (status === 401) return '请先登录后再点歌。';
  if (status === 403) return '当前账号没有执行此操作的权限。';
  if (REQUEST_REASON_LABELS[code]) return error?.response?.data?.public_reason || REQUEST_REASON_LABELS[code];
  if (status === 409) {
    if (code === 'no_open_session') return '当前还没有开放点歌，请稍后再来。';
    if (code === 'song_requests_closed') return '目前暂停接收点歌，请稍后再试。';
    if (code === 'idempotency_key_conflict') return '这次请求与先前操作冲突，请重新选择歌曲。';
    if (code === 'version_conflict' || code === 'active_request_exists') {
      return '队列刚刚发生变化，已为你重新加载。';
    }
    return '请求与当前队列状态冲突，请刷新后重试。';
  }
  if (status === 429) return '操作太频繁了，请稍后再试。';
  if (status >= 500 || !status) return '服务暂时不可用，请稍后重试。';
  return `${action}失败，请检查后重试。`;
}

export function isReorderable(request) {
  return ['pending_review', 'queued'].includes(normalizeRequestStatus(request?.status));
}

export function formatEtaRange(eta) {
  if (!eta) return '等待估算中';
  if (eta.paused) return '时间估算已暂停';
  if (eta.rangeLabel || eta.range_label) return eta.rangeLabel || eta.range_label;
  const min = Number(eta.minMinutes ?? eta.min_minutes);
  const max = Number(eta.maxMinutes ?? eta.max_minutes);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    if (min === max) return `约 ${min} 分钟`;
    return `约 ${min}–${max} 分钟`;
  }
  return '等待估算中';
}

export function normalizeQueueItem(item = {}) {
  return {
    displayKey: item.displayKey || item.display_key || null,
    position: Number(item.position ?? item.queue_order ?? 0) || null,
    canonicalSong: item.canonicalSong || item.canonical_song || item.matched_song || null,
    maskedDisplayName: item.maskedDisplayName || item.masked_display_name || '',
    eta: item.eta || null,
    status: normalizeRequestStatus(item.status),
    isMine: Boolean(item.isMine ?? item.is_mine)
  };
}

export function normalizeSongRequestCenter(payload = {}) {
  const safePayload = payload || {};
  const source = safePayload.public || safePayload.center || safePayload;
  const legacySessionOpen = source.session?.status === 'open';
  const queue = Array.isArray(source.queue)
    ? source.queue.map(normalizeQueueItem)
    : splitCurrentQueue(source).waiting.map(normalizeQueueItem);
  return {
    effectiveOpen: Boolean(
      source.effectiveOpen
      ?? source.effective_open
      ?? source.open
      ?? legacySessionOpen
    ),
    manualOpen: Boolean(source.manualOpen ?? source.manual_open ?? source.open ?? legacySessionOpen),
    autoCapacityBlocked: Boolean(source.autoCapacityBlocked ?? source.auto_capacity_blocked),
    closeReason: source.closeReason || source.close_reason || '',
    capacityCount: Number(source.capacityCount ?? source.capacity_count ?? queue.length),
    queueLimit: Number(source.queueLimit ?? source.queue_limit ?? 12),
    reopenThreshold: Number(source.reopenThreshold ?? source.reopen_threshold ?? 8),
    current: source.current ? normalizeQueueItem(source.current) : splitCurrentQueue(source).active,
    next: source.next ? normalizeQueueItem(source.next) : (queue[0] || null),
    queue,
    todayCompleted: (source.todayCompleted || source.today_completed || []).map(normalizeQueueItem),
    activity: source.activity || null,
    updatedAt: source.updatedAt || source.updated_at || null,
    etaPaused: Boolean(source.etaPaused ?? source.eta_paused)
  };
}

export function normalizeAvailability(song = {}) {
  const source = song.availability || {};
  const reasonCode = source.reasonCode || source.reason_code || '';
  return {
    requestable: source.requestable !== false,
    reasonCode,
    reason: source.publicReason || source.public_reason || REQUEST_REASON_LABELS[reasonCode] || '',
    sungToday: Boolean(source.sungToday ?? source.sung_today),
    cooldownUntil: source.cooldownUntil || source.cooldown_until || null,
    alreadyQueued: Boolean(source.alreadyQueued ?? source.already_queued),
    temporarilyBlocked: Boolean(source.temporarilyBlocked ?? source.temporarily_blocked),
    specialEventOnly: Boolean(source.specialEventOnly ?? source.special_event_only),
    eta: source.eta || null
  };
}
