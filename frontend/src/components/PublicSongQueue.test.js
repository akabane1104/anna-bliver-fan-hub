import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PublicSongQueue from './PublicSongQueue';

describe('PublicSongQueue', () => {
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

  test('renders the no-session and empty queue state', () => {
    act(() => {
      root.render(
        <PublicSongQueue
          data={{ session: null, requests: [] }}
          loading={false}
          error=""
          onRetry={() => {}}
        />
      );
    });
    expect(container.textContent).toContain('当前还没有开放点歌');
    expect(container.textContent).toContain('歌单仍可浏览');
  });

  test('renders current, next, total, and safe requester display name', () => {
    act(() => {
      root.render(
        <PublicSongQueue
          data={{
            session: { public_id: 'safe-session', status: 'open' },
            requests: [
              {
                public_id: 'active',
                status: 'active',
                requested_title: '年轮',
                matched_song: { title: '年轮', artist: 'Synthetic Artist' }
              },
              {
                public_id: 'next',
                status: 'queued',
                queue_order: '2',
                requested_title: '后来',
                requester_display_name: 'Synthetic Viewer'
              }
            ]
          }}
          loading={false}
          error=""
          onRetry={() => {}}
        />
      );
    });
    expect(container.textContent).toContain('年轮');
    expect(container.textContent).toContain('后来');
    expect(container.textContent).toContain('Synthetic Viewer');
    expect(container.textContent).toContain('1首歌曲');
    expect(container.textContent).not.toMatch(/open_id|user_id|event_id/);
  });

  test('shows loading, errors, accepted state, and supports retry', () => {
    const retry = jest.fn();
    act(() => {
      root.render(
        <PublicSongQueue
          data={{ session: null, requests: [] }}
          loading
          error="服务暂时不可用，请稍后重试。"
          onRetry={retry}
          lastAccepted={{ requested_title: '年轮', queue_order: '3' }}
        />
      );
    });
    expect(container.textContent).toContain('刷新中');
    expect(container.textContent).toContain('已加入队列');
    expect(container.textContent).toContain('服务暂时不可用');
    const button = container.querySelector('button');
    expect(button.disabled).toBe(true);
  });
});
