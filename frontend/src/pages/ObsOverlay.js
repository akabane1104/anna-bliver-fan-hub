import React, { useEffect, useMemo, useRef, useState } from 'react';
import useObsOverlayState from '../hooks/useObsOverlayState';
import './ObsOverlay.css';

const SAMPLE_STATE = Object.freeze({
  currentSong: {
    title: '小幸运',
    artist: '田馥甄',
    requester: '小***娜'
  },
  nextSong: {
    title: '暖暖',
    artist: '梁静茹',
    requester: '星***海'
  },
  queue: [
    { displayKey: 'sample-1', title: '后来', artist: '刘若英', requester: '云***朵' },
    { displayKey: 'sample-2', title: '遇见', artist: '孙燕姿', requester: '夏***天' },
    { displayKey: 'sample-3', title: '勇气', artist: '梁静茹', requester: '月***光' }
  ],
  todayRequestCount: 18,
  activity: {
    title: '夏日歌回',
    content: '和大家一起唱到最后一首',
    progress: 0.64,
    status: 'active'
  },
  events: [
    {
      publicId: 'gift-sample',
      sequence: '1',
      eventType: 'gift_thanks',
      displayDurationMs: 60000,
      payload: { displayName: '星河', giftName: '小花花', count: 3 }
    },
    {
      publicId: 'guard-sample',
      sequence: '2',
      eventType: 'guard_alert',
      displayDurationMs: 60000,
      payload: { displayName: '长夜', guardText: '开通舰长' }
    },
    {
      publicId: 'cotton-sample',
      sequence: '3',
      eventType: 'cotton_candy',
      displayDurationMs: 60000,
      payload: {
        displayName: '匿名观众',
        content: '今天也要开心唱歌！',
        reply: '收到啦，谢谢你的棉花糖。'
      }
    },
    {
      publicId: 'ai-sample',
      sequence: '4',
      eventType: 'ai_bubble',
      displayDurationMs: 60000,
      payload: { text: '这首我会，下一句交给你们。', persona: 'sassy' }
    },
    {
      publicId: 'notice-sample',
      sequence: '5',
      eventType: 'notice',
      displayDurationMs: 60000,
      payload: { text: '下一轮点歌将在十分钟后开放', style: 'info' }
    }
  ]
});

const OVERLAY_META = Object.freeze({
  'now-playing': { label: '正在演唱', size: '900 x 180' },
  'next-song': { label: '下一首', size: '700 x 110' },
  'song-queue': { label: '点歌队列', size: '520 x 480' },
  'today-count': { label: '今日点歌', size: '300 x 100' },
  'activity-progress': { label: '今日活动', size: '720 x 130' },
  'gift-ticker': { label: '礼物感谢', size: '900 x 100' },
  'guard-alert': { label: '上舰提醒', size: '1920 x 1080' },
  'cotton-candy': { label: '棉花糖', size: '900 x 500' },
  'ai-bubble': { label: 'AI 气泡', size: '640 x 240' },
  notice: { label: '直播通知', size: '700 x 160' }
});

function useSequentialEvent(events, eventType) {
  const consumedRef = useRef(new Set());
  const [current, setCurrent] = useState(null);
  const candidates = useMemo(
    () => (events || [])
      .filter((event) => event.eventType === eventType)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence)),
    [eventType, events]
  );

  useEffect(() => {
    if (current && candidates.some((event) => event.publicId === current.publicId)) return;
    const next = candidates.find((event) => !consumedRef.current.has(event.publicId));
    setCurrent(next || null);
  }, [candidates, current]);

  useEffect(() => {
    if (!current) return undefined;
    const timer = window.setTimeout(() => {
      consumedRef.current.add(current.publicId);
      setCurrent(null);
    }, Math.max(1000, Number(current.displayDurationMs) || 5000));
    return () => window.clearTimeout(timer);
  }, [current]);

  return current;
}

function SongTitle({ song }) {
  return (
    <>
      <strong>{song.title}</strong>
      {song.artist && <span>{song.artist}</span>}
    </>
  );
}

