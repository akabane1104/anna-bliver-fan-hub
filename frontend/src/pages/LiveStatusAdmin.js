import React, { useCallback } from 'react';
import LiveAdminNav from '../components/LiveAdminNav';
import { liveAdminService } from '../services';
import {
  CONNECTION_STATE_LABELS,
  LISTENER_AVAILABILITY_LABELS,
  SESSION_STATUS_LABELS,
  formatLiveAdminDate,
  liveAdminErrorMessage,
  statusTone
} from '../utils/liveAdminUi';
import usePollingResource from '../utils/usePollingResource';

function StatusBadge({ value, label }) {
  return (
    <span className={`live-status-badge ${statusTone(value)}`}>
      <span className="live-status-dot" aria-hidden="true" />
      {label || value || '未知'}
    </span>
  );
}

function BooleanValue({ value }) {
  if (value === null || value === undefined) return <span>未知</span>;
  return <span>{value ? '是' : '否'}</span>;
}

function LiveStatusAdmin() {
  const loader = useCallback(
    ({ signal }) => liveAdminService.getStatus({ signal }),
    []
  );
  const {
    data,
    error,
    loading,
    refreshing,
    lastSuccessAt,
    refresh
  } = usePollingResource(loader, { intervalMs: 5000, autoRefresh: true });

  return (
    <div className="live-admin-page live-status-page">
      <header className="live-admin-header">
        <div>
          <p className="live-admin-eyebrow">直播管理</p>
          <h1>直播状态</h1>
          <p>分别查看网站场次、Listener 状态与 B站连接状态。</p>
        </div>
        <button
          type="button"
          className="live-admin-refresh"
          onClick={refresh}
          disabled={loading || refreshing}
          aria-label="刷新直播状态"
        >
          <span aria-hidden="true">↻</span>
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </header>

      <LiveAdminNav />

      {loading && !data && (
        <div className="live-admin-loading" role="status">正在读取直播状态...</div>
      )}

      {error && (
        <div className="live-admin-alert negative" role="alert">
          <div>
            <strong>状态读取失败</strong>
            <span>{liveAdminErrorMessage(error, '直播状态')}</span>
          </div>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      )}

      {data && (
        <>
          <div className="live-admin-update-line">
            <StatusBadge
              value={data.completeness}
              label={data.completeness === 'complete' ? '状态完整' : '部分状态可用'}
            />
            <span>最后成功更新：{formatLiveAdminDate(lastSuccessAt)}</span>
            <span>服务器时间：{formatLiveAdminDate(data.server_time)}</span>
          </div>

          {data.completeness === 'partial' && (
            <div className="live-admin-alert warning">
              <div>
                <strong>当前只取得部分状态</strong>
                <span>可用区块仍会正常显示，未上报的数据不会被推测为已连接。</span>
              </div>
            </div>
          )}

          <section className="live-admin-section" aria-labelledby="system-status-title">
            <div className="live-admin-section-heading">
              <div>
                <h2 id="system-status-title">系统状态</h2>
                <p>Backend 可用与 B站连接是彼此独立的状态。</p>
              </div>
            </div>
            <div className="live-status-metrics">
              <article>
                <span>Backend API</span>
                <StatusBadge
                  value={data.backend?.status}
                  label={data.backend?.status === 'available' ? '可用' : '不可用'}
                />
              </article>
              <article>
                <span>Database 查询</span>
                <StatusBadge
                  value={data.database?.status}
                  label={data.database?.status === 'available' ? '可用' : '不可用'}
                />
              </article>
              <article>
                <span>状态完整度</span>
                <strong>{data.completeness === 'complete' ? '完整' : '部分可用'}</strong>
              </article>
              <article>
                <span>已保存事件</span>
                <strong>
                  {data.ingestion?.total_saved === null ? '未知' : data.ingestion?.total_saved || 0}
                </strong>
              </article>
            </div>
          </section>

          <section className="live-admin-section" aria-labelledby="session-status-title">
            <div className="live-admin-section-heading">
              <div>
                <h2 id="session-status-title">网站直播场次</h2>
                <p>场次开放只表示网站正在接收点歌，不代表 B站 WSS 已连接。</p>
              </div>
              <StatusBadge
                value={data.sessions?.state}
                label={
                  data.sessions?.state === 'none'
                    ? '无进行中场次'
                    : (data.sessions?.state === 'conflict'
                      ? '多个场次待选择'
                      : '存在进行中场次')
                }
              />
            </div>

            {data.sessions?.state === 'conflict' && (
              <div className="live-admin-alert negative">
                <div>
                  <strong>检测到多个进行中场次</strong>
                  <span>本页不会自行选择其中一场，请分别检查下列目标。</span>
                </div>
              </div>
            )}

            {!data.sessions?.items?.length ? (
              <div className="live-admin-empty">当前没有开放或暂停中的网站直播场次。</div>
            ) : (
              <div className="live-session-list">
                {data.sessions.items.map((session) => (
                  <article key={session.public_id}>
                    <div className="live-session-title">
                      <div>
                        <strong>{session.title}</strong>
                        <span>{session.target?.display_name}</span>
                      </div>
                      <StatusBadge
                        value={session.status}
                        label={SESSION_STATUS_LABELS[session.status] || session.status}
                      />
                    </div>
                    <dl>
                      <div>
                        <dt>开始时间</dt>
                        <dd>{formatLiveAdminDate(session.started_at)}</dd>
                      </div>
                      <div>
                        <dt>最近事件</dt>
                        <dd>{formatLiveAdminDate(session.last_event_at)}</dd>
                      </div>
                      <div>
                        <dt>已保存事件</dt>
                        <dd>{session.saved_event_count}</dd>
                      </div>
                      <div>
                        <dt>当前队列</dt>
                        <dd>{session.queue?.total_current || 0} 条</dd>
                      </div>
                    </dl>
                    <div className="live-session-queue">
                      <span>待确认 {session.queue?.needs_match || 0}</span>
                      <span>等待中 {session.queue?.queued || 0}</span>
                      <span>处理中 {session.queue?.active || 0}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="live-admin-section" aria-labelledby="listener-status-title">
            <div className="live-admin-section-heading">
              <div>
                <h2 id="listener-status-title">Listener / Source Adapter</h2>
                <p>只有 Listener 主动上报的状态才可作为连接依据。</p>
              </div>
              <StatusBadge
                value={data.listener?.availability}
                label={
                  LISTENER_AVAILABILITY_LABELS[data.listener?.availability] ||
                  '状态不可用'
                }
              />
            </div>
            <div className="live-admin-details-grid">
              <dl>
                <div><dt>已启用</dt><dd><BooleanValue value={data.listener?.enabled} /></dd></div>
                <div><dt>已配置</dt><dd><BooleanValue value={data.listener?.configured} /></dd></div>
                <div><dt>安全阻挡</dt><dd><BooleanValue value={data.listener?.blocked} /></dd></div>
                <div><dt>Adapter 状态</dt><dd>{data.listener?.adapter_state || 'unknown'}</dd></div>
              </dl>
              <dl>
                <div><dt>最近状态变化</dt><dd>{formatLiveAdminDate(data.listener?.last_state_change_at)}</dd></div>
                <div><dt>最近接收事件</dt><dd>{formatLiveAdminDate(data.listener?.last_event_received_at)}</dd></div>
                <div><dt>重连次数</dt><dd>{data.listener?.reconnect_count ?? 0}</dd></div>
                <div><dt>安全原因码</dt><dd><code>{data.listener?.reason_code || 'none'}</code></dd></div>
              </dl>
            </div>
          </section>

          <section className="live-admin-section" aria-labelledby="connection-status-title">
            <div className="live-admin-section-heading">
              <div>
                <h2 id="connection-status-title">B站连接</h2>
                <p>最近有事件进入也不能证明当前 API 或 WSS 仍然连接。</p>
              </div>
            </div>
            <div className="live-status-metrics">
              <article>
                <span>B站 API</span>
                <StatusBadge
                  value={data.bilibili_connection?.api_state}
                  label={
                    CONNECTION_STATE_LABELS[data.bilibili_connection?.api_state] ||
                    '未知'
                  }
                />
              </article>
              <article>
                <span>B站 WSS</span>
                <StatusBadge
                  value={data.bilibili_connection?.wss_state}
                  label={
                    CONNECTION_STATE_LABELS[data.bilibili_connection?.wss_state] ||
                    '未知'
                  }
                />
              </article>
              <article>
                <span>连接状态是否权威</span>
                <strong>{data.bilibili_connection?.authoritative ? '是' : '否'}</strong>
              </article>
              <article>
                <span>近 5 分钟入站事件</span>
                <strong>
                  {data.ingestion?.recent_event_count === null
                    ? '未知'
                    : data.ingestion?.recent_event_count || 0}
                </strong>
              </article>
            </div>
            <p className="live-admin-footnote">
              最近保存事件：{formatLiveAdminDate(data.ingestion?.last_event_at)}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

export default LiveStatusAdmin;
