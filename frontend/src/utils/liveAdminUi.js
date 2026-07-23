export const EVENT_TYPE_LABELS = Object.freeze({
  danmaku: '弹幕',
  gift: '礼物',
  super_chat: '醒目留言',
  guard_buy: '大航海',
  like: '点赞',
  room_enter: '进入直播间',
  live_start: '直播开始',
  live_end: '直播结束'
});

export const EVENT_SOURCE_LABELS = Object.freeze({
  live: '正式监听',
  simulation: '离线模拟',
  replay: '事件重放'
});

export const SESSION_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  open: '已开放',
  paused: '已暂停',
  closed: '已关闭'
});

export const LISTENER_AVAILABILITY_LABELS = Object.freeze({
  available: '状态已上报',
  disabled: '未启用',
  not_configured: '尚未配置',
  blocked: '受到安全条件阻挡',
  unavailable: '状态不可用'
});

export const CONNECTION_STATE_LABELS = Object.freeze({
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  blocked: '受到阻挡',
  unavailable: '不可用',
  unknown: '未知'
});

export function formatLiveAdminDate(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function statusTone(value) {
  if (['available', 'connected', 'open', 'recorded', 'complete'].includes(value)) {
    return 'positive';
  }
  if (['blocked', 'fatal', 'conflict', 'unavailable'].includes(value)) {
    return 'negative';
  }
  if (['connecting', 'backing_off', 'paused', 'partial', 'not_configured'].includes(value)) {
    return 'warning';
  }
  return 'neutral';
}

export function liveAdminErrorMessage(error, context = '状态') {
  const status = Number(error?.response?.status);
  const code = error?.response?.data?.code;
  if (status === 401) return '登录状态已失效，请重新登录。';
  if (status === 403) return '当前账号没有直播管理权限。';
  if (status === 409) return '数据状态发生冲突，请刷新后重试。';
  if (status === 429) return '请求过于频繁，请稍后再试。';
  if (status === 400 && code === 'invalid_live_event_query') {
    return '筛选条件无效，请检查日期范围与输入长度。';
  }
  if (status >= 500 || !status) return `${context}服务暂时不可用，请稍后重试。`;
  return `${context}加载失败，请检查筛选条件后重试。`;
}

export function localDateTimeToIso(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
