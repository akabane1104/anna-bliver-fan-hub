import React, { useEffect, useState } from 'react';
import { authService, permissionService } from '../../services';
import {
  ROLE_DEFINITIONS,
  ROLES,
  roleLabel
} from '../../constants/roles';

const VIEWER_ROLES = ROLE_DEFINITIONS.filter(({ key }) => (
  [ROLES.FAN_CLUB, ROLES.CAPTAIN, ROLES.ADMIRAL, ROLES.GOVERNOR].includes(key)
));

const STATUS_LABELS = Object.freeze({
  never: '待确认',
  pending: '正在同步',
  success: '自动识别',
  failed: '同步失败',
  unavailable: '待确认'
});

const MEDAL_STATUS_LABELS = Object.freeze({
  unknown: '待确认',
  active: '有效',
  inactive: '无效'
});

const ACTION_LABELS = Object.freeze({
  sync_confirmed: '自动同步成功',
  sync_failed: '自动同步失败',
  listener_confirmed: '直播事件更新',
  manual_created: '创建人工补录',
  manual_updated: '更新人工补录',
  manual_revoked: '撤销人工补录',
  manual_expired: '人工补录到期',
  manual_overridden: '自动同步覆盖补录',
  role_recomputed: '重新计算网站角色'
});

const formatTime = (value) => (
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未成功同步'
);

