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

  test('renders the closed and empty queue state', () => {
    act(() => {
      root.render(
        <PublicSongQueue
          data={{
            public: {
              effectiveOpen: false,
              closeReason: '主播休息中',
              capacityCount: 0,
              queueLimit: 12,
              reopenThreshold: 8,
              queue: [],
              todayCompleted: []
            }
          }}
          loading={false}
          error=""
          onRetry={() => {}}
        />
      );
    });
    expect(container.textContent).toContain('点歌已关闭：主播休息中');
    expect(container.textContent).toContain('等待队列为空');
  });

  test('renders public DTO fields without exposing raw identities or ids', () => {
    act(() => {
      root.render(
        <PublicSongQueue
          data={{
            public: {
              effectiveOpen: true,
              capacityCount: 2,
              queueLimit: 12,
              reopenThreshold: 8,
              current: {
                displayKey: 'current-key',
                status: 'singing',
                canonicalSong: { title: '年轮', artist: 'Synthetic Artist' },
                maskedDisplayName: 'A***a',
                eta: { minMinutes: 0, maxMinutes: 0 },
                isMine: false
              },
              next: {
                displayKey: 'next-key',
                status: 'queued',
                position: 2,
                canonicalSong: { title: '后来', artist: 'Synthetic Artist' },
                maskedDisplayName: 'S***r',
                eta: { minMinutes: 4, maxMinutes: 7 },
                isMine: true
              },
              queue: [{
                displayKey: 'next-key',
                position: 2,
                canonicalSong: { title: '后来', artist: 'Synthetic Artist' },
                maskedDisplayName: 'S***r',
                eta: { minMinutes: 4, maxMinutes: 7 },
                status: 'queued',
                isMine: true,
                public_id: 'must-not-render',
                requester_display_name: 'Raw Synthetic Viewer',
                user_id: 42
              }],
              todayCompleted: [],
              updatedAt: '2026-07-26T10:00:00.000Z'
            }
          }}
          loading={false}
          error=""
          onRetry={() => {}}
        />
      );
    });
    expect(container.textContent).toContain('年轮');
    expect(container.textContent).toContain('后来');
    expect(container.textContent).toContain('S***r');
    expect(container.textContent).toContain('约 4–7 分钟');
    expect(container.textContent).toContain('我的点歌');
    expect(container.textContent).not.toContain('Raw Synthetic Viewer');
    expect(container.textContent).not.toContain('must-not-render');
    expect(container.textContent).not.toMatch(/open_id|user_id|event_id|public_id/);
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
