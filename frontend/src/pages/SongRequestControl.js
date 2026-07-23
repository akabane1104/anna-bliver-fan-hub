import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BackButton from '../components/BackButton';
import LiveAdminNav from '../components/LiveAdminNav';
import { InlineAlert, useFeedback } from '../components/FeedbackProvider';
import { songRequestService } from '../services';
import {
  createRequestCoordinator,
  getRequestDisplayTitle,
  isReorderable,
  requestErrorMessage,
  REQUEST_SOURCE_LABELS,
  REQUEST_STATUS_LABELS,
  splitCurrentQueue
} from '../utils/songRequestUi';

const HISTORY_STATUSES = [
  'observed',
  'needs_match',
  'queued',
  'active',
  'completed',
  'rejected',
  'cancelled',
  'skipped',
  'failed'
];
const HISTORY_SOURCES = ['website', 'manual', 'bilibili_danmaku', 'simulation', 'replay'];

function RequestSummary({ request, emptyText }) {
  if (!request) return <span className="song-control-empty-inline">{emptyText}</span>;
  return (
    <div className="song-control-summary-song">
      <strong>{getRequestDisplayTitle(request)}</strong>
      <span>{request.matched_song?.artist || '待确认歌曲'}</span>
      <small>{request.requester_display_name || '未公开点歌者'}</small>
    </div>
  );
}

