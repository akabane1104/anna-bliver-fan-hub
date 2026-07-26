import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import ViewerSongRequestPanel from './ViewerSongRequestPanel';

const filters = { status: '', page: 1, limit: 10 };

describe('ViewerSongRequestPanel', () => {
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

  function render(props) {
    act(() => {
      root.render(
        <MemoryRouter>
          <ViewerSongRequestPanel
            authenticated
            data={null}
            loading={false}
            error=""
            filters={filters}
            onFiltersChange={() => {}}
            onRefresh={() => {}}
            onWithdraw={() => {}}
            onRerequest={() => {}}
            pending=""
            {...props}
          />
        </MemoryRouter>
      );
    });
  }

  test('keeps browsing public for guests and links to real login route', () => {
    render({ authenticated: false });
    expect(container.textContent).toContain('登录后查看点歌进度');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
  });

  test('shows binding, active request, canonical labels, history and actions', () => {
    const onWithdraw = jest.fn();
    const onRerequest = jest.fn();
    render({
      data: {
        binding: { bound: true, count: 2 },
        activeRequest: {
          publicId: 'active-request',
          revision: 5,
          status: 'queued',
          canonicalSong: { title: '年轮' },
          originalInput: '年輪',
          position: 2,
          aheadCount: 1,
          eta: { minMinutes: 4, maxMinutes: 7 }
        },
        history: [{
          publicId: 'history-request',
          status: 'skipped',
          canonicalSong: { title: '后来' },
          reasonCode: 'manual_skip',
          publicReason: '本场时间不足',
          eta: { paused: true }
        }],
        pagination: { page: 1, totalPages: 1, total: 1 }
      },
      onWithdraw,
      onRerequest
    });

    expect(container.textContent).toContain('已绑定 2 个B站账号');
    expect(container.textContent).toContain('等待中');
    expect(container.textContent).toContain('已跳过');
    expect(container.textContent).toContain('约 4–7 分钟');
    expect(container.textContent).toContain('本场时间不足');
    expect(container.querySelector('select[aria-label="筛选我的点歌状态"]')).not.toBeNull();

    act(() => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '撤回点歌')
        .click();
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '再次点歌')
        .click();
    });
    expect(onWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'active-request' }),
      5
    );
    expect(onRerequest).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'history-request' })
    );
  });

  test('gives an unbound viewer a profile action without hiding the catalog state', () => {
    render({
      data: {
        binding: { bound: false, count: 0 },
        activeRequest: null,
        history: [],
        pagination: { page: 1, totalPages: 1, total: 0 }
      }
    });
    expect(container.textContent).toContain('点歌前需要绑定B站账号');
    expect(container.querySelector('a[href="/profile"]')).not.toBeNull();
  });
});
