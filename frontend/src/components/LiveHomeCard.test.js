import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LiveHomeCard from './LiveHomeCard';

const LIVE_DATA = {
  mode: 'live',
  status_label: '直播中',
  room_url: 'https://live.bilibili.com/1234',
  song_requests: {
    open: true,
    queue_count: 2,
    current: { title: '正在唱的很长很长歌曲名称', artist: '当前歌手' },
    next: { title: '下一首歌曲', artist: null }
  },
  activity: {
    title: '今日活动',
    content: '一起听歌。'
  },
  recent_support: [
    {
      type: 'gift',
      display_name: '支持者',
      item_name: '醒目留言',
      count: 2,
      occurred_at: '2026-07-26T10:00:00.000Z'
    },
    {
      type: 'guard',
      display_name: '上舰观众',
      item_name: '舰长',
      count: 1,
      occurred_at: '2026-07-26T10:01:00.000Z'
    }
  ]
};

describe('LiveHomeCard', () => {
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

  function render(data, props = {}) {
    act(() => root.render(<LiveHomeCard data={data} {...props} />));
  }

  test('renders live queue, activity, support, and safe room link', () => {
    render(LIVE_DATA);
    expect(container.textContent).toContain('正在唱的很长很长歌曲名称');
    expect(container.textContent).toContain('下一首歌曲');
    expect(container.textContent).toContain('排队 2 首');
    expect(container.textContent).toContain('点歌开放中');
    expect(container.textContent).toContain('今日活动');
    expect(container.textContent).toContain('支持者');
    expect(container.textContent).toContain('上舰观众');
    expect(container.querySelector('a')?.href).toBe('https://live.bilibili.com/1234');
  });

  test('handles empty queue and closed requests without broken links', () => {
    render({
      ...LIVE_DATA,
      room_url: null,
      activity: null,
      recent_support: [],
      song_requests: {
        open: false,
        queue_count: 0,
        current: null,
        next: null
      }
    });
    expect(container.textContent).toContain('目前没有正在演唱的歌曲');
    expect(container.textContent).toContain('队列里还没有下一首');
    expect(container.textContent).toContain('排队 0 首');
    expect(container.textContent).toContain('点歌已关闭');
    expect(container.querySelector('a')).toBeNull();
  });

  test('keeps syncing content but hides offline mode outside previews', () => {
    render({ ...LIVE_DATA, mode: 'syncing', status_label: '重新同步中' });
    expect(container.textContent).toContain('重新同步中');
    expect(container.textContent).toContain('正在唱的很长很长歌曲名称');

    act(() => root.render(<LiveHomeCard data={{ ...LIVE_DATA, mode: 'offline' }} />));
    expect(container.innerHTML).toBe('');

    act(() => root.render(
      <LiveHomeCard data={{ ...LIVE_DATA, mode: 'offline' }} showOffline preview />
    ));
    expect(container.textContent).toContain('公开首页会保留目前的一般版面');
  });
});
