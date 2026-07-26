import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BackButton from '../components/BackButton';
import LiveAdminNav from '../components/LiveAdminNav';
import { InlineAlert, useFeedback } from '../components/FeedbackProvider';
import { songRequestService } from '../services';
import {
  createRequestCoordinator,
  formatEtaRange,
  getRequestDisplayTitle,
  isReorderable,
  normalizeAvailability,
  normalizeRequestStatus,
  requestErrorMessage,
  REQUEST_REASON_LABELS,
  REQUEST_SOURCE_LABELS,
  REQUEST_STATUS_LABELS,
  splitCurrentQueue
} from '../utils/songRequestUi';

const HISTORY_STATUSES = [
  'pending_review',
  'queued',
  'singing',
  'completed',
  'skipped',
  'rejected',
  'withdrawn'
];
const HISTORY_SOURCES = ['website', 'manual', 'bilibili_danmaku', 'simulation', 'replay'];
const ACTION_REASON_CODES = [
  'manual_rejection',
  'manual_skip',
  'technical_issue',
  'singer_unavailable',
  'other'
];
const EMPTY_REASON = Object.freeze({
  reasonCode: 'other',
  publicReason: '',
  internalNote: ''
});
const EMPTY_POLICY = Object.freeze({
  blocked: false,
  publicReason: '',
  internalNote: '',
  expiresAt: '',
  specialEventTagId: '',
  durationOverrideSeconds: '',
  expectedVersion: 0
});

function defaultReasonForAction(action) {
  if (action === 'skip') return 'manual_skip';
  if (action === 'reject') return 'manual_rejection';
  return 'other';
}

function reasonForAction(action, draft = EMPTY_REASON) {
  return {
    reasonCode: draft.reasonCode || defaultReasonForAction(action),
    publicReason: draft.publicReason?.trim() || '',
    internalNote: draft.internalNote?.trim() || ''
  };
}

function RequestReasonEditor({ request, value, onChange }) {
  return (
    <div className="song-control-reason-editor" aria-label={`处理原因：${getRequestDisplayTitle(request)}`}>
      <select
        value={value.reasonCode}
        onChange={(event) => onChange({ ...value, reasonCode: event.target.value })}
        aria-label={`选择 ${getRequestDisplayTitle(request)} 的处理原因`}
      >
        {ACTION_REASON_CODES.map((code) => (
          <option key={code} value={code}>{REQUEST_REASON_LABELS[code]}</option>
        ))}
      </select>
      <input
        value={value.publicReason}
        maxLength="200"
        placeholder="给观众看的补充说明"
        onChange={(event) => onChange({ ...value, publicReason: event.target.value })}
        aria-label={`公开说明：${getRequestDisplayTitle(request)}`}
      />
      <input
        value={value.internalNote}
        maxLength="500"
        placeholder="内部备注，不对外显示"
        onChange={(event) => onChange({ ...value, internalNote: event.target.value })}
        aria-label={`内部备注：${getRequestDisplayTitle(request)}`}
      />
    </div>
  );
}

