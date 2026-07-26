import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ObsOverlayPreview,
  OverlayContent,
  SAMPLE_STATE
} from './ObsOverlay';

describe('OBS overlay presentation', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(content) {
    act(() => root.render(content));
  }

  test('renders canonical current and queue data with masked requester names', () => {
    render(<OverlayContent kind="now-playing" state={SAMPLE_STATE} />);
    expect(container.textContent).toContain('小幸运');
    expect(container.textContent).toContain('小***娜');

    render(<OverlayContent kind="song-queue" state={SAMPLE_STATE} />);
    expect(container.textContent).toContain('点歌队列');
    expect(container.textContent).toContain('云***朵');
    expect(container.textContent).not.toContain('requester_user_id');
  });

  test('renders all ten queue rows allowed by maxItems', () => {
    const queue = Array.from({ length: 10 }, (_, index) => ({
      displayKey: `queue-${index + 1}`,
      title: `Queue Song ${index + 1}`,
      requester: `Q***${index + 1}`
    }));
    render(<OverlayContent kind="song-queue" state={{ events: [], queue }} />);
    expect(container.querySelectorAll('li')).toHaveLength(10);
    expect(container.textContent).toContain('Queue Song 10');
  });

  test('renders next song, today count, and bounded activity progress', () => {
    render(<OverlayContent kind="next-song" state={SAMPLE_STATE} />);
    expect(container.textContent).toContain('暖暖');
    render(<OverlayContent kind="today-count" state={SAMPLE_STATE} />);
    expect(container.textContent).toContain('今日点歌');
    expect(container.textContent).toContain('18');
    render(<OverlayContent kind="activity-progress" state={SAMPLE_STATE} />);
    expect(container.textContent).toContain('64%');
    expect(container.textContent).toContain('进行中');
    render(<OverlayContent
      kind="activity-progress"
      state={{
        events: [],
        activity: {
          title: '已结束活动',
          content: '',
          progress: 1,
          status: 'ended'
        }
      }}
    />);
    expect(container.textContent).toContain('100%');
    expect(container.textContent).toContain('已结束');
  });

  test('hides data-driven overlays when their canonical data is unavailable', () => {
    render(<OverlayContent kind="now-playing" state={{ events: [] }} />);
    expect(container.innerHTML).toBe('');
    render(<OverlayContent kind="activity-progress" state={{ events: [] }} />);
    expect(container.innerHTML).toBe('');
  });

  test('renders event payload as text rather than HTML', () => {
    const state = {
      events: [{
        publicId: 'notice-plain-text',
        sequence: '10',
        eventType: 'notice',
        displayDurationMs: 60000,
        payload: { text: '<b>Synthetic notice</b>', style: 'info' }
      }]
    };
    render(<OverlayContent kind="notice" state={state} />);
    expect(container.textContent).toContain('<b>Synthetic notice</b>');
    expect(container.querySelector('b b')).toBeNull();
  });

  test('plays multiple temporary events in sequence without overlap', () => {
    jest.useFakeTimers();
    const state = {
      events: [
        {
          publicId: 'notice-one',
          sequence: '1',
          eventType: 'notice',
          displayDurationMs: 1000,
          payload: { text: 'First notice', style: 'info' }
        },
        {
          publicId: 'notice-two',
          sequence: '2',
          eventType: 'notice',
          displayDurationMs: 1000,
          payload: { text: 'Second notice', style: 'success' }
        }
      ]
    };
    render(<OverlayContent kind="notice" state={state} />);
    expect(container.textContent).toContain('First notice');
    expect(container.textContent).not.toContain('Second notice');
    act(() => jest.advanceTimersByTime(1000));
    expect(container.textContent).toContain('Second notice');
    jest.useRealTimers();
  });

  test('preview includes every Phase 4J browser source', () => {
    render(<ObsOverlayPreview />);
    for (const label of [
      '正在演唱',
      '下一首',
      '点歌队列',
      '今日点歌',
      '今日活动',
      '礼物感谢',
      '上舰提醒',
      '棉花糖',
      'AI 气泡',
      '直播通知'
    ]) {
      expect(container.textContent).toContain(label);
    }
  });
});
