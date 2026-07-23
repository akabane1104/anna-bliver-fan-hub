import React, { useCallback, useMemo, useState } from 'react';
import LiveAdminNav from '../components/LiveAdminNav';
import { liveAdminService } from '../services';
import {
  EVENT_SOURCE_LABELS,
  EVENT_TYPE_LABELS,
  formatLiveAdminDate,
  liveAdminErrorMessage,
  localDateTimeToIso
} from '../utils/liveAdminUi';
import usePollingResource from '../utils/usePollingResource';

const EMPTY_FILTERS = Object.freeze({
  query: '',
  event_type: '',
  status: '',
  source: '',
  session: '',
  start: '',
  end: ''
});

function EventDetails({ event }) {
  return (
    <details className="live-event-details">
      <summary>查看安全明细</summary>
      <dl>
        <div>
          <dt>目标</dt>
          <dd>{event.target?.display_name || '未知目标'}</dd>
        </div>
        <div>
          <dt>场次</dt>
          <dd>{event.session?.title || '未关联网站场次'}</dd>
        </div>
        <div>
          <dt>来源命令</dt>
          <dd>{event.source?.command || '未知'}</dd>
        </div>
        <div>
          <dt>发生时间</dt>
          <dd>{formatLiveAdminDate(event.occurred_at)}</dd>
        </div>
        <div>
          <dt>处理完成</dt>
          <dd>{formatLiveAdminDate(event.processing?.completed_at)}</dd>
        </div>
      </dl>
      {event.content?.text && <p>{event.content.text}</p>}
      {event.song_request && (
        <div className="live-event-song-request">
          <strong>点歌请求：{event.song_request.requested_title}</strong>
          <span>
            {event.song_request.matched_song_title
              ? `匹配歌曲：${event.song_request.matched_song_title}`
              : '尚未匹配歌曲'}
          </span>
          <span>
            {event.song_request.queue_assigned ? '已进入统一点歌队列' : '尚未归属网站场次'}
          </span>
        </div>
      )}
    </details>
  );
}

function EventStatus({ event }) {
  return (
    <div className="live-event-processing">
      <span className="live-status-badge positive">
        <span className="live-status-dot" aria-hidden="true" />
        {event.processing?.status === 'recorded' ? '已记录' : event.processing?.status}
      </span>
      <small>{event.song_request ? '已识别点歌' : '未建立点歌'}</small>
    </div>
  );
}

