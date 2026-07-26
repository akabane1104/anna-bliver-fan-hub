import React from 'react';
import { InlineAlert } from './FeedbackProvider';
import {
  formatEtaRange,
  getRequestDisplayTitle,
  normalizeSongRequestCenter,
  REQUEST_STATUS_LABELS
} from '../utils/songRequestUi';

function QueueSong({ request, label }) {
  if (!request) {
    return (
      <div className="song-queue-highlight song-queue-highlight-empty">
        <span>{label}</span>
        <strong>暂无歌曲</strong>
      </div>
    );
  }
  return (
    <div className="song-queue-highlight">
      <span>{label}</span>
      <strong>{getRequestDisplayTitle(request)}</strong>
      {request.canonicalSong?.artist && <small>{request.canonicalSong.artist}</small>}
      <small>{formatEtaRange(request.eta)}</small>
    </div>
  );
}

export default function PublicSongQueue({
  data,
  loading,
  error,
  onRetry,
  lastAccepted
}) {
  const center = normalizeSongRequestCenter(data);
  const closeReason = center.closeReason || (
    center.autoCapacityBlocked
      ? '队列人数或预计等待时间已达到上限'
      : '主播目前暂停接收点歌'
  );

  return (
    <section className="public-song-queue" aria-labelledby="public-song-queue-title" aria-live="polite">
      <div className="song-request-section-heading">
        <div>
          <p className="section-kicker">统一点歌队列</p>
          <h2 id="public-song-queue-title">当前点歌进度</h2>
          {data && (
            <p className={`song-center-open-state ${center.effectiveOpen ? 'open' : 'closed'}`}>
              {center.effectiveOpen ? '点歌开放中' : `点歌已关闭：${closeReason}`}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary song-request-refresh"
          onClick={onRetry}
          disabled={loading}
        >
          {loading ? '刷新中...' : '刷新队列'}
        </button>
      </div>

      {lastAccepted && (
        <InlineAlert type="success" title="已加入队列">
          《{getRequestDisplayTitle(lastAccepted)}》
          {(lastAccepted.position || lastAccepted.queue_order)
            ? `，当前排队序号 ${lastAccepted.position || lastAccepted.queue_order}`
            : ''}
        </InlineAlert>
      )}
      {error && (
        <InlineAlert type="error" title="队列加载失败">
          {error}
        </InlineAlert>
      )}
      {!data && !loading ? (
        <div className="song-request-empty">
          <strong>暂时无法取得公开队列</strong>
          <span>歌单仍可浏览，可以稍后重新刷新。</span>
        </div>
      ) : (
        <>
          <div className="song-queue-summary">
            <QueueSong request={center.current} label="正在唱" />
            <QueueSong request={center.next} label="下一首" />
            <div className="song-queue-count" aria-label={`队列容量 ${center.capacityCount} / ${center.queueLimit}`}>
              <span>队列容量</span>
              <strong>{center.capacityCount}/{center.queueLimit}</strong>
              <small>回落至 {center.reopenThreshold} 首后可自动重开</small>
            </div>
          </div>
          {center.queue.length === 0 ? (
            <div className="song-request-empty compact">
              <strong>等待队列为空</strong>
              <span>选一首喜欢的歌加入队列吧。</span>
            </div>
          ) : (
            <ol className="public-queue-list">
              {center.queue.map((request, index) => (
                <li key={request.displayKey || `${request.position || index}-${getRequestDisplayTitle(request)}`}>
                  <span className="queue-position">{request.position || '-'}</span>
                  <span className="queue-song-copy">
                    <strong>{getRequestDisplayTitle(request)}</strong>
                    <small>
                      {request.canonicalSong?.artist || '待主播确认'}
                      {request.maskedDisplayName ? ` · ${request.maskedDisplayName}` : ''}
                    </small>
                    <small>{formatEtaRange(request.eta)}</small>
                  </span>
                  <span className={`request-status request-status-${request.status}`}>
                    {REQUEST_STATUS_LABELS[request.status] || request.status}
                    {request.isMine ? ' · 我的点歌' : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {center.activity && (
            <aside className="song-center-activity">
              <span>今日活动</span>
              <strong>{center.activity.title}</strong>
              {center.activity.content && <p>{center.activity.content}</p>}
            </aside>
          )}
          {center.todayCompleted.length > 0 && (
            <div className="song-center-today">
              <h3>今天已唱</h3>
              <ul>
                {center.todayCompleted.map((request, index) => (
                  <li key={request.displayKey || `${getRequestDisplayTitle(request)}-${index}`}>
                    {getRequestDisplayTitle(request)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {center.updatedAt && (
            <p className="song-center-updated">
              队列更新于 <time dateTime={center.updatedAt}>{new Date(center.updatedAt).toLocaleString('zh-CN')}</time>
            </p>
          )}
        </>
      )}
    </section>
  );
}