function RequestSummary({ request, emptyText }) {
  if (!request) return <span className="song-control-empty-inline">{emptyText}</span>;
  return (
    <div className="song-control-summary-song">
      <strong>{getRequestDisplayTitle(request)}</strong>
      <span>{request.matched_song?.artist || '待确认歌曲'}</span>
      <small>{request.requester_display_name || '未公开点歌者'}</small>
      <small>{formatEtaRange(request.eta)}</small>
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
  const [saveAliasByRequest, setSaveAliasByRequest] = useState({});
  const [reasonDrafts, setReasonDrafts] = useState({});
  const [policyDrafts, setPolicyDrafts] = useState({});
  const [managedSongId, setManagedSongId] = useState(null);
  const [songAliases, setSongAliases] = useState({});
  const [aliasDrafts, setAliasDrafts] = useState({});
  const [draggedRequestId, setDraggedRequestId] = useState('');
  const [queueSettings, setQueueSettings] = useState(null);
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
    || resourceErrors.settings
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

  const loadSettings = useCallback(async () => {
    const token = requestCoordinator.current.begin('settings');
    try {
      const result = await songRequestService.getAdminSettings();
      if (!requestCoordinator.current.isCurrent(token)) return;
      setQueueSettings(result.settings || result);
      commitResourceError(token, '');
    } catch (nextError) {
      commitResourceError(token, requestErrorMessage(nextError, '加载点歌设置'));
    }
  }, [commitResourceError]);

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
    loadSettings();
  }, [loadSettings]);

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
    await Promise.all([loadSessions(), loadQueue(), loadHistory(), loadSettings()]);
  }, [loadHistory, loadQueue, loadSessions, loadSettings]);

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

  const transitionRequest = (request, action, details = null) => runAction(
    `request:${request.public_id}`,
    async () => {
      const draft = reasonDrafts[request.public_id] || {
        ...EMPTY_REASON,
        reasonCode: defaultReasonForAction(action)
      };
      const options = details || (
        ['skip', 'reject'].includes(action)
          ? reasonForAction(action, draft)
          : null
      );
      if (options) {
        await songRequestService.transitionRequest(
          request.public_id,
          action,
          request.version,
          options
        );
      } else {
        await songRequestService.transitionRequest(
          request.public_id,
          action,
          request.version
        );
      }
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
    const status = normalizeRequestStatus(request.status);
    const action = status === 'pending_review' ? 'reject' : 'cancel';
    const accepted = await confirm({
      title: '移除等待歌曲',
      message: `确定移除《${getRequestDisplayTitle(request)}》吗？`,
      detail: status === 'pending_review'
        ? '待确认请求会被拒绝并写入点歌历史。'
        : '已排队请求会被撤回并写入点歌历史。',
      confirmText: '确认移除',
      variant: 'danger'
    });
    if (accepted) transitionRequest(
      request,
      action,
      reasonForAction(action, reasonDrafts[request.public_id] || {
        ...EMPTY_REASON,
        reasonCode: status === 'pending_review' ? 'manual_rejection' : 'other'
      })
    );
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

  const reorderRequests = (next) => runAction(
    `reorder:${queueData.session.public_id}`,
    async () => {
      await songRequestService.reorder(
        queueData.session.public_id,
        queueData.session.version,
        next.map(({ public_id }) => public_id)
      );
      toast('等待顺序已更新', { type: 'success' });
    }
  );

  const moveRequest = (request, direction) => {
    const index = reorderable.findIndex(({ public_id }) => public_id === request.public_id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= reorderable.length) return;
    const next = [...reorderable];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    reorderRequests(next);
  };

  const moveRequestToPosition = (request, position) => {
    const sourceIndex = reorderable.findIndex(({ public_id }) => public_id === request.public_id);
    const targetIndex = Math.min(
      reorderable.length - 1,
      Math.max(0, Number(position) - 1)
    );
    if (sourceIndex < 0 || sourceIndex === targetIndex) return;
    const next = [...reorderable];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    reorderRequests(next);
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
      await songRequestService.matchRequest(
        request.public_id,
        request.version,
        songId,
        { saveAlias: Boolean(saveAliasByRequest[request.public_id]) }
      );
      toast('歌曲匹配已确认', { type: 'success' });
    });
  };

  const updateReasonDraft = (publicId, value) => {
    setReasonDrafts((current) => ({ ...current, [publicId]: value }));
  };

  const updatePolicyDraft = (songId, value) => {
    setPolicyDrafts((current) => ({ ...current, [songId]: value }));
  };

  const policyDraftFromResponse = (policy = null) => ({
    blocked: Boolean(policy?.blocked),
    publicReason: policy?.public_reason || '',
    internalNote: policy?.internal_note || '',
    expiresAt: policy?.expires_at
      ? new Date(policy.expires_at).toISOString().slice(0, 16)
      : '',
    specialEventTagId: policy?.special_event_tag_id ?? '',
    durationOverrideSeconds: policy?.duration_override_seconds ?? '',
    expectedVersion: Number(policy?.version || 0)
  });

  const openSongManagement = (song) => runAction(`manage-song:${song.id}`, async () => {
    const [policyResult, aliasResult] = await Promise.all([
      songRequestService.getSongPolicy(song.id),
      songRequestService.getSongAliases(song.id)
    ]);
    setManagedSongId(song.id);
    updatePolicyDraft(song.id, policyDraftFromResponse(policyResult.policy));
    setSongAliases((current) => ({
      ...current,
      [song.id]: aliasResult.aliases || []
    }));
  });

  const setSongPolicy = (song, blocked) => {
    const draft = policyDrafts[song.id] || EMPTY_POLICY;
    return runAction(`policy:${song.id}`, async () => {
      const result = await songRequestService.setSongPolicy(song.id, {
        blocked,
        publicReason: draft.publicReason,
        internalNote: draft.internalNote,
        expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
        specialEventTagId: draft.specialEventTagId === ''
          ? null
          : Number(draft.specialEventTagId),
        durationOverrideSeconds: draft.durationOverrideSeconds === ''
          ? null
          : Number(draft.durationOverrideSeconds),
        expectedVersion: draft.expectedVersion
      });
      updatePolicyDraft(song.id, policyDraftFromResponse(result.policy));
      toast(blocked ? '歌曲已暂时封锁' : '歌曲封锁已解除', { type: 'success' });
    });
  };

  const addAlias = (song) => {
    const alias = (aliasDrafts[song.id] || '').trim();
    if (!alias) return;
    return runAction(`alias-add:${song.id}`, async () => {
      await songRequestService.addSongAlias(song.id, alias);
      const result = await songRequestService.getSongAliases(song.id);
      setSongAliases((current) => ({ ...current, [song.id]: result.aliases || [] }));
      setAliasDrafts((current) => ({ ...current, [song.id]: '' }));
      toast('歌曲别名已加入', { type: 'success' });
    });
  };

  const deleteAlias = (song, alias) => runAction(`alias-delete:${alias.id}`, async () => {
    await songRequestService.deleteSongAlias(alias.id);
    setSongAliases((current) => ({
      ...current,
      [song.id]: (current[song.id] || []).filter(({ id }) => id !== alias.id)
    }));
    toast('歌曲别名已删除', { type: 'success' });
  });

  const saveQueueSettings = () => runAction('queue-settings', async () => {
    await songRequestService.updateAdminSettings(queueSettings);
    toast('点歌容量与时间设置已保存', { type: 'success' });
  });

  const queueSettingsValid = useMemo(() => {
    if (!queueSettings) return false;
    const queueLimit = Number(queueSettings.queue_limit);
    const reopenThreshold = Number(queueSettings.reopen_threshold);
    const maxEtaMinutes = Number(queueSettings.max_eta_minutes);
    const reopenEtaMinutes = Number(queueSettings.reopen_eta_minutes);
    const defaultSongSeconds = Number(queueSettings.default_song_seconds);
    const bufferSeconds = Number(queueSettings.buffer_seconds);
    const cooldownMinutes = Number(queueSettings.cooldown_minutes);
    return (
      Number.isFinite(queueLimit)
      && queueLimit >= 1
      && Number.isFinite(reopenThreshold)
      && reopenThreshold >= 0
      && reopenThreshold < queueLimit
      && Number.isFinite(maxEtaMinutes)
      && maxEtaMinutes >= 1
      && Number.isFinite(reopenEtaMinutes)
      && reopenEtaMinutes >= 0
      && reopenEtaMinutes < maxEtaMinutes
      && Number.isFinite(defaultSongSeconds)
      && defaultSongSeconds >= 30
      && Number.isFinite(bufferSeconds)
      && bufferSeconds >= 0
      && Number.isFinite(cooldownMinutes)
      && cooldownMinutes >= 0
    );
  }, [queueSettings]);

  const toggleEtaPaused = () => runAction('eta-paused', async () => {
    await songRequestService.setEtaPaused(
      !queueSettings?.eta_paused,
      queueSettings?.revision
    );
    toast(queueSettings?.eta_paused ? 'ETA 已恢复' : 'ETA 已暂停', { type: 'success' });
  });

  const undoLastAction = () => {
    const undo = queueData?.undo || {};
    return runAction('undo', async () => {
      await songRequestService.undoLastAction(
        undo.expected_revision ?? queueData?.revision
      );
      toast('最近一次队列操作已撤销', { type: 'success' });
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
              <div className="song-control-queue-meta">
                <span className="song-control-waiting-count">等待 {publicQueue.waitingCount} 首</span>
                <span>Revision {queueData?.revision ?? '-'}</span>
                {queueData?.undo?.available && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={pending.has('undo')}
                    onClick={undoLastAction}
                  >
                    撤销最近操作（{Number(queueData.undo.seconds_remaining ?? 30)} 秒）
                  </button>
                )}
              </div>
            </div>
            <div className="song-control-now-grid">
              <div><span>目前处理</span><RequestSummary request={publicQueue.active} emptyText="尚未开始歌曲" /></div>
              <div><span>下一首</span><RequestSummary request={publicQueue.next} emptyText="等待队列为空" /></div>
            </div>

            {publicQueue.active && (
              <div className="song-control-active-row">
                <RequestSummary request={publicQueue.active} />
                <RequestReasonEditor
                  request={publicQueue.active}
                  value={reasonDrafts[publicQueue.active.public_id] || {
                    ...EMPTY_REASON,
                    reasonCode: 'manual_skip'
                  }}
                  onChange={(value) => updateReasonDraft(publicQueue.active.public_id, value)}
                />
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
                  <li
                    key={request.public_id}
                    draggable={!pending.has(`reorder:${queueData.session.public_id}`)}
                    aria-grabbed={draggedRequestId === request.public_id}
                    onDragStart={() => setDraggedRequestId(request.public_id)}
                    onDragEnd={() => setDraggedRequestId('')}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const dragged = reorderable.find(
                        ({ public_id }) => public_id === draggedRequestId
                      );
                      if (dragged) {
                        moveRequestToPosition(dragged, index + 1);
                      }
                      setDraggedRequestId('');
                    }}
                  >
                    <label className="queue-position">
                      <span className="sr-only">队列位置</span>
                      <input
                        type="number"
                        min="1"
                        max={reorderable.length}
                        value={index + 1}
                        aria-label={`调整 ${getRequestDisplayTitle(request)} 的队列位置`}
                        onChange={(event) => moveRequestToPosition(request, event.target.value)}
                      />
                    </label>
                    <span className="queue-song-copy">
                      <strong>{getRequestDisplayTitle(request)}</strong>
                      <small>
                        {request.matched_song?.artist || '待人工匹配'} · {request.requester_display_name || '未公开点歌者'} · {REQUEST_SOURCE_LABELS[request.source] || request.source}
                      </small>
                    </span>
                    <span className={`request-status request-status-${normalizeRequestStatus(request.status)}`}>
                      {REQUEST_STATUS_LABELS[normalizeRequestStatus(request.status)]}
                    </span>
                    {normalizeRequestStatus(request.status) === 'pending_review' && (
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
                        <label className="song-control-save-alias">
                          <input
                            type="checkbox"
                            checked={Boolean(saveAliasByRequest[request.public_id])}
                            onChange={(event) => setSaveAliasByRequest((current) => ({
                              ...current,
                              [request.public_id]: event.target.checked
                            }))}
                          />
                          保存原始输入为别名
                        </label>
                        <button type="button" onClick={() => matchRequest(request)}>确认</button>
                        {(request.match_method || request.match_confidence !== undefined) && (
                          <small>
                            建议：{request.match_method || 'unknown'}
                            {request.match_confidence !== undefined
                              ? ` · ${Math.round(Number(request.match_confidence) * 100)}%`
                              : ''}
                          </small>
                        )}
                      </div>
                    )}
                    <RequestReasonEditor
                      request={request}
                      value={reasonDrafts[request.public_id] || {
                        ...EMPTY_REASON,
                        reasonCode: 'manual_rejection'
                      }}
                      onChange={(value) => updateReasonDraft(request.public_id, value)}
                    />
                    <div className="song-control-row-actions">
                      <button type="button" aria-label={`上移 ${getRequestDisplayTitle(request)}`} disabled={index === 0 || pending.has(`reorder:${queueData.session.public_id}`)} onClick={() => moveRequest(request, -1)}>上移</button>
                      <button type="button" aria-label={`下移 ${getRequestDisplayTitle(request)}`} disabled={index === reorderable.length - 1 || pending.has(`reorder:${queueData.session.public_id}`)} onClick={() => moveRequest(request, 1)}>下移</button>
                      {normalizeRequestStatus(request.status) === 'queued' && (
                        <button type="button" onClick={() => transitionRequest(request, 'activate')}>设为当前</button>
                      )}
                      <button type="button" className="danger-text" onClick={() => removeRequest(request)}>
                        {normalizeRequestStatus(request.status) === 'pending_review' ? '拒绝' : '移除'}
                      </button>
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
          {catalog.songs.map((song) => {
            const availability = normalizeAvailability(song);
            const policy = policyDrafts[song.id] || EMPTY_POLICY;
            return (
              <div key={song.id}>
                <span>
                  <strong>{song.title}</strong>
                  <small>{song.artist}</small>
                  {availability.temporarilyBlocked && <small>暂时封锁中</small>}
                </span>
                <div className="song-control-row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!queueData?.session || pending.has(`manual:${queueData?.session?.public_id}:${song.id}`)}
                    onClick={() => addManualSong(song)}
                  >
                    {pending.has(`manual:${queueData?.session?.public_id}:${song.id}`) ? '添加中...' : '加入队列'}
                  </button>
                  <button
                    type="button"
                    disabled={pending.has(`manage-song:${song.id}`)}
                    onClick={() => (
                      managedSongId === song.id
                        ? setManagedSongId(null)
                        : openSongManagement(song)
                    )}
                  >
                    {managedSongId === song.id ? '收起管理' : '歌曲规则与别名'}
                  </button>
                </div>
                {managedSongId === song.id && (
                  <div className="song-policy-editor">
                    <div className="song-policy-fields">
                      <input
                        value={policy.publicReason}
                        maxLength="200"
                        placeholder="公开封锁原因"
                        onChange={(event) => updatePolicyDraft(song.id, {
                          ...policy,
                          publicReason: event.target.value
                        })}
                        aria-label={`《${song.title}》公开封锁原因`}
                      />
                      <input
                        value={policy.internalNote}
                        maxLength="500"
                        placeholder="内部备注"
                        onChange={(event) => updatePolicyDraft(song.id, {
                          ...policy,
                          internalNote: event.target.value
                        })}
                        aria-label={`《${song.title}》封锁内部备注`}
                      />
                      <label>
                        <span>封锁到期时间</span>
                        <input
                          type="datetime-local"
                          value={policy.expiresAt}
                          onChange={(event) => updatePolicyDraft(song.id, {
                            ...policy,
                            expiresAt: event.target.value
                          })}
                          aria-label={`《${song.title}》封锁到期时间`}
                        />
                      </label>
                      <label>
                        <span>限定活动标签 ID</span>
                        <input
                          type="number"
                          min="1"
                          value={policy.specialEventTagId}
                          onChange={(event) => updatePolicyDraft(song.id, {
                            ...policy,
                            specialEventTagId: event.target.value
                          })}
                        />
                      </label>
                      <label>
                        <span>预计时长（秒）</span>
                        <input
                          type="number"
                          min="30"
                          max="7200"
                          value={policy.durationOverrideSeconds}
                          onChange={(event) => updatePolicyDraft(song.id, {
                            ...policy,
                            durationOverrideSeconds: event.target.value
                          })}
                        />
                      </label>
                    </div>
                    <div className="song-control-row-actions">
                      {policy.blocked ? (
                        <button type="button" onClick={() => setSongPolicy(song, false)}>
                          解除封锁并保存规则
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!policy.publicReason.trim()}
                          onClick={() => setSongPolicy(song, true)}
                        >
                          暂时封锁并保存规则
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSongPolicy(song, policy.blocked)}
                      >
                        保存活动与时长
                      </button>
                    </div>
                    <div className="song-alias-editor">
                      <strong>已确认别名</strong>
                      {(songAliases[song.id] || []).length > 0 ? (
                        <ul>
                          {(songAliases[song.id] || []).map((alias) => (
                            <li key={alias.id}>
                              <span>{alias.alias}</span>
                              <button
                                type="button"
                                aria-label={`删除别名 ${alias.alias}`}
                                onClick={() => deleteAlias(song, alias)}
                              >
                                删除
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : <span>尚无别名</span>}
                      <div>
                        <input
                          value={aliasDrafts[song.id] || ''}
                          maxLength="200"
                          placeholder="新增别名"
                          aria-label={`为《${song.title}》新增别名`}
                          onChange={(event) => setAliasDrafts((current) => ({
                            ...current,
                            [song.id]: event.target.value
                          }))}
                        />
                        <button
                          type="button"
                          disabled={!(aliasDrafts[song.id] || '').trim()}
                          onClick={() => addAlias(song)}
                        >
                          加入别名
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {catalog.songs.length === 0 && <div className="song-request-empty compact">没有找到歌曲</div>}
        </div>
      </section>

      {queueSettings && (
        <section className="song-control-section" aria-labelledby="queue-settings-title">
          <div className="song-request-section-heading">
            <div>
              <p className="section-kicker">容量与时间</p>
              <h2 id="queue-settings-title">点歌 ETA 设置</h2>
            </div>
            <button type="button" className="btn btn-secondary" onClick={toggleEtaPaused}>
              {queueSettings.eta_paused ? '恢复 ETA' : '暂停 ETA'}
            </button>
          </div>
          <div className="song-queue-settings-grid">
            {[
              ['cooldown_minutes', '完成后冷却（分钟）', 0],
              ['queue_limit', '自动关闭容量', 1],
              ['reopen_threshold', '自动重开容量', 0],
              ['max_eta_minutes', '自动关闭 ETA（分钟）', 1],
              ['reopen_eta_minutes', '自动重开 ETA（分钟）', 0],
              ['default_song_seconds', '默认歌曲秒数', 30],
              ['buffer_seconds', '歌曲间缓冲秒数', 0]
            ].map(([field, label, min]) => (
              <label key={field}>
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  value={queueSettings[field] ?? ''}
                  onChange={(event) => setQueueSettings((current) => ({
                    ...current,
                    [field]: event.target.value === '' ? '' : Number(event.target.value)
                  }))}
                />
              </label>
            ))}
            <label>
              <span>当前活动标签 ID</span>
              <input
                type="number"
                min="1"
                value={queueSettings.active_event_tag_id ?? ''}
                onChange={(event) => setQueueSettings((current) => ({
                  ...current,
                  active_event_tag_id: event.target.value === ''
                    ? null
                    : Number(event.target.value)
                }))}
              />
            </label>
            <label className="song-control-checkbox-setting">
              <input
                type="checkbox"
                checked={Boolean(queueSettings.block_repeat_today)}
                onChange={(event) => setQueueSettings((current) => ({
                  ...current,
                  block_repeat_today: event.target.checked
                }))}
              />
              <span>今天唱过的歌曲不可重复点</span>
            </label>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending.has('queue-settings') || !queueSettingsValid}
            onClick={saveQueueSettings}
          >
            保存点歌规则与 ETA
          </button>
          <small>设置版本 {queueSettings.revision}</small>
        </section>
      )}

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
                <span>{REQUEST_STATUS_LABELS[normalizeRequestStatus(request.status)] || request.status}</span>
                <time dateTime={request.requested_at}>{new Date(request.requested_at).toLocaleString('zh-CN')}</time>
                <small>{request.last_actor_display_name ? `操作人：${request.last_actor_display_name}` : '系统记录'}</small>
                {normalizeRequestStatus(request.status) === 'skipped' && (
                  <button
                    type="button"
                    disabled={pending.has(`request:${request.public_id}`)}
                    onClick={() => transitionRequest(request, 'restore')}
                  >
                    恢复到队列
                  </button>
                )}
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
