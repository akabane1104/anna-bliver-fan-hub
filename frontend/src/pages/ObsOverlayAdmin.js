import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BackButton from '../components/BackButton';
import LiveAdminNav from '../components/LiveAdminNav';
import { useFeedback } from '../components/FeedbackProvider';
import obsOverlayService from '../services/obsOverlayService';
import useObsOverlayState from '../hooks/useObsOverlayState';
import { OBS_OVERLAY_META } from './ObsOverlay';
import './ObsOverlayAdmin.css';

const EVENT_TABS = Object.freeze([
  ['gift_thanks', '礼物感谢'],
  ['guard_alert', '上舰提醒'],
  ['ai_bubble', 'AI 气泡'],
  ['notice', '直播通知']
]);

function uniqueKey(type) {
  if (window.crypto?.randomUUID) return `${type}-${window.crypto.randomUUID()}`;
  return `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function eventPayload(type, form) {
  if (type === 'gift_thanks') {
    return {
      displayName: form.displayName,
      giftName: form.giftName,
      count: Number(form.count)
    };
  }
  if (type === 'guard_alert') {
    return {
      displayName: form.displayName,
      guardText: form.guardText
    };
  }
  if (type === 'ai_bubble') {
    return { text: form.text, persona: form.persona };
  }
  return { text: form.text, style: form.style };
}

function ObsOverlayAdmin() {
  const { toast } = useFeedback();
  const [events, setEvents] = useState([]);
  const [eventType, setEventType] = useState('gift_thanks');
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    displayName: '模拟观众',
    giftName: '小花花',
    count: 1,
    guardText: '开通舰长',
    text: '直播通知测试',
    persona: 'normal',
    style: 'info',
    displayDurationMs: 6000
  });
  const overlayState = useObsOverlayState();
  const origin = window.location.origin;
  const sources = useMemo(
    () => Object.entries(OBS_OVERLAY_META).map(([key, meta]) => ({
      key,
      ...meta,
      url: `${origin}/obs/${key}`
    })),
    [origin]
  );

  const loadEvents = useCallback(async () => {
    try {
      const result = await obsOverlayService.listEvents();
      setEvents(result.events || []);
    } catch {
      toast('OBS 事件记录暂时不可用', { type: 'error' });
    }
  }, [toast]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const update = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const copyUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('OBS 地址已复制', { type: 'success' });
    } catch {
      toast('无法访问剪贴板', { type: 'error' });
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await obsOverlayService.createEvent({
        eventType,
        source: ['gift_thanks', 'guard_alert'].includes(eventType)
          ? 'simulator'
          : 'manual',
        payload: eventPayload(eventType, form),
        displayDurationMs: Number(form.displayDurationMs),
        idempotencyKey: uniqueKey(eventType)
      });
      toast('OBS 事件已送出', { type: 'success' });
      await loadEvents();
    } catch (error) {
      toast(error.response?.data?.message || 'OBS 事件送出失败', { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = async (publicId) => {
    try {
      await obsOverlayService.dismissEvent(publicId);
      await loadEvents();
    } catch {
      toast('事件无法结束', { type: 'error' });
    }
  };

  return (
    <div className="container obs-admin-page">
      <BackButton to="/admin/live-control" />
      <LiveAdminNav />
      <header className="obs-admin-header">
        <div>
          <span className="obs-admin-eyebrow">OBS BROWSER SOURCES</span>
          <h1>直播画面元件</h1>
        </div>
        <a
          className="btn btn-secondary"
          href="/obs/preview"
          target="_blank"
          rel="noreferrer"
        >
          打开全量预览
        </a>
      </header>

      <div className="obs-admin-runtime">
        <span className={overlayState.connected ? 'online' : 'fallback'}>
          {overlayState.connected ? 'SSE 已连接' : 'Fallback polling'}
        </span>
        <time dateTime={overlayState.state?.serverNow || undefined}>
          最近更新：
          {overlayState.state?.serverNow
            ? new Date(overlayState.state.serverNow).toLocaleString()
            : '等待 snapshot'}
        </time>
      </div>

      <section className="obs-admin-band">
        <h2>Browser Source 地址</h2>
        <div className="obs-source-table">
          {sources.map((source) => (
            <div className="obs-source-row" key={source.key}>
              <div><strong>{source.label}</strong><span>{source.size}</span></div>
              <code>{source.url}</code>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => copyUrl(source.url)}
              >
                复制
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="obs-admin-band">
        <h2>画面预览</h2>
        <iframe
          className="obs-admin-preview"
          title="OBS 元件预览"
          src="/obs/preview"
        />
      </section>

      <section className="obs-admin-band obs-event-lab">
        <div className="obs-section-heading">
          <h2>手动事件</h2>
          <span>Simulator 不连接 B站、不发放积分；棉花糖从棉花糖管理页发布</span>
        </div>
        <div className="obs-event-tabs" role="tablist" aria-label="OBS 事件类型">
          {EVENT_TABS.map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={eventType === value ? 'active' : ''}
              onClick={() => setEventType(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <form className="obs-event-form" onSubmit={submit}>
          {['gift_thanks', 'guard_alert'].includes(eventType) && (
            <label>
              显示名称
              <input value={form.displayName} onChange={update('displayName')} maxLength="100" />
            </label>
          )}
          {eventType === 'gift_thanks' && (
            <>
              <label>
                礼物名称
                <input value={form.giftName} onChange={update('giftName')} maxLength="100" />
              </label>
              <label>
                数量
                <input type="number" min="1" max="99999" value={form.count} onChange={update('count')} />
              </label>
            </>
          )}
          {eventType === 'guard_alert' && (
            <label>
              上舰文字
              <input value={form.guardText} onChange={update('guardText')} maxLength="100" />
            </label>
          )}
          {eventType === 'ai_bubble' && (
            <>
              <label className="obs-form-wide">
                气泡文字
                <textarea value={form.text} onChange={update('text')} maxLength="40" rows="3" />
              </label>
              <label>
                语气
                <select value={form.persona} onChange={update('persona')}>
                  <option value="sassy">毒舌</option>
                  <option value="sweet">乖乖牌</option>
                  <option value="normal">普通</option>
                </select>
              </label>
            </>
          )}
          {eventType === 'notice' && (
            <>
              <label className="obs-form-wide">
                通知文字
                <textarea value={form.text} onChange={update('text')} maxLength="240" rows="3" />
              </label>
              <label>
                样式
                <select value={form.style} onChange={update('style')}>
                  <option value="info">一般</option>
                  <option value="success">成功</option>
                  <option value="warning">提醒</option>
                </select>
              </label>
            </>
          )}
          <label>
            显示时间
            <select value={form.displayDurationMs} onChange={update('displayDurationMs')}>
              <option value="4000">4 秒</option>
              <option value="6000">6 秒</option>
              <option value="12000">12 秒</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? '发送中...' : '发送到 OBS'}
          </button>
        </form>
      </section>

      <section className="obs-admin-band">
        <div className="obs-section-heading">
          <h2>最近事件</h2>
          <button type="button" className="btn btn-outline" onClick={loadEvents}>刷新</button>
        </div>
        <div className="obs-event-list">
          {events.length === 0 && <p className="empty-state">暂无 OBS 事件</p>}
          {events.map((item) => (
            <div key={item.publicId}>
              <div>
                <strong>{item.eventType}</strong>
                <span>{item.source} · #{item.sequence}</span>
              </div>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
              <button
                type="button"
                className="btn btn-outline"
                disabled={Boolean(item.dismissedAt)}
                onClick={() => dismiss(item.publicId)}
              >
                {item.dismissedAt ? '已结束' : '结束显示'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default ObsOverlayAdmin;