function SongRequestControl() {
  const { confirm, toast } = useFeedback();
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [queueData, setQueueData] = useState(null);
  const [catalog, setCatalog] = useState({ playlist: null, songs: [] });
  const [catalogQuery, setCatalogQuery] = useState('');
  const [debouncedCatalogQuery, setDebouncedCatalogQuery] = useState('');
  const [history, setHistory] = useState({ requests: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [historyFilters, setHistoryFilters] = useState({ query: '', status: '', source: '', page: 1 });
  const [sessionForm, setSessionForm] = useState({
    site_id: '',
    room_id: '',
    title: '本场点歌'
  });
  const [pending, setPending] = useState(new Set());
  const [resourceErrors, setResourceErrors] = useState({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [manualMatchSongs, setManualMatchSongs] = useState({});
  const operationLocks = useRef(new Set());
  const requestCoordinator = useRef(null);
  if (!requestCoordinator.current) {
    requestCoordinator.current = createRequestCoordinator();
  }
  const error = (
    resourceErrors.sessions
    || resourceErrors.queue
    || resourceErrors.history
    || resourceErrors.catalog
    || ''
  );

  const markPending = (key, value) => {
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const commitResourceError = useCallback((token, message) => {
    if (!requestCoordinator.current.isCurrent(token)) return;
    setResourceErrors((current) => {
      if ((current[token.scope] || '') === message) return current;
      return { ...current, [token.scope]: message };
    });
  }, []);

  const loadSessions = useCallback(async () => {
    const token = requestCoordinator.current.begin('sessions');
    try {
      const result = await songRequestService.getRecoverableSessions();
      const nextSessions = result.sessions || [];
      if (!requestCoordinator.current.isCurrent(token)) return null;
      setSessions(nextSessions);
      setSelectedSessionId((current) => (
        nextSessions.some(({ public_id }) => public_id === current)
          ? current
          : (nextSessions[0]?.public_id || '')
      ));
      commitResourceError(token, '');
      return nextSessions;
    } catch (nextError) {
      commitResourceError(token, requestErrorMessage(nextError, '加载点歌控制台'));
      return null;
    }
  }, [commitResourceError]);

  const loadCatalog = useCallback(async () => {
    const token = requestCoordinator.current.begin('catalog');
    try {
      const result = await songRequestService.getCatalog({
        query: debouncedCatalogQuery,
        page: 1,
        limit: 100
      });
      if (requestCoordinator.current.isCurrent(token)) setCatalog(result);
    } catch (nextError) {
      commitResourceError(token, requestErrorMessage(nextError, '加载歌曲库'));
    }
  }, [commitResourceError, debouncedCatalogQuery]);

  const loadQueue = useCallback(async () => {
    const token = requestCoordinator.current.begin('queue');
    if (!selectedSessionId) {
      if (requestCoordinator.current.isCurrent(token)) setQueueData(null);
      return;
    }
    try {
      const result = await songRequestService.getSessionRequests(selectedSessionId);
      if (!requestCoordinator.current.isCurrent(token)) return;
      setQueueData(result);
      commitResourceError(token, '');
    } catch (nextError) {
      commitResourceError(token, requestErrorMessage(nextError, '加载点歌队列'));
    }
  }, [commitResourceError, selectedSessionId]);

  const loadHistory = useCallback(async () => {
    const token = requestCoordinator.current.begin('history');
    try {
      const result = await songRequestService.getHistory({
        query: historyFilters.query || undefined,
        status: historyFilters.status || undefined,
        source: historyFilters.source || undefined,
        page: historyFilters.page,
        limit: 20
      });
      if (requestCoordinator.current.isCurrent(token)) {
        setHistory(result);
        commitResourceError(token, '');
      }
    } catch (nextError) {
      commitResourceError(token, requestErrorMessage(nextError, '加载历史'));
    }
  }, [commitResourceError, historyFilters]);

  useEffect(() => {
    requestCoordinator.current.activate();
    return () => {
      requestCoordinator.current.dispose();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedCatalogQuery(catalogQuery.trim()),
      300
    );
    return () => window.clearTimeout(timer);
  }, [catalogQuery]);

  useEffect(() => {
    let cancelled = false;
    loadSessions()
      .finally(() => {
        if (!cancelled && requestCoordinator.current.isMounted()) {
          setInitialLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadQueue();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadQueue();
    }, 5000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') loadQueue();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadQueue]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSessions(), loadQueue(), loadHistory()]);
  }, [loadHistory, loadQueue, loadSessions]);

  const runAction = async (key, action) => {
    if (operationLocks.current.has(key)) return { status: 'duplicate_ignored' };
    operationLocks.current.add(key);
    markPending(key, true);
    requestCoordinator.current.invalidateAll();
    const token = requestCoordinator.current.begin(`mutation:${key}`);
    try {
      await action();
      if (!requestCoordinator.current.isCurrent(token)) {
        return { status: 'stale_ignored' };
      }
      await refreshAll();
    } catch (nextError) {
      if (requestCoordinator.current.isCurrent(token)) {
        toast(requestErrorMessage(nextError), { type: 'error' });
        if (nextError?.response?.status === 409) await refreshAll();
      }
    } finally {
      operationLocks.current.delete(key);
      if (requestCoordinator.current.isMounted()) markPending(key, false);
    }
    return { status: 'settled' };
  };

  const handleCreateSession = (event) => {
    event.preventDefault();
    const playlistId = catalog.playlist?.id;
    const operationKey = `target:${sessionForm.site_id}:${sessionForm.room_id}`;
    runAction(operationKey, async () => {
      const created = await songRequestService.createSession({
        ...sessionForm,
        playlist_id: playlistId
      });
      await songRequestService.transitionSession(
        created.session.public_id,
        'open',
        created.session.version
      );
      toast('点歌场次已开放', { type: 'success' });
    });
  };

  const transitionSession = (action) => {
    const session = selectedSession;
    if (!session) return;
    runAction(`session:${session.public_id}`, async () => {
      await songRequestService.transitionSession(session.public_id, action, session.version);
      toast('场次状态已更新', { type: 'success' });
    });
  };

  const transitionRequest = (request, action) => runAction(
    `request:${request.public_id}`,
    async () => {
      await songRequestService.transitionRequest(request.public_id, action, request.version);
      toast('队列已更新', { type: 'success' });
    }
  );

  const setFulfillment = (request, fulfillmentType) => runAction(
    `request:${request.public_id}`,
    async () => {
      await songRequestService.setFulfillment(
        request.public_id,
        request.version,
        fulfillmentType
      );
      toast(fulfillmentType === 'sung' ? '已设为演唱' : '已设为播放', { type: 'success' });
    }
  );

  const removeRequest = async (request) => {
    const accepted = await confirm({
      title: '移除等待歌曲',
      message: `确定移除《${getRequestDisplayTitle(request)}》吗？`,
      detail: '操作会写入点歌历史，且不能从终态恢复。',
      confirmText: '确认移除',
      variant: 'danger'
    });
    if (accepted) transitionRequest(request, 'cancel');
  };

  const reorderable = useMemo(
    () => (queueData?.requests || []).filter(isReorderable),
    [queueData]
  );
  const publicQueue = useMemo(() => splitCurrentQueue(queueData), [queueData]);
  const selectedSession = useMemo(
    () => (
      queueData?.session
      || sessions.find(({ public_id }) => public_id === selectedSessionId)
      || null
    ),
    [queueData, selectedSessionId, sessions]
  );
  const sessionOperationKey = selectedSession ? `session:${selectedSession.public_id}` : '';
  const createOperationKey = `target:${sessionForm.site_id}:${sessionForm.room_id}`;

  const moveRequest = (request, direction) => {
    const index = reorderable.findIndex(({ public_id }) => public_id === request.public_id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= reorderable.length) return;
    const next = [...reorderable];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    runAction(`reorder:${queueData.session.public_id}`, async () => {
      await songRequestService.reorder(
        queueData.session.public_id,
        queueData.session.version,
        next.map(({ public_id }) => public_id)
      );
      toast('等待顺序已更新', { type: 'success' });
    });
  };

  const addManualSong = (song) => runAction(`manual:${queueData.session.public_id}:${song.id}`, async () => {
    const session = queueData.session;
    await songRequestService.createManualRequest({
      site_id: session.site_id,
      room_id: session.room_id,
      session_public_id: session.public_id,
      song_id: song.id,
      requester_display_name: '主播手动'
    });
    toast(`《${song.title}》已加入统一队列`, { type: 'success' });
  });

  const matchRequest = (request) => {
    const songId = Number(manualMatchSongs[request.public_id]);
    if (!songId) return;
    runAction(`request:${request.public_id}`, async () => {
      await songRequestService.matchRequest(request.public_id, request.version, songId);
      toast('歌曲匹配已确认', { type: 'success' });
    });
  };

  if (initialLoading) {
    return <div className="loading">正在加载点歌控制台...</div>;
  }

  return (
    <div className="container song-control-page">
      <BackButton to="/" />
      <header className="song-control-header">
        <div>
          <p className="section-kicker">主播工具</p>
          <h1 className="page-title">点歌控制</h1>
          <p className="page-subtitle">网站、主播手动与未来 B站弹幕共用同一条队列。</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={refreshAll}>
          重新整理
        </button>
      </header>
      <LiveAdminNav />

      {error && <InlineAlert type="error" title="加载失败">{error}</InlineAlert>}

      {sessions.length === 0 ? (
        <section className="song-control-section" aria-labelledby="session-create-title">
          <h2 id="session-create-title">开放点歌场次</h2>
          <form className="song-session-form" onSubmit={handleCreateSession}>
            <label>
              <span>站点 ID</span>
              <input
                value={sessionForm.site_id}
                onChange={(event) => setSessionForm((current) => ({ ...current, site_id: event.target.value }))}
                pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                maxLength="64"
                required
              />
            </label>
            <label>
              <span>直播间 ID</span>
              <input
                value={sessionForm.room_id}
                onChange={(event) => setSessionForm((current) => ({ ...current, room_id: event.target.value }))}
                inputMode="numeric"
                pattern="[1-9][0-9]{0,31}"
                maxLength="32"
                required
              />
            </label>
            <label>
              <span>场次名称</span>
              <input
                value={sessionForm.title}
                onChange={(event) => setSessionForm((current) => ({ ...current, title: event.target.value }))}
                maxLength="200"
                required
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending.has(createOperationKey) || !catalog.playlist}
            >
              {pending.has(createOperationKey) ? '开放中...' : '建立并开放场次'}
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="song-control-section song-session-toolbar" aria-label="场次控制">
            {sessions.length > 1 && (
              <label>
                <span>当前场次</span>
                <select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
                  {sessions.map((session) => (
                    <option key={session.public_id} value={session.public_id}>{session.title}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="song-session-state">
              <strong>{selectedSession?.title || '正在读取场次'}</strong>
              <span>
                {selectedSession?.status === 'draft'
                  ? '草稿待开放'
                  : (selectedSession?.status === 'paused' ? '已暂停接收自动点歌' : '开放中')}
              </span>
            </div>
            <div className="song-session-actions">
              {selectedSession?.status === 'draft' && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending.has(sessionOperationKey)}
                  onClick={() => transitionSession('open')}
                >
                  开放草稿
                </button>
              )}
              {selectedSession?.status === 'open' && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pending.has(sessionOperationKey)}
                  onClick={() => transitionSession('pause')}
                >
                  暂停场次
                </button>
              )}
              {selectedSession?.status === 'paused' && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending.has(sessionOperationKey)}
                  onClick={() => transitionSession('resume')}
                >
                  恢复场次
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending.has(sessionOperationKey)}
                onClick={() => transitionSession('close')}
              >
                关闭场次
              </button>
            </div>
          </section>

          <section className="song-control-section" aria-labelledby="queue-overview-title">
            <div className="song-request-section-heading">
              <div>
                <p className="section-kicker">实时概览</p>
                <h2 id="queue-overview-title">统一点歌队列</h2>
              </div>
              <span className="song-control-waiting-count">等待 {publicQueue.waitingCount} 首</span>
            </div>
            <div className="song-control-now-grid">
              <div><span>目前处理</span><RequestSummary request={publicQueue.active} emptyText="尚未开始歌曲" /></div>
              <div><span>下一首</span><RequestSummary request={publicQueue.next} emptyText="等待队列为空" /></div>
            </div>

            {publicQueue.active && (
              <div className="song-control-active-row">
                <RequestSummary request={publicQueue.active} />
                <div className="song-request-fulfillment" aria-label="完成方式">
                  <button
                    type="button"
                    className={publicQueue.active.fulfillment_type === 'sung' ? 'active' : ''}
                    onClick={() => setFulfillment(publicQueue.active, 'sung')}
                  >
                    演唱
                  </button>
                  <button
                    type="button"
                    className={publicQueue.active.fulfillment_type === 'played' ? 'active' : ''}
                    onClick={() => setFulfillment(publicQueue.active, 'played')}
                  >
                    播放
                  </button>
                </div>
                <div className="song-control-row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={publicQueue.active.fulfillment_type === 'undecided'}
                    onClick={() => transitionRequest(publicQueue.active, 'complete')}
                  >
                    完成
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => transitionRequest(publicQueue.active, 'skip')}>
                    跳过
                  </button>
                </div>
              </div>
            )}

            {reorderable.length === 0 ? (
              <div className="song-request-empty compact">
                <strong>当前没有等待歌曲</strong>
                <span>可以从下方歌曲库手动加入。</span>
              </div>
            ) : (
              <ol className="song-control-queue-list">
                {reorderable.map((request, index) => (
                  <li key={request.public_id}>
                    <span className="queue-position">{request.queue_order || index + 1}</span>
                    <span className="queue-song-copy">
                      <strong>{getRequestDisplayTitle(request)}</strong>
                      <small>
                        {request.matched_song?.artist || '待人工匹配'} · {request.requester_display_name || '未公开点歌者'} · {REQUEST_SOURCE_LABELS[request.source] || request.source}
                      </small>
                    </span>
                    <span className={`request-status request-status-${request.status}`}>
                      {REQUEST_STATUS_LABELS[request.status]}
                    </span>
                    {request.status === 'needs_match' && (
                      <div className="song-control-match">
                        <select
                          aria-label={`为 ${request.requested_title} 选择歌曲`}
                          value={manualMatchSongs[request.public_id] || ''}
                          onChange={(event) => setManualMatchSongs((current) => ({
                            ...current,
                            [request.public_id]: event.target.value
                          }))}
                        >
                          <option value="">选择匹配歌曲</option>
                          {catalog.songs.map((song) => <option key={song.id} value={song.id}>{song.title}</option>)}
                        </select>
                        <button type="button" onClick={() => matchRequest(request)}>确认</button>
                      </div>
                    )}
                    <div className="song-control-row-actions">
                      <button type="button" aria-label={`上移 ${getRequestDisplayTitle(request)}`} disabled={index === 0 || pending.has(`reorder:${queueData.session.public_id}`)} onClick={() => moveRequest(request, -1)}>上移</button>
                      <button type="button" aria-label={`下移 ${getRequestDisplayTitle(request)}`} disabled={index === reorderable.length - 1 || pending.has(`reorder:${queueData.session.public_id}`)} onClick={() => moveRequest(request, 1)}>下移</button>
                      {request.status === 'queued' && <button type="button" onClick={() => transitionRequest(request, 'activate')}>设为当前</button>}
                      <button type="button" className="danger-text" onClick={() => removeRequest(request)}>移除</button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}

      <section className="song-control-section" aria-labelledby="manual-song-title">
        <div className="song-request-section-heading">
          <div>
            <p className="section-kicker">主播手动</p>
            <h2 id="manual-song-title">从歌曲库加歌</h2>
          </div>
          <input
            type="search"
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            placeholder="搜索歌名、歌手或别名"
            aria-label="搜索手动加歌"
          />
        </div>
        <div className="song-control-catalog">
          {catalog.songs.map((song) => (
            <div key={song.id}>
              <span><strong>{song.title}</strong><small>{song.artist}</small></span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!queueData?.session || pending.has(`manual:${queueData?.session?.public_id}:${song.id}`)}
                onClick={() => addManualSong(song)}
              >
                {pending.has(`manual:${queueData?.session?.public_id}:${song.id}`) ? '添加中...' : '加入队列'}
              </button>
            </div>
          ))}
          {catalog.songs.length === 0 && <div className="song-request-empty compact">没有找到歌曲</div>}
        </div>
      </section>

      <section className="song-control-section" aria-labelledby="song-history-title">
        <div className="song-request-section-heading">
          <div>
            <p className="section-kicker">操作记录</p>
            <h2 id="song-history-title">点歌历史</h2>
          </div>
        </div>
        <form
          className="song-history-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setHistoryFilters((current) => ({ ...current, page: 1 }));
          }}
        >
          <input
            type="search"
            value={historyFilters.query}
            onChange={(event) => setHistoryFilters((current) => ({ ...current, query: event.target.value, page: 1 }))}
            placeholder="搜索歌曲、歌手或点歌者"
            aria-label="搜索点歌历史"
          />
          <select
            value={historyFilters.status}
            onChange={(event) => setHistoryFilters((current) => ({ ...current, status: event.target.value, page: 1 }))}
            aria-label="按状态筛选"
          >
            <option value="">全部状态</option>
            {HISTORY_STATUSES.map((status) => <option key={status} value={status}>{REQUEST_STATUS_LABELS[status]}</option>)}
          </select>
          <select
            value={historyFilters.source}
            onChange={(event) => setHistoryFilters((current) => ({ ...current, source: event.target.value, page: 1 }))}
            aria-label="按来源筛选"
          >
            <option value="">全部来源</option>
            {HISTORY_SOURCES.map((source) => <option key={source} value={source}>{REQUEST_SOURCE_LABELS[source]}</option>)}
          </select>
          <button type="button" className="btn btn-secondary" onClick={() => setHistoryFilters({ query: '', status: '', source: '', page: 1 })}>清除筛选</button>
        </form>
        {history.requests.length === 0 ? (
          <div className="song-request-empty compact">暂无符合条件的历史记录</div>
        ) : (
          <div className="song-history-list">
            {history.requests.map((request) => (
              <article key={request.public_id}>
                <div>
                  <strong>{getRequestDisplayTitle(request)}</strong>
                  <span>{request.matched_song?.artist || '未匹配歌曲'}</span>
                </div>
                <span>{request.requester_display_name || '未公开点歌者'}</span>
                <span>{REQUEST_SOURCE_LABELS[request.source] || request.source}</span>
                <span>{REQUEST_STATUS_LABELS[request.status] || request.status}</span>
                <time dateTime={request.requested_at}>{new Date(request.requested_at).toLocaleString('zh-CN')}</time>
                <small>{request.last_actor_display_name ? `操作人：${request.last_actor_display_name}` : '系统记录'}</small>
              </article>
            ))}
          </div>
        )}
        <div className="song-history-pagination">
          <button
            type="button"
            disabled={history.pagination.page <= 1}
            onClick={() => setHistoryFilters((current) => ({ ...current, page: current.page - 1 }))}
          >
            上一页
          </button>
          <span>第 {history.pagination.page} / {history.pagination.totalPages} 页，共 {history.pagination.total} 条</span>
          <button
            type="button"
            disabled={history.pagination.page >= history.pagination.totalPages}
            onClick={() => setHistoryFilters((current) => ({ ...current, page: current.page + 1 }))}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );
}

export default SongRequestControl;
