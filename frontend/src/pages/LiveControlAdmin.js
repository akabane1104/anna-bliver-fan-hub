import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import BackButton from '../components/BackButton';
import { InlineAlert, useFeedback } from '../components/FeedbackProvider';
import LiveAdminNav from '../components/LiveAdminNav';
import LiveHomeCard from '../components/LiveHomeCard';
import { liveAdminService, songRequestService } from '../services';
import { requestErrorMessage } from '../utils/songRequestUi';
import usePollingResource from '../utils/usePollingResource';

const EMPTY_ACTIVITY = Object.freeze({
  enabled: false,
  title: '',
  content: '',
  starts_at: '',
  ends_at: ''
});

function toTaipeiInput(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function taipeiInputToUtc(value) {
  return value ? new Date(`${value}:00+08:00`).toISOString() : null;
}

function formatTaipei(value) {
  if (!value) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Taipei',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

const adminPollInterval = (data) => (
  data?.home?.refresh_after_ms || 30000
);

async function loadAdminControl({ signal }) {
  return { home: await liveAdminService.getHome({ signal }) };
}

function controlQueue(home) {
  const source = home?.control?.queue || {};
  const waiting = Array.isArray(source.waiting) ? source.waiting : [];
  return {
    active: source.current || null,
    next: waiting[0] || null,
    waiting,
    waitingCount: Number(source.waiting_count || 0)
  };
}

function controlSongTitle(request) {
  return request?.title || '未命名歌曲';
}

function LiveControlAdmin() {
  const { toast } = useFeedback();
  const actionLocks = useRef(new Set());
  const [pending, setPending] = useState(new Set());
  const [overrideHours, setOverrideHours] = useState('4');
  const [activity, setActivity] = useState(EMPTY_ACTIVITY);
  const [activityDirty, setActivityDirty] = useState(false);
  const loader = useCallback(loadAdminControl, []);
  const resource = usePollingResource(loader, {
    intervalMs: adminPollInterval,
    staleAfterMs: 90000
  });
  const home = resource.data?.home || null;
  const queue = useMemo(
    () => controlQueue(home),
    [home]
  );

  useEffect(() => {
    if (!home || activityDirty) return;
    const next = home.control?.activity;
    setActivity(next ? {
      enabled: Boolean(next.enabled),
      title: next.title || '',
      content: next.content || '',
      starts_at: toTaipeiInput(next.starts_at),
      ends_at: toTaipeiInput(next.ends_at)
    } : EMPTY_ACTIVITY);
  }, [activityDirty, home]);

  const runAction = async (key, task, successMessage) => {
    if (actionLocks.current.has(key)) return false;
    actionLocks.current.add(key);
    setPending((current) => new Set(current).add(key));
    try {
      await task();
      toast(successMessage, { type: 'success' });
      await resource.refresh();
      return true;
    } catch (error) {
      toast(requestErrorMessage(error, '更新直播中控'), { type: 'error' });
      return false;
    } finally {
      actionLocks.current.delete(key);
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const setOverride = (mode) => runAction(
    `override:${mode}`,
    () => liveAdminService.setOverride(
      mode,
      mode === 'auto'
        ? null
        : new Date(Date.now() + Number(overrideHours) * 3600000).toISOString()
    ),
    mode === 'auto' ? '已恢复自动模式' : '手动直播模式已更新'
  );

  const setSongRequestsOpen = (open) => runAction(
    'song-requests',
    () => liveAdminService.setSongRequestsOpen(open),
    open ? '点歌已开放' : '点歌已关闭'
  );

  const advance = (outcome, activateNext) => {
    if (!queue.active) return Promise.resolve(false);
    return runAction(
      `advance:${outcome}:${activateNext}`,
      () => liveAdminService.advanceCurrent(queue.active.public_id, {
        expected_version: queue.active.version,
        outcome,
        activate_next: activateNext
      }),
      activateNext ? '当前歌曲已处理并切换下一首' : '当前歌曲状态已更新'
    );
  };

  const activateRequest = (request) => {
    if (!request) return Promise.resolve(false);
    return runAction(
      `activate:${request.public_id}`,
      () => songRequestService.transitionRequest(
        request.public_id,
        'activate',
        request.version
      ),
      '已设为正在唱'
    );
  };

  const saveActivity = () => runAction(
    'activity',
    () => liveAdminService.setActivity({
      enabled: activity.enabled,
      title: activity.title.trim(),
      content: activity.content.trim(),
      starts_at: taipeiInputToUtc(activity.starts_at),
      ends_at: taipeiInputToUtc(activity.ends_at)
    }),
    '今日活动已保存'
  ).then((saved) => {
    if (saved) setActivityDirty(false);
  });

  const clearActivity = () => runAction(
    'activity',
    () => liveAdminService.setActivity({
      enabled: false,
      title: '',
      content: '',
      starts_at: null,
      ends_at: null
    }),
    '今日活动已清除'
  ).then((cleared) => {
    if (cleared) {
      setActivity(EMPTY_ACTIVITY);
      setActivityDirty(false);
    }
  });

  const updateActivity = (field, value) => {
    setActivity((current) => ({ ...current, [field]: value }));
    setActivityDirty(true);
  };

  const overrideMode = home?.control?.override_mode || 'auto';
  const isBusy = pending.size > 0;

  return (
    <div className="live-admin-page live-control-page">
      <BackButton />
      <header className="live-admin-header">
        <div>
          <p className="live-admin-eyebrow">LIVE CONTROL</p>
          <h1>直播中控</h1>
          <p>用手机也能快速控制直播首页与统一点歌队列。</p>
        </div>
        <button
          type="button"
          className="live-admin-refresh"
          onClick={resource.refresh}
          disabled={resource.refreshing}
        >
          刷新
        </button>
      </header>
      <LiveAdminNav />

      {resource.error && (
        <InlineAlert type="error">
          {resource.stale
            ? '直播中控资料已过期，请检查网络后重试。'
            : '暂时无法取得最新资料，画面保留上一次成功结果。'}
        </InlineAlert>
      )}
      {resource.loading && !home && <div className="live-admin-loading">加载直播中控…</div>}

      {home && (
        <>
          <div className="live-admin-update-line">
            <span>公开模式：<strong>{home.status_label}</strong></span>
            <span>最后更新：{formatTaipei(home.updated_at)}</span>
            {resource.refreshing && <span>同步中…</span>}
          </div>

          <section className="live-control-grid" aria-label="直播状态控制">
            <article className="live-control-panel">
              <header>
                <div>
                  <span>直播模式</span>
                  <h2>{home.mode === 'syncing' ? '重新同步中' : home.status_label}</h2>
                </div>
                <span className={`live-status-badge ${home.mode === 'live' ? 'positive' : (home.mode === 'syncing' ? 'warning' : '')}`}>
                  <span className="live-status-dot" aria-hidden="true" />
                  {home.mode}
                </span>
              </header>
              <div className="live-control-signal">
                <span>自动信号：{home.control?.official_state || 'unknown'}</span>
                <span>Listener：{home.control?.listener?.state || 'unavailable'}</span>
                <span>直播间ID：{home.control?.room_id_configured ? '已配置' : '尚未配置'}</span>
              </div>
              <label className="live-control-expiry">
                手动模式有效时间
                <select
                  value={overrideHours}
                  onChange={(event) => setOverrideHours(event.target.value)}
                  disabled={isBusy}
                >
                  <option value="1">1 小时</option>
                  <option value="4">4 小时</option>
                  <option value="8">8 小时</option>
                  <option value="12">12 小时</option>
                </select>
              </label>
              <div className="live-control-segments" aria-label="直播模式">
                <button type="button" aria-pressed={overrideMode === 'auto'} disabled={isBusy} onClick={() => setOverride('auto')}>自动</button>
                <button type="button" aria-pressed={overrideMode === 'force_live'} disabled={isBusy} onClick={() => setOverride('force_live')}>强制直播</button>
                <button type="button" aria-pressed={overrideMode === 'force_offline'} disabled={isBusy} onClick={() => setOverride('force_offline')}>强制下播</button>
              </div>
              {overrideMode !== 'auto' && (
                <button type="button" className="live-control-text-action" disabled={isBusy} onClick={() => setOverride('auto')}>
                  清除手动覆写
                </button>
              )}
            </article>

            <article className="live-control-panel">
              <header>
                <div>
                  <span>点歌队列</span>
                  <h2>{home.song_requests?.open ? '开放点歌' : '点歌已关闭'}</h2>
                </div>
                <label className="live-control-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(home.song_requests?.open)}
                    disabled={isBusy}
                    onChange={(event) => setSongRequestsOpen(event.target.checked)}
                  />
                  <span>开放点歌</span>
                </label>
              </header>
              <div className="live-control-song">
                <span>正在唱</span>
                <strong title={queue.active ? controlSongTitle(queue.active) : ''}>
                  {queue.active ? controlSongTitle(queue.active) : '目前没有歌曲'}
                </strong>
              </div>
              <div className="live-control-song">
                <span>下一首</span>
                <strong title={queue.next ? controlSongTitle(queue.next) : ''}>
                  {queue.next ? controlSongTitle(queue.next) : '队列为空'}
                </strong>
              </div>
              <p className="live-control-count">等待 {queue.waitingCount} 首</p>
              {queue.waiting.length > 0 && (
                <ul className="live-control-waiting" aria-label="等待点歌队列">
                  {queue.waiting.map((request) => (
                    <li key={request.public_id}>
                      <span title={controlSongTitle(request)}>
                        {controlSongTitle(request)}
                      </span>
                      <button
                        type="button"
                        aria-label={`设为正在唱：${controlSongTitle(request)}`}
                        disabled={isBusy || Boolean(queue.active)}
                        onClick={() => activateRequest(request)}
                      >
                        设为当前
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="live-control-actions">
                <button type="button" disabled={isBusy || !queue.active} onClick={() => advance('completed', false)}>唱完</button>
                <button type="button" disabled={isBusy || !queue.active || !queue.next} onClick={() => advance('completed', true)}>唱完并下一首</button>
                <button type="button" disabled={isBusy || !queue.active} onClick={() => advance('skipped', false)}>跳过</button>
                <button type="button" disabled={isBusy || !queue.active || !queue.next} onClick={() => advance('skipped', true)}>跳过并下一首</button>
              </div>
            </article>
          </section>

          <section className="live-control-panel live-control-activity">
            <header>
              <div>
                <span>首页内容</span>
                <h2>今日活动</h2>
              </div>
              <label className="live-control-toggle">
                <input
                  type="checkbox"
                  checked={activity.enabled}
                  disabled={isBusy}
                  onChange={(event) => updateActivity('enabled', event.target.checked)}
                />
                <span>公开显示</span>
              </label>
            </header>
            <div className="live-control-form">
              <label>
                标题
                <input
                  value={activity.title}
                  maxLength={120}
                  onChange={(event) => updateActivity('title', event.target.value)}
                />
              </label>
              <label className="live-control-form-wide">
                内容
                <textarea
                  value={activity.content}
                  maxLength={500}
                  rows="3"
                  onChange={(event) => updateActivity('content', event.target.value)}
                />
              </label>
              <label>
                开始时间（台北）
                <input
                  type="datetime-local"
                  value={activity.starts_at}
                  onChange={(event) => updateActivity('starts_at', event.target.value)}
                />
              </label>
              <label>
                结束时间（台北）
                <input
                  type="datetime-local"
                  value={activity.ends_at}
                  onChange={(event) => updateActivity('ends_at', event.target.value)}
                />
              </label>
            </div>
            <div className="live-control-form-actions">
              <button type="button" disabled={isBusy} onClick={clearActivity}>清除活动</button>
              <button
                type="button"
                className="live-admin-primary"
                disabled={(
                  isBusy ||
                  !activityDirty ||
                  (activity.enabled && (!activity.title.trim() || !activity.content.trim()))
                )}
                onClick={saveActivity}
              >
                保存活动
              </button>
            </div>
          </section>

          <section className="live-control-preview">
            <div className="live-admin-section-heading">
              <div>
                <h2>直播首页预览</h2>
                <p>使用与公开首页相同的组件，不会写入直播事件。</p>
              </div>
            </div>
            <LiveHomeCard data={home} preview showOffline />
          </section>
        </>
      )}
    </div>
  );
}

export {
  adminPollInterval,
  controlQueue,
  controlSongTitle,
  formatTaipei,
  loadAdminControl,
  taipeiInputToUtc,
  toTaipeiInput
};
export default LiveControlAdmin;