function OverlayContent({ kind, state }) {
  const gift = useSequentialEvent(state?.events, 'gift_thanks');
  const guard = useSequentialEvent(state?.events, 'guard_alert');
  const cotton = useSequentialEvent(state?.events, 'cotton_candy');
  const ai = useSequentialEvent(state?.events, 'ai_bubble');
  const notice = useSequentialEvent(state?.events, 'notice');

  if (kind === 'now-playing') {
    if (!state?.currentSong) return null;
    return (
      <section className="obs-panel obs-now">
        <span className="obs-kicker">NOW SINGING</span>
        <SongTitle song={state.currentSong} />
        <small>点歌 · {state.currentSong.requester}</small>
        <i className="obs-equalizer" aria-hidden="true"><b /><b /><b /><b /></i>
      </section>
    );
  }
  if (kind === 'next-song') {
    if (!state?.nextSong) return null;
    return (
      <section className="obs-panel obs-next">
        <span className="obs-kicker">UP NEXT</span>
        <SongTitle song={state.nextSong} />
        <small>{state.nextSong.requester}</small>
      </section>
    );
  }
  if (kind === 'song-queue') {
    if (!state?.queue?.length) return null;
    return (
      <section className="obs-panel obs-queue">
        <header><span>点歌队列</span><b>{state.queue.length}</b></header>
        <ol>
          {state.queue.slice(0, 10).map((song, index) => (
            <li key={song.displayKey || `${song.title}-${index}`}>
              <em>{String(index + 1).padStart(2, '0')}</em>
              <div><SongTitle song={song} /></div>
              <small>{song.requester}</small>
            </li>
          ))}
        </ol>
      </section>
    );
  }
  if (kind === 'today-count') {
    if (!Number.isInteger(state?.todayRequestCount)) return null;
    return (
      <section className="obs-panel obs-count">
        <span>今日点歌</span><strong>{state.todayRequestCount}</strong><small>首</small>
      </section>
    );
  }
  if (kind === 'activity-progress') {
    if (!state?.activity) return null;
    const percent = Math.round((state.activity.progress || 0) * 100);
    const statusText = {
      upcoming: '即将开始',
      active: '进行中',
      ended: '已结束'
    }[state.activity.status] || '';
    return (
      <section className="obs-panel obs-activity">
        <div><span>今日活动</span><strong>{state.activity.title}</strong><b>{percent}%</b></div>
        <div className="obs-progress"><i style={{ width: `${percent}%` }} /></div>
        <small>
          {statusText}
          {statusText && state.activity.content ? ' · ' : ''}
          {state.activity.content}
        </small>
      </section>
    );
  }
  if (kind === 'gift-ticker') {
    if (!gift) return null;
    return (
      <section className="obs-panel obs-ticker">
        <span>THANK YOU</span>
        <strong>{gift.payload.displayName}</strong>
        <p>送出 {gift.payload.giftName}</p>
        <b>x{gift.payload.count}</b>
      </section>
    );
  }
  if (kind === 'guard-alert') {
    if (!guard) return null;
    return (
      <section className="obs-guard">
        <div className="obs-guard-ring" aria-hidden="true" />
        <img src="/annapiggy-logo.png" alt="" />
        <span>WELCOME ABOARD</span>
        <strong>{guard.payload.displayName}</strong>
        <p>{guard.payload.guardText}</p>
      </section>
    );
  }
  if (kind === 'cotton-candy') {
    if (!cotton) return null;
    return (
      <section className="obs-panel obs-cotton">
        <span>棉花糖来信</span>
        <blockquote>{cotton.payload.content}</blockquote>
        <strong>{cotton.payload.displayName}</strong>
        {cotton.payload.reply && <p>{cotton.payload.reply}</p>}
      </section>
    );
  }
  if (kind === 'ai-bubble') {
    if (!ai) return null;
    return (
      <section className={`obs-panel obs-ai obs-ai-${ai.payload.persona}`}>
        <img src="/annapiggy-logo.png" alt="" />
        <span>ANNA SAYS</span>
        <p>{ai.payload.text}</p>
      </section>
    );
  }
  if (kind === 'notice') {
    if (!notice) return null;
    return (
      <section className={`obs-panel obs-notice obs-notice-${notice.payload.style}`}>
        <span>LIVE NOTICE</span>
        <strong>{notice.payload.text}</strong>
      </section>
    );
  }
  return null;
}

function ObsOverlayRoute({ kind }) {
  const { state } = useObsOverlayState();
  useEffect(() => {
    document.body.classList.add('obs-browser-source');
    return () => document.body.classList.remove('obs-browser-source');
  }, []);
  return (
    <div className={`obs-stage obs-stage-${kind}`}>
      <OverlayContent kind={kind} state={state} />
    </div>
  );
}

function ObsOverlayPreview() {
  useEffect(() => {
    document.body.classList.add('obs-preview-mode');
    return () => document.body.classList.remove('obs-preview-mode');
  }, []);
  return (
    <main className="obs-preview">
      <header>
        <img src="/annapiggy-logo.png" alt="" />
        <div><span>OBS BROWSER SOURCES</span><h1>直播画面元件预览</h1></div>
      </header>
      <div className="obs-preview-grid">
        {Object.entries(OVERLAY_META).map(([kind, meta]) => (
          <article key={kind}>
            <div><strong>{meta.label}</strong><span>{meta.size}</span></div>
            <div className={`obs-preview-frame obs-preview-${kind}`}>
              <OverlayContent kind={kind} state={SAMPLE_STATE} />
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

export {
  OVERLAY_META as OBS_OVERLAY_META,
  OverlayContent,
  SAMPLE_STATE
};
export { ObsOverlayPreview };
export default ObsOverlayRoute;