function LiveEventsAdmin() {
  const [draftFilters, setDraftFilters] = useState({ ...EMPTY_FILTERS });
  const [appliedFilters, setAppliedFilters] = useState({ ...EMPTY_FILTERS });
  const [page, setPage] = useState(1);
  const [filterError, setFilterError] = useState('');

  const params = useMemo(() => {
    const output = { page, limit: 20 };
    for (const key of ['query', 'event_type', 'status', 'source', 'session']) {
      if (appliedFilters[key]) output[key] = appliedFilters[key];
    }
    if (appliedFilters.start) output.start = appliedFilters.start;
    if (appliedFilters.end) output.end = appliedFilters.end;
    return output;
  }, [appliedFilters, page]);

  const loader = useCallback(
    ({ signal }) => liveAdminService.getEvents(params, { signal }),
    [params]
  );
  const {
    data,
    error,
    loading,
    refreshing,
    lastSuccessAt,
    refresh
  } = usePollingResource(loader, {
    intervalMs: 5000,
    autoRefresh: page === 1
  });

  const updateFilter = (event) => {
    const { name, value } = event.target;
    setDraftFilters((current) => ({ ...current, [name]: value }));
  };

  const applyFilters = (event) => {
    event.preventDefault();
    const start = localDateTimeToIso(draftFilters.start);
    const end = localDateTimeToIso(draftFilters.end);
    if (start === null || end === null || (start && end && Date.parse(start) > Date.parse(end))) {
      setFilterError('请检查开始和结束时间，结束时间不能早于开始时间。');
      return;
    }
    setFilterError('');
    setPage(1);
    setAppliedFilters({
      ...draftFilters,
      start: start || '',
      end: end || ''
    });
  };

  const clearFilters = () => {
    setFilterError('');
    setDraftFilters({ ...EMPTY_FILTERS });
    setAppliedFilters({ ...EMPTY_FILTERS });
    setPage(1);
  };

  const events = data?.events || [];
  const pagination = data?.pagination || {
    page,
    totalPages: 1,
    total: 0
  };
  const sessions = data?.filters?.session_options || [];

  return (
    <div className="live-admin-page live-events-page">
      <header className="live-admin-header">
        <div>
          <p className="live-admin-eyebrow">直播管理</p>
          <h1>直播事件记录</h1>
          <p>只读查看已保存的标准化事件，不提供删除、修改或重放。</p>
        </div>
        <button
          type="button"
          className="live-admin-refresh"
          onClick={refresh}
          disabled={loading || refreshing}
          aria-label="刷新直播事件"
        >
          <span aria-hidden="true">↻</span>
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </header>

      <LiveAdminNav />

      <form className="live-event-filters" onSubmit={applyFilters}>
        <label className="live-event-search">
          <span>关键词</span>
          <input
            name="query"
            value={draftFilters.query}
            onChange={updateFilter}
            maxLength={200}
            placeholder="显示名称、弹幕、礼物或歌曲"
          />
        </label>
        <label>
          <span>事件类型</span>
          <select name="event_type" value={draftFilters.event_type} onChange={updateFilter}>
            <option value="">全部类型</option>
            {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>处理状态</span>
          <select name="status" value={draftFilters.status} onChange={updateFilter}>
            <option value="">全部状态</option>
            <option value="recorded">已记录</option>
          </select>
        </label>
        <label>
          <span>来源</span>
          <select name="source" value={draftFilters.source} onChange={updateFilter}>
            <option value="">全部来源</option>
            {Object.entries(EVENT_SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>网站场次</span>
          <select name="session" value={draftFilters.session} onChange={updateFilter}>
            <option value="">全部场次</option>
            {sessions.map((session) => (
              <option key={session.public_id} value={session.public_id}>
                {session.title} · {session.target?.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>开始时间</span>
          <input
            type="datetime-local"
            name="start"
            value={draftFilters.start}
            onChange={updateFilter}
          />
        </label>
        <label>
          <span>结束时间</span>
          <input
            type="datetime-local"
            name="end"
            value={draftFilters.end}
            onChange={updateFilter}
          />
        </label>
        <div className="live-event-filter-actions">
          <button type="submit" className="live-admin-primary">应用筛选</button>
          <button type="button" onClick={clearFilters}>清除全部</button>
        </div>
      </form>

      {filterError && <div className="live-admin-alert negative" role="alert">{filterError}</div>}

      <div className="live-event-list-heading">
        <div>
          <strong>事件列表</strong>
          <span>共 {pagination.total || 0} 条</span>
        </div>
        <span>最后成功更新：{formatLiveAdminDate(lastSuccessAt)}</span>
      </div>

      {page > 1 && (
        <div className="live-admin-alert neutral">
          当前页不会自动插入新事件，请使用刷新按钮查看最新结果。
        </div>
      )}

      {error && (
        <div className="live-admin-alert negative" role="alert">
          <div>
            <strong>事件记录加载失败</strong>
            <span>{liveAdminErrorMessage(error, '事件记录')}</span>
          </div>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      )}

      {loading && !data ? (
        <div className="live-admin-loading" role="status">正在读取事件记录...</div>
      ) : !events.length ? (
        <div className="live-admin-empty">当前筛选条件下没有已保存事件。</div>
      ) : (
        <>
          <div className="live-event-table-wrap">
            <table className="live-event-table">
              <thead>
                <tr>
                  <th>接收时间</th>
                  <th>类型与来源</th>
                  <th>用户与内容</th>
                  <th>处理结果</th>
                  <th>明细</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.event_ref}>
                    <td>
                      <time dateTime={event.received_at}>
                        {formatLiveAdminDate(event.received_at)}
                      </time>
                    </td>
                    <td>
                      <strong>{EVENT_TYPE_LABELS[event.event_type] || event.event_type}</strong>
                      <span>{EVENT_SOURCE_LABELS[event.source?.mode] || event.source?.mode}</span>
                    </td>
                    <td className="live-event-content-cell">
                      <strong>{event.actor_display_name || '系统事件'}</strong>
                      <span>{event.content?.summary || '直播事件'}</span>
                      {event.content?.text && <p>{event.content.text}</p>}
                      {event.song_request?.requested_title && (
                        <small>点歌：{event.song_request.requested_title}</small>
                      )}
                    </td>
                    <td><EventStatus event={event} /></td>
                    <td><EventDetails event={event} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="live-event-cards">
            {events.map((event) => (
              <article key={event.event_ref}>
                <header>
                  <div>
                    <strong>{EVENT_TYPE_LABELS[event.event_type] || event.event_type}</strong>
                    <span>{EVENT_SOURCE_LABELS[event.source?.mode] || event.source?.mode}</span>
                  </div>
                  <EventStatus event={event} />
                </header>
                <time dateTime={event.received_at}>{formatLiveAdminDate(event.received_at)}</time>
                <div className="live-event-card-content">
                  <strong>{event.actor_display_name || '系统事件'}</strong>
                  <span>{event.content?.summary || '直播事件'}</span>
                  {event.content?.text && <p>{event.content.text}</p>}
                </div>
                <EventDetails event={event} />
              </article>
            ))}
          </div>
        </>
      )}

      <nav className="live-event-pagination" aria-label="事件分页">
        <button
          type="button"
          disabled={pagination.page <= 1 || loading || refreshing}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          上一页
        </button>
        <span>
          第 {pagination.page || 1} / {pagination.totalPages || 1} 页
        </span>
        <button
          type="button"
          disabled={
            pagination.page >= pagination.totalPages ||
            loading ||
            refreshing
          }
          onClick={() => setPage((current) => current + 1)}
        >
          下一页
        </button>
      </nav>
    </div>
  );
}

export default LiveEventsAdmin;
