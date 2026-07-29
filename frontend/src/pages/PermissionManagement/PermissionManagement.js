import React, { useEffect, useMemo, useState } from 'react';
import { authService, permissionService, settingsService } from '../../services';
import BackButton from '../../components/BackButton';
import {
  ROLE_DEFINITIONS,
  ROLES,
  isAdminRole,
  roleLabel
} from '../../constants/roles';
import './PermissionManagement.css';
import ViewerIdentityManagement from './ViewerIdentityManagement';

const PAGE_SIZE = 10;

function AdminPermissionManagement() {
  const [users, setUsers] = useState([]);
  const [types, setTypes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({ role: ROLES.FAN_CLUB, permissions: [] });
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextUsers, nextTypes, registration] = await Promise.all([
        permissionService.getAllUsers(),
        permissionService.getPermissionTypes(),
        settingsService.getRegistrationStatus()
      ]);
      setUsers(nextUsers || []);
      setTypes(nextTypes || []);
      setRegistrationOpen(Boolean(registration.registrationOpen));
    } catch (err) {
      setError(err.response?.data?.message || '用户与权限加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return users.filter((user) => {
      const matchesRole = !roleFilter || user.role === roleFilter;
      const matchesSearch = !keyword || [
        user.username,
        user.email,
        user.role,
        roleLabel(user.role)
      ].some((value) => String(value || '').toLowerCase().includes(keyword));
      return matchesRole && matchesSearch;
    });
  }, [roleFilter, search, users]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visibleUsers = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openEditor = (user) => {
    setSelected(user);
    setDraft({
      role: user.role || ROLES.FAN_CLUB,
      permissions: user.assigned_permissions || []
    });
    setMessage('');
    setError('');
  };

  const rolePermissions = useMemo(() => {
    if (!selected || selected.role !== draft.role) {
      if (draft.role === ROLES.STREAMER || draft.role === ROLES.ADMIN) {
        return types.map((type) => type.key);
      }
      return [];
    }
    return selected.role_permissions || [];
  }, [draft.role, selected, types]);

  const togglePermission = (key) => setDraft((current) => ({
    ...current,
    permissions: current.permissions.includes(key)
      ? current.permissions.filter((item) => item !== key)
      : [...current.permissions, key]
  }));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await permissionService.updateUserPermissions(
        selected.id,
        draft.permissions,
        draft.role
      );
      setMessage(`已保存 ${selected.username} 的角色与权限`);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || '权限保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleRegistration = async () => {
    try {
      const result = await settingsService.updateRegistrationStatus(!registrationOpen);
      setRegistrationOpen(Boolean(result.registrationOpen));
      setMessage(`用户注册已${result.registrationOpen ? '开放' : '关闭'}`);
    } catch (err) {
      setError(err.response?.data?.message || '注册开关更新失败');
    }
  };

  return (
    <div className="permission-management">
      <BackButton to="/" />
      <header className="page-header">
        <div>
          <h1>用户与权限管理</h1>
          <p className="hint">管理公开站点用户角色与功能权限。</p>
        </div>
        <label className="registration-toggle">
          <span>用户注册</span>
          <button
            type="button"
            className={`toggle-btn ${registrationOpen ? 'open' : 'closed'}`}
            onClick={toggleRegistration}
          >
            {registrationOpen ? '已开放' : '已关闭'}
          </button>
        </label>
      </header>
      {message && <div className="success-message">{message}</div>}
      {error && <div className="error-message">{error}</div>}
      <div className="search-bar">
        <form onSubmit={(event) => { event.preventDefault(); setPage(1); }}>
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="搜索用户名、邮箱或角色"
          />
          <select
            aria-label="按角色筛选"
            value={roleFilter}
            onChange={(event) => { setRoleFilter(event.target.value); setPage(1); }}
          >
            <option value="">全部角色</option>
            {ROLE_DEFINITIONS.map((role) => (
              <option key={role.key} value={role.key}>{role.label}</option>
            ))}
          </select>
          <button>搜索</button>
        </form>
      </div>
      {loading ? (
        <div className="loading">正在加载用户...</div>
      ) : (
        <div className="users-table">
          <table>
            <thead>
              <tr><th>用户</th><th>角色</th><th>权限</th><th>操作</th></tr>
            </thead>
            <tbody>
              {visibleUsers.map((user) => (
                <tr key={user.id} className={isAdminRole(user.role) ? 'admin-row' : ''}>
                  <td><strong>{user.username}</strong><br /><span>{user.email}</span></td>
                  <td>
                    <span className={`role-badge ${user.role}`}>
                      {roleLabel(user.role)}
                    </span>
                  </td>
                  <td>
                    {isAdminRole(user.role) ? (
                      <span className="all-permissions">全部权限</span>
                    ) : (
                      <span className="permission-count">
                        {user.permissions?.length || 0} 项权限
                      </span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="edit-btn" onClick={() => openEditor(user)}>
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleUsers.length && <div className="empty-users">没有匹配的用户</div>}
        </div>
      )}
      {filtered.length > PAGE_SIZE && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            上一页
          </button>
          <span>第 {page} / {totalPages} 页</span>
          <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
            下一页
          </button>
        </div>
      )}

      {selected && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
        >
          <section className="permission-modal" onClick={(event) => event.stopPropagation()}>
            <h2>编辑用户权限</h2>
            <div className="user-info">
              <strong>{selected.username}</strong>
              <span>{selected.email}</span>
            </div>
            <section className="role-section">
              <h3>用户角色</h3>
              <div className="role-selector">
                {ROLE_DEFINITIONS.map((role) => (
                  <label
                    className={`role-option ${draft.role === role.key ? 'selected' : ''}`}
                    key={role.key}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={role.key}
                      checked={draft.role === role.key}
                      onChange={() => setDraft({ ...draft, role: role.key })}
                    />
                    <span className="role-label">{role.label}</span>
                  </label>
                ))}
              </div>
            </section>
            <section className="permissions-section">
              <h3>功能权限</h3>
              <p className="hint">
                四种观众角色共享基础权限；主播自动拥有日常运营权限；管理员拥有全部权限。
              </p>
              <div className="permissions-grid">
                {types.map((type) => {
                  const inherited = rolePermissions.includes(type.key);
                  return (
                    <label className="permission-item" key={type.key}>
                      <input
                        type="checkbox"
                        checked={inherited || draft.permissions.includes(type.key)}
                        onChange={() => togglePermission(type.key)}
                        disabled={isAdminRole(draft.role) || inherited}
                      />
                      <span className="permission-info">
                        <span className="permission-name">{type.name || type.key}</span>
                        <span className="permission-desc">
                          {inherited ? '由当前角色自动授予' : type.description || type.key}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
            <div className="modal-actions">
              <button type="button" className="cancel-btn" onClick={() => setSelected(null)}>
                取消
              </button>
              <button type="button" className="save-btn" onClick={save} disabled={saving}>
                {saving ? '保存中...' : '保存权限'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function PermissionManagement() {
  const currentUser = authService.getCurrentUser();
  if (!isAdminRole(currentUser?.role)) {
    return (
      <div className="permission-management">
        <BackButton to="/" />
        <ViewerIdentityManagement />
      </div>
    );
  }
  return (
    <>
      <ViewerIdentityManagement embedded />
      <AdminPermissionManagement />
    </>
  );
}
