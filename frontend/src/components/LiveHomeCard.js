import React from 'react';
import { formatEtaRange } from '../utils/songRequestUi';

function SongLine({ label, song, emptyText }) {
  return (
    <div className="live-home-song-line">
      <span>{label}</span>
      {song ? (
        <div>
          <strong title={song.title}>{song.title}</strong>
          <small title={song.artist || ''}>{song.artist || '演唱者待定'}</small>
          {song.eta && <small>{formatEtaRange(song.eta)}</small>}
        </div>
      ) : (
        <em>{emptyText}</em>
      )}
    </div>
  );
}

function SupportItem({ item }) {
  const name = item.display_name || item.displayName || '匿名观众';
  const itemName = item.item_name || item.itemName || '支持';
  return (
    <li title={`${name} · ${itemName}`}>
      <strong>{name}</strong>
      <span>{item.type === 'guard' ? '上舰' : '赠送'} {itemName}</span>
      {Number(item.count) > 1 && <small>× {item.count}</small>}
    </li>
  );
}

function LiveHomeCard({ data, preview = false, showOffline = false }) {
  if (!data || !['offline', 'live', 'syncing'].includes(data.mode)) return null;
  if (data.mode === 'offline' && !showOffline) return null;

  const songRequests = data.song_requests || data.songRequests || {};
  const recentSupport = data.recent_support || data.recentSupport || [];
  const roomUrl = data.room_url || data.roomUrl || null;
  const statusLabel = data.status_label || data.statusLabel || (
    data.mode === 'syncing'
      ? '重新同步中'
      : (data.mode === 'offline' ? '目前未开播' : '直播中')
  );
  const requestsOpen = Boolean(
    songRequests.effectiveOpen
    ?? songRequests.effective_open
    ?? songRequests.open
  );
  const closeReason = songRequests.closeReason || songRequests.close_reason;

  if (data.mode === 'offline') {
    return (
      <section
        className="live-home-card live-home-card-offline live-home-card-preview"
        aria-label="直播首页预览"
      >
        <span className="live-home-status">
          <span className="live-home-status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
        <p>公开首页会保留目前的一般版面，不显示直播卡片。</p>
      </section>
    );
  }

  return (
    <section
      className={`live-home-card live-home-card-${data.mode}${preview ? ' live-home-card-preview' : ''}`}
      aria-label={preview ? '直播首页预览' : '直播信息'}
      aria-live="polite"
    >
      <header className="live-home-card-header">
        <div>
          <span className="live-home-status">
            <span className="live-home-status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <h2>{data.mode === 'syncing' ? '直播讯号重新同步中' : '安娜正在直播'}</h2>
        </div>
        {roomUrl && (
          <a
            className="live-home-room-link"
            href={roomUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            进入B站直播间
          </a>
        )}
      </header>

      <div className="live-home-main">
        <div className="live-home-queue" aria-label="点歌队列">
          <SongLine
            label="正在唱"
            song={songRequests.current}
            emptyText="目前没有正在演唱的歌曲"
          />
          <SongLine
            label="下一首"
            song={songRequests.next}
            emptyText="队列里还没有下一首"
          />
          <div className="live-home-queue-summary">
            <span>排队 {Number(songRequests.queue_count ?? songRequests.queueCount ?? 0)} 首</span>
            <span className={requestsOpen ? 'open' : 'closed'}>
              点歌{requestsOpen ? '开放中' : '已关闭'}
            </span>
          </div>
          {!requestsOpen && closeReason && <p className="live-home-close-reason">{closeReason}</p>}
          <a className="live-home-song-center-link" href="/song-requests">前往点歌中心</a>
        </div>

        {data.activity && (
          <aside className="live-home-activity" aria-label="今日活动">
            <span>今日活动</span>
            <strong>{data.activity.title}</strong>
            <p>{data.activity.content}</p>
          </aside>
        )}
      </div>

      {recentSupport.length > 0 && (
        <div className="live-home-support">
          <h3>最近支持</h3>
          <ul>
            {recentSupport.slice(0, 5).map((item, index) => (
              <SupportItem
                key={`${item.type}-${item.occurred_at || item.occurredAt || 'unknown'}-${index}`}
                item={item}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default LiveHomeCard;
