import React from 'react';
import { InlineAlert } from './FeedbackProvider';
import {
  getRequestDisplayTitle,
  REQUEST_STATUS_LABELS,
  splitCurrentQueue
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
      {request.matched_song?.artist && <small>{request.matched_song.artist}</small>}
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
  const queue = splitCurrentQueue(data);

  return (
    <section className="public-song-queue" aria-labelledby="public-song-queue-title">
      <div className="song-request-section-heading">
        <div>
          <p className="section-kicker">统一点歌队列</p>
          <h2 id="public-song-queue-title">当前点歌进度</h2>
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
          {lastAccepted.queue_order ? `，当前排队序号 ${lastAccepted.queue_order}` : ''}
        </InlineAlert>
      )}
      {error && (
        <InlineAlert type="error" title="队列加载失败">
          {error}
        </InlineAlert>
      )}
      {!data?.session && !loading ? (
        <div className="song-request-empty">
          <strong>当前还没有开放点歌</strong>
          <span>歌单仍可浏览，开放后登录账号即可点歌。</span>
        </div>
      ) : (
        <>
          <div className="song-queue-summary">
            <QueueSong request={queue.active} label="正在处理" />
            <QueueSong request={queue.next} label="下一首" />
            <div className="song-queue-count" aria-label={`等待 ${queue.waitingCount} 首`}>
              <span>等待中</span>
              <strong>{queue.waitingCount}</strong>
              <small>首歌曲</small>
            </div>
          </div>
          {queue.waiting.length === 0 ? (
            <div className="song-request-empty compact">
              <strong>等待队列为空</strong>
              <span>选一首喜欢的歌加入队列吧。</span>
            </div>
          ) : (
            <ol className="public-queue-list">
              {queue.waiting.map((request) => (
                <li key={request.public_id}>
                  <span className="queue-position">{request.queue_order || '-'}</span>
                  <span className="queue-song-copy">
                    <strong>{getRequestDisplayTitle(request)}</strong>
                    <small>
                      {request.matched_song?.artist || '待主播确认'}
                      {request.requester_display_name ? ` · ${request.requester_display_name}` : ''}
                    </small>
                  </span>
                  <span className={`request-status request-status-${request.status}`}>
                    {REQUEST_STATUS_LABELS[request.status] || request.status}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