export default function ViewerIdentityManagement({ embedded = false }) {
  const operatorIsAdmin = authService.getCurrentUser()?.role === ROLES.ADMIN;
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(null);
  const [audit, setAudit] = useState(null);
  const [draft, setDraft] = useState({
    role: ROLES.FAN_CLUB,
    reason: '',
    expires_at: ''
  });

  const load = async () => {
    setLoading(true);
    try {
      setUsers(await permissionService.getViewerIdentityUsers());
      setError('');
    } catch (requestError) {
      setError(requestError.response?.data?.message || '观众身份状态加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const resync = async (user, binding) => {
    setMessage('');
    try {
      await permissionService.resyncViewerIdentity(user.id, binding.bilibili_uid);
      setMessage(`已提交 ${user.username} 的身份同步`);
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.message || '身份同步失败');
    }
  };

  const saveFallback = async () => {
    try {
      await permissionService.setViewerIdentityFallback(
        editing.user.id,
        editing.binding.bilibili_uid,
        draft
      );
      setEditing(null);
      setMessage('人工补录已保存');
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.message || '人工补录保存失败');
    }
  };

  const revokeFallback = async (user, binding) => {
    try {
      await permissionService.revokeViewerIdentityFallback(
        user.id,
        binding.bilibili_uid
      );
      setMessage('人工补录已撤销');
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.message || '人工补录撤销失败');
    }
  };

  const showAudit = async (user) => {
    try {
      setAudit({ user, rows: await permissionService.getViewerIdentityAudit(user.id) });
    } catch (requestError) {
      setError(requestError.response?.data?.message || '补录记录加载失败');
    }
  };

  return (
    <section className={`viewer-identity-management ${embedded ? 'embedded' : ''}`}>
      <header className="viewer-identity-header">
        <div>
          <h2>观众身份同步</h2>
          <p>查看 B 站绑定状态；自动识别失败时可临时补录观众身份。</p>
        </div>
        <button type="button" onClick={load} disabled={loading}>刷新</button>
      </header>
      {message && <div className="success-message">{message}</div>}
      {error && <div className="error-message">{error}</div>}
      {loading ? <p>正在加载身份状态...</p> : (
        <div className="viewer-identity-list">
          {users.map((user) => (
            <article className="viewer-identity-user" key={user.id}>
              <div className="viewer-identity-user-heading">
                <div>
                  <strong>{user.username}</strong>
                  <span className={`role-badge ${user.role}`}>{roleLabel(user.role)}</span>
                </div>
                <button type="button" onClick={() => showAudit(user)}>补录记录</button>
              </div>
              {user.protected_role && (
                <p className="viewer-identity-protected">
                  主播和管理员身份受保护，不会被自动同步修改。
                </p>
              )}
              {!user.bindings.length ? <p>尚未绑定 B 站 UID</p> : user.bindings.map((binding) => {
                const canFallback = !user.protected_role
                  && binding.identity_sync_status !== 'success';
                const canModifyBinding = !user.protected_role || operatorIsAdmin;
                return (
                  <div className="viewer-identity-binding" key={binding.bilibili_uid}>
                    <div>
                      <strong>UID {binding.bilibili_uid}</strong>
                      <span>
                        {binding.fans_medal_name || '未识别粉丝勋章'}
                        {binding.fans_medal_level == null
                          ? ''
                          : ` · ${binding.fans_medal_level} 级`}
                        {` · ${MEDAL_STATUS_LABELS[binding.fans_medal_status] || '待确认'}`}
                      </span>
                      <span>
                        当前大航海：{binding.guard_role
                          ? roleLabel(binding.guard_role)
                          : '待确认'}
                      </span>
                      <span>
                        同步状态：{STATUS_LABELS[binding.identity_sync_status] || '待确认'}
                      </span>
                      <span>最后成功同步：{formatTime(binding.last_sync_success_at)}</span>
                      {binding.manual_role && (
                        <span>
                          人工补录：{roleLabel(binding.manual_role)}
                          {binding.manual_expires_at
                            ? `，截止 ${formatTime(binding.manual_expires_at)}`
                            : ''}
                        </span>
                      )}
                    </div>
                    <div className="viewer-identity-actions">
                      {canModifyBinding && (
                        <button type="button" onClick={() => resync(user, binding)}>
                          重新同步
                        </button>
                      )}
                      {canModifyBinding && canFallback && (
                        <button
                          type="button"
                          onClick={() => {
                            setDraft({
                              role: binding.manual_role || ROLES.FAN_CLUB,
                              reason: binding.manual_reason || '',
                              expires_at: binding.manual_expires_at
                                ? String(binding.manual_expires_at).slice(0, 16)
                                : ''
                            });
                            setEditing({ user, binding });
                          }}
                        >
                          人工补录
                        </button>
                      )}
                      {canModifyBinding && binding.manual_role && (
                        <button
                          type="button"
                          className="danger-link"
                          onClick={() => revokeFallback(user, binding)}
                        >
                          撤销补录
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      )}
      {editing && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <section className="permission-modal viewer-identity-modal">
            <h3>人工补录观众身份</h3>
            <p>{editing.user.username} · UID {editing.binding.bilibili_uid}</p>
            <label>
              观众身份
              <select
                value={draft.role}
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              >
                {VIEWER_ROLES.map((role) => (
                  <option key={role.key} value={role.key}>{role.label}</option>
                ))}
              </select>
            </label>
            <label>
              补录原因
              <textarea
                value={draft.reason}
                onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
                maxLength={500}
              />
            </label>
            {draft.role !== ROLES.FAN_CLUB && (
              <label>
                有效截止时间
                <input
                  type="datetime-local"
                  value={draft.expires_at}
                  onChange={(event) => setDraft({
                    ...draft,
                    expires_at: event.target.value
                  })}
                />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="cancel-btn" onClick={() => setEditing(null)}>
                取消
              </button>
              <button type="button" className="save-btn" onClick={saveFallback}>
                保存补录
              </button>
            </div>
          </section>
        </div>
      )}
      {audit && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <section className="permission-modal viewer-identity-modal">
            <h3>{audit.user.username} 的身份记录</h3>
            <div className="viewer-identity-audit">
              {audit.rows.length ? audit.rows.map((row) => (
                <p key={row.id}>
                  <strong>{ACTION_LABELS[row.action] || row.action}</strong>
                  <span>{formatTime(row.created_at)}</span>
                </p>
              )) : <p>暂无补录或同步记录</p>}
            </div>
            <div className="modal-actions">
              <button type="button" className="cancel-btn" onClick={() => setAudit(null)}>
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
