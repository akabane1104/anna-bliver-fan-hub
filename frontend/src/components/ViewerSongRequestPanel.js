import React from 'react';
import { Link } from 'react-router';
import { InlineAlert } from './FeedbackProvider';
import {
  formatEtaRange,
  getRequestDisplayTitle,
  normalizeRequestStatus,
  REQUEST_REASON_LABELS,
  REQUEST_STATUS_LABELS
} from '../utils/songRequestUi';

const requestId = (request) => request?.publicId || request?.public_id || null;
const requestRevision = (request) => request?.revision ?? request?.version ?? null;

function RequestDetails({ request, active = false, pending, onWithdraw, onRerequest }) {
  if (!request) return null;
  const status = normalizeRequestStatus(request.status);
  const id = requestId(request);
  const canWithdraw = ['pending_review', 'queued'].includes(status);
  const canRerequest = ['completed', 'skipped', 'rejected', 'withdrawn'].includes(status);
  const reasonCode = request.reasonCode || request.reason_code || '';
  const originalInput = request.originalInput || request.original_input || request.requested_title;
  const canonical = getRequestDisplayTitle(request);
  const matchMethod = request.matchMethod || request.match_method;
  const position = Number(request.position ?? request.queue_order ?? 0) || null;
  const ahead = Number(request.aheadCount ?? request.ahead_count);

  return (
    <article className={`viewer-request-card${active ? ' viewer-request-card-active' : ''}`}>
      <header>
        <div>
          <span className={`request-status request-status-${status}`}>
            {REQUEST_STATUS_LABELS[status] || status}
          </span>
          <h3>{canonical}</h3>
        </div>
        {position && <strong className="viewer-request-position">第 {position} 位</strong>}
      </header>
      <dl className="viewer-request-details">
        {originalInput && originalInput !== canonical && (
          <div><dt>原始输入</dt><dd>{originalInput}</dd></div>
        )}
        {matchMethod && <div><dt>匹配方式</dt><dd>{matchMethod}</dd></div>}
        {Number.isFinite(ahead) && <div><dt>前方等待</dt><dd>{ahead} 首</dd></div>}
        <div><dt>预计等待</dt><dd>{formatEtaRange(request.eta)}</dd></div>
        {reasonCode && (
          <div>
            <dt>状态说明</dt>
            <dd>{request.publicReason || request.public_reason || REQUEST_REASON_LABELS[reasonCode] || reasonCode}</dd>
          </div>
        )}
      </dl>
      {(canWithdraw || canRerequest) && (
        <div className="viewer-request-actions">
          {canWithdraw && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!id || pending === `withdraw:${id}`}
              onClick={() => onWithdraw(request, requestRevision(request))}
            >
              {pending === `withdraw:${id}` ? '撤回中...' : '撤回点歌'}
            </button>
          )}
          {canRerequest && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!id || pending === `rerequest:${id}`}
              onClick={() => onRerequest(request)}
            >
              {pending === `rerequest:${id}` ? '重新提交中...' : '再次点歌'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function ViewerSongRequestPanel({
  authenticated,
  data,
  loading,
  error,
  filters,
  onFiltersChange,
  onRefresh,
  onWithdraw,
  onRerequest,
  pending
}) {
  if (!authenticated) {
    return (
      <section className="viewer-request-panel" aria-labelledby="viewer-request-title">
        <div className="song-request-section-heading">
          <div>
            <p className="section-kicker">我的点歌</p>
            <h2 id="viewer-request-title">登录后查看点歌进度</h2>
          </div>
        </div>
        <InlineAlert type="info">
          你可以继续浏览歌曲与公开队列。<Link to="/login">登录网站账号</Link>后可查看自己的点歌。
        </InlineAlert>
      </section>
    );
  }

  const binding = data?.binding || {};
  const bindings = Array.isArray(binding.bindings) ? binding.bindings : [];
  const bindingCount = Number(binding.count ?? binding.binding_count ?? bindings.length);
  const isBound = Boolean(binding.bound ?? binding.is_bound ?? bindingCount > 0);
  const activeRequest = data?.activeRequest || data?.active_request || null;
  const history = Array.isArray(data?.history) ? data.history : [];
  const pagination = data?.pagination || { page: 1, totalPages: 1, total: 0 };

  return (
    <section className="viewer-request-panel" aria-labelledby="viewer-request-title" aria-live="polite">
      <div className="song-request-section-heading">
        <div>
          <p className="section-kicker">我的点歌</p>
          <h2 id="viewer-request-title">点歌进度与历史</h2>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
          {loading ? '同步中...' : '刷新'}
        </button>
      </div>

      {error && <InlineAlert type="error">{error}</InlineAlert>}
      {!isBound && !loading && (
        <InlineAlert type="info" title="点歌前需要绑定B站账号">
          你仍可浏览全部歌曲。请前往<Link to="/profile">个人资料</Link>完成绑定，最多可绑定五个账号。
        </InlineAlert>
      )}
      {isBound && (
        <p className="viewer-binding-state">
          已绑定 {bindingCount} 个B站账号，所有绑定账号共用同一个点歌身份。
        </p>
      )}

      {activeRequest ? (
        <div className="viewer-active-request">
          <h3>进行中的点歌</h3>
          <RequestDetails
            request={activeRequest}
            active
            pending={pending}
            onWithdraw={onWithdraw}
            onRerequest={onRerequest}
          />
        </div>
      ) : (
        !loading && isBound && (
          <div className="song-request-empty compact">
            <strong>目前没有进行中的点歌</strong>
            <span>从下方歌曲目录选择一首即可加入队列。</span>
          </div>
        )
      )}

      <div className="viewer-history-heading">
        <h3>我的点歌历史</h3>
        <label>
          <span className="sr-only">筛选点歌状态</span>
          <select
            value={filters.status}
            onChange={(event) => onFiltersChange({ ...filters, status: event.target.value, page: 1 })}
            aria-label="筛选我的点歌状态"
          >
            <option value="">全部状态</option>
            {Object.entries(REQUEST_STATUS_LABELS).map(([status, label]) => (
              <option key={status} value={status}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      {history.length > 0 ? (
        <div className="viewer-request-history">
          {history.map((request, index) => (
            <RequestDetails
              key={requestId(request) || `${request.requested_at || 'history'}-${index}`}
              request={request}
              pending={pending}
              onWithdraw={onWithdraw}
              onRerequest={onRerequest}
            />
          ))}
        </div>
      ) : (
        !loading && <div className="song-request-empty compact">暂无符合条件的点歌历史</div>
      )}

      <nav className="song-history-pagination" aria-label="我的点歌历史分页">
        <button
          type="button"
          disabled={loading || Number(pagination.page || 1) <= 1}
          onClick={() => onFiltersChange({ ...filters, page: Number(pagination.page || 1) - 1 })}
        >
          上一页
        </button>
        <span>
          第 {Number(pagination.page || 1)} / {Number(pagination.totalPages || pagination.total_pages || 1)} 页，
          共 {Number(pagination.total || 0)} 条
        </span>
        <button
          type="button"
          disabled={(
            loading
            || Number(pagination.page || 1) >= Number(pagination.totalPages || pagination.total_pages || 1)
          )}
          onClick={() => onFiltersChange({ ...filters, page: Number(pagination.page || 1) + 1 })}
        >
          下一页
        </button>
      </nav>
    </section>
  );
}
