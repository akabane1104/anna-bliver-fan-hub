export const REQUEST_STATUS_LABELS = Object.freeze({
  observed: '待归属',
  needs_match: '待确认歌曲',
  queued: '等待中',
  active: '正在处理',
  completed: '已完成',
  rejected: '已拒绝',
  cancelled: '已移除',
  skipped: '已跳过',
  failed: '处理失败'
});

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
  return request?.matched_song?.title || request?.requested_title || '未命名歌曲';
}

export function splitCurrentQueue(data) {
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const active = requests.find(({ status }) => status === 'active') || null;
  const waiting = requests
    .filter(({ status }) => ['needs_match', 'queued'].includes(status))
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
  const code = error?.response?.data?.code;
  if (status === 401) return '请先登录后再点歌。';
  if (status === 403) return '当前账号没有执行此操作的权限。';
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
  return ['needs_match', 'queued'].includes(request?.status);
}
