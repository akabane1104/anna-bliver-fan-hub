import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

jest.mock('../utils/usePollingResource');
jest.mock('../components/BackButton', () => () => null);
jest.mock('../components/LiveAdminNav', () => () => <nav>直播中控导航</nav>);
jest.mock('../components/FeedbackProvider', () => ({
  InlineAlert: ({ children }) => <div role="alert">{children}</div>,
  useFeedback: () => ({ toast: jest.fn() })
}));
jest.mock('../services', () => ({
  liveAdminService: {
    getHome: jest.fn(),
    setOverride: jest.fn(),
    setSongRequestsOpen: jest.fn(),
    setActivity: jest.fn(),
    advanceCurrent: jest.fn(),
    setEtaPaused: jest.fn(),
    undoLastAction: jest.fn()
  },
  songRequestService: {
    getRecoverableSessions: jest.fn(),
    getSessionRequests: jest.fn(),
    transitionRequest: jest.fn()
  }
}));

const usePollingResource = require('../utils/usePollingResource').default;
const {
  liveAdminService: mockLiveAdminService,
  songRequestService: mockSongRequestService
} = jest.requireMock('../services');
const LiveControlAdmin = require('./LiveControlAdmin').default;

const DATA = {
  home: {
    mode: 'live',
    status_label: '直播中',
    updated_at: '2026-07-26T10:00:00.000Z',
    refresh_after_ms: 5000,
    song_requests: {
      open: true,
      queue_count: 1,
      current: { title: '当前歌曲', artist: '当前歌手' },
      next: { title: '下一首', artist: '下一位歌手' }
    },
    activity: null,
    recent_support: [],
    control: {
      override_mode: 'auto',
      official_state: 'live',
      listener: { state: 'connected' },
      room_id_configured: false,
      queue: {
        revision: 18,
        current: {
          public_id: 'req-current',
          status: 'active',
          version: 3,
          title: '当前歌曲',
          artist: '当前歌手'
        },
        waiting: [{
          public_id: 'req-next',
          status: 'queued',
          version: 4,
          title: '下一首',
          artist: '下一位歌手'
        }],
        waiting_count: 1
      },
      eta: { paused: false, revision: 18 },
      undo: {
        available: true,
        expected_revision: 18,
        seconds_remaining: 22
      },
      activity: {
        enabled: true,
        title: '后台保留的活动',
        content: '即使目前尚未公开也能继续编辑',
        starts_at: '2026-07-27T10:00:00.000Z',
        ends_at: '2026-07-27T12:00:00.000Z'
      }
    }
  }
};

describe('LiveControlAdmin', () => {
  let container;
  let root;
  let refresh;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    refresh = jest.fn().mockResolvedValue(true);
    usePollingResource.mockReturnValue({
      data: DATA,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
      refresh
    });
    for (const method of [
      mockLiveAdminService.setOverride,
      mockLiveAdminService.setSongRequestsOpen,
      mockLiveAdminService.setActivity,
      mockLiveAdminService.advanceCurrent,
      mockLiveAdminService.setEtaPaused,
      mockLiveAdminService.undoLastAction,
      mockSongRequestService.transitionRequest
    ]) {
      method.mockResolvedValue({});
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(<LiveControlAdmin />);
      await Promise.resolve();
    });
  }

  function button(label) {
    return [...container.querySelectorAll('button')]
      .find((item) => item.textContent === label);
  }

  test('shows the mobile control essentials and shared preview', async () => {
    await render();
    expect(container.textContent).toContain('自动信号：live');
    expect(container.textContent).toContain('Listener：connected');
    expect(container.textContent).toContain('当前歌曲');
    expect(container.textContent).toContain('下一首');
    expect(container.textContent).toContain('等待 1 首');
    expect(container.textContent).toContain('尚未配置');
    expect(container.querySelector('[aria-label="直播首页预览"]')).not.toBeNull();
    expect(container.querySelector('input[maxlength="120"]').value).toBe('后台保留的活动');
  });

  test('sends the atomic complete-and-next command', async () => {
    await render();
    await act(async () => {
      button('唱完并下一首').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLiveAdminService.advanceCurrent).toHaveBeenCalledWith(
      'req-current',
      {
        expected_version: 3,
        outcome: 'completed',
        activate_next: true
      }
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('prevents duplicate override submissions', async () => {
    let resolveOverride;
    mockLiveAdminService.setOverride.mockReturnValue(new Promise((resolve) => {
      resolveOverride = resolve;
    }));
    await render();

    act(() => {
      button('强制直播').click();
      button('强制直播').click();
    });
    expect(mockLiveAdminService.setOverride).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOverride({});
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  test('toggles the persisted song request gate', async () => {
    await render();
    const toggle = container.querySelector('input[type="checkbox"]');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLiveAdminService.setSongRequestsOpen).toHaveBeenCalledWith(false);
  });

  test('can set a specific waiting request as current when no song is active', async () => {
    usePollingResource.mockReturnValue({
      data: {
        home: {
          ...DATA.home,
          control: {
            ...DATA.home.control,
            queue: {
              current: null,
              waiting: [{
                public_id: 'req-second',
                status: 'queued',
                version: 6,
                title: '指定歌曲'
              }],
              waiting_count: 1
            }
          }
        }
      },
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
      refresh
    });
    await render();
    const activate = container.querySelector(
      'button[aria-label="设为正在唱：指定歌曲"]'
    );
    await act(async () => {
      activate.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSongRequestService.transitionRequest).toHaveBeenCalledWith(
      'req-second',
      'activate',
      6
    );
  });

  test('sends a canonical skip reason and supports ETA pause plus revision undo', async () => {
    await render();
    await act(async () => {
      button('跳过').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button('暂停 ETA').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button('撤销（22 秒）').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLiveAdminService.advanceCurrent).toHaveBeenCalledWith(
      'req-current',
      {
        expected_version: 3,
        outcome: 'skipped',
        activate_next: false,
        reason_code: 'manual_skip',
        public_reason: '',
        internal_note: ''
      }
    );
    expect(mockLiveAdminService.setEtaPaused).toHaveBeenCalledWith(true, 18);
    expect(mockLiveAdminService.undoLastAction).toHaveBeenCalledWith(18);
  });
});
