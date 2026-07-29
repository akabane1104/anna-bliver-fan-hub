import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { roleLabel } from '../constants/roles';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('token')}`
});

const SYNC_LABELS = Object.freeze({
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

const formatTime = (value) => (
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未成功同步'
);

export default function BilibiliBinding() {
  const [status, setStatus] = useState({ bindings: [], binding_limit: 5 });
  const [qr, setQr] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncingUid, setSyncingUid] = useState('');
  const timer = useRef(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch('/api/bilibili-binding/status', {
      headers: authHeaders()
    });
    if (response.ok) setStatus(await response.json());
  }, []);

  useEffect(() => {
    loadStatus();
    return () => clearInterval(timer.current);
  }, [loadStatus]);

  const startPolling = (key) => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const response = await fetch(
        `/api/bilibili-binding/qr/${encodeURIComponent(key)}`,
        { headers: authHeaders() }
      );
      const data = await response.json();
      if (data.status === 'success') {
        clearInterval(timer.current);
        setQr(null);
        setMessage(
          data.identity_sync?.status === 'success'
            ? 'B 站账号绑定并同步成功'
            : 'B 站账号绑定成功，身份资料等待同步'
        );
        loadStatus();
      } else if (response.status === 410 || data.status === 'expired') {
        clearInterval(timer.current);
        setQr(null);
        setMessage('二维码已过期，请重新生成');
      } else if (!response.ok) {
        clearInterval(timer.current);
        setMessage(data.message || '绑定失败');
      }
    }, 2000);
  };

  const createQr = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/bilibili-binding/qr', {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '二维码创建失败');
      setQr(data);
      startPolling(data.qrcode_key);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const setPrimary = async (uid) => {
    await fetch(`/api/bilibili-binding/${uid}/primary`, {
      method: 'POST',
      headers: authHeaders()
    });
    loadStatus();
  };

  const resync = async (uid) => {
    setSyncingUid(uid);
    setMessage('');
    try {
      const response = await fetch(`/api/bilibili-binding/${uid}/sync`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '身份同步失败');
      setMessage(
        data.status === 'success'
          ? '身份同步成功'
          : '身份数据源暂时不可用，已保留上次确认结果'
      );
      await loadStatus();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSyncingUid('');
    }
  };

  const unbind = async (uid) => {
    if (!window.confirm(`确认解绑 UID ${uid}？`)) return;
    const response = await fetch(`/api/bilibili-binding/${uid}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const data = await response.json();
    setMessage(response.ok ? '已解绑' : data.message);
    if (response.ok) loadStatus();
  };

  const bindings = status.bindings || [];
  return (
    <section className="binding-panel">
      <div className="binding-heading">
        <div>
          <h3>B 站账号绑定</h3>
          <p>
            已绑定 {bindings.length}/{status.binding_limit || 5} 个账号，
            当前网站角色：{roleLabel(status.role)}
          </p>
        </div>
        <button
          type="button"
          onClick={createQr}
          disabled={busy || bindings.length >= (status.binding_limit || 5)}
        >
          {busy ? '生成中...' : '扫码绑定'}
        </button>
      </div>

      {message && <p className="binding-message">{message}</p>}
      {qr && (
        <div className="binding-qr">
          <QRCodeSVG value={qr.url} size={184} level="M" />
          <p>请使用哔哩哔哩 App 扫码并确认</p>
        </div>
      )}

      <div className="binding-list">
        {bindings.map((binding) => (
          <article key={binding.bilibili_uid} className="binding-item">
            {binding.bilibili_face && (
              <img
                src={binding.bilibili_face}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <div>
              <strong>
                {binding.bilibili_uname || `UID ${binding.bilibili_uid}`}
              </strong>
              <span>
                UID {binding.bilibili_uid}
                {binding.is_primary ? ' · 主账号' : ''}
              </span>
              <span>
                粉丝勋章：{binding.fans_medal_name || '待确认'}
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
                同步状态：{SYNC_LABELS[binding.identity_sync_status] || '待确认'}
              </span>
              <span>最后成功同步：{formatTime(binding.last_sync_success_at)}</span>
            </div>
            <div className="binding-actions">
              <button
                type="button"
                onClick={() => resync(binding.bilibili_uid)}
                disabled={syncingUid === binding.bilibili_uid}
              >
                {syncingUid === binding.bilibili_uid ? '同步中...' : '重新同步'}
              </button>
              {!binding.is_primary && (
                <button
                  type="button"
                  onClick={() => setPrimary(binding.bilibili_uid)}
                >
                  设为主账号
                </button>
              )}
              <button
                type="button"
                className="danger-link"
                onClick={() => unbind(binding.bilibili_uid)}
              >
                解绑
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
