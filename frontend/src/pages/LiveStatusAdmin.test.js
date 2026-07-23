import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../services', () => ({
  liveAdminService: {
    getStatus: jest.fn()
  }
}));

const { liveAdminService: mockLiveAdminService } = jest.requireMock('../services');
const LiveStatusAdmin = require('./LiveStatusAdmin').default;
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

function statusFixture(overrides = {}) {
  return {
    completeness: 'partial',
    server_time: '2026-07-23T02:00:00.000Z',
    updated_at: '2026-07-23T02:00:00.000Z',
    backend: { status: 'available' },
    database: { status: 'available' },
    sessions: {
      state: 'active',
      active_count: 1,
      items: [{
        public_id: '21bf55c8-3b83-4a88-b7f8-fb8af41b2a4d',
        title: 'Synthetic Session',
        status: 'open',
        target: {
          site_id: 'synthetic-site',
          room_id: '99000000000000000009',
          display_name: 'synthetic-site / 房间 99000000000000000009'
        },
        started_at: '2026-07-23T00:00:00.000Z',
        ended_at: null,
        last_event_at: '2026-07-23T01:00:00.000Z',
        saved_event_count: 4,
        queue: { needs_match: 1, queued: 2, active: 1, total_current: 4 }
      }]
    },
    listener: {
      availability: 'unavailable',
      enabled: null,
      configured: null,
      blocked: null,
      adapter_state: 'unknown',
      last_state_change_at: null,
      last_event_received_at: null,
      reason_code: 'listener_status_not_reported',
      retry_count: 0,
      reconnect_count: 0
    },
    bilibili_connection: {
      api_state: 'unknown',
      wss_state: 'unknown',
      authoritative: false
    },
    ingestion: {
      status: 'available',
      total_saved: 4,
      recent_event_count: 1,
      last_event_at: '2026-07-23T01:00:00.000Z'
    },
    ...overrides
  };
}

describe('LiveStatusAdmin', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/admin/live-status']}>
          <LiveStatusAdmin />
        </MemoryRouter>
      );
      await flush();
      await flush();
    });
  }

  test('renders system, session, listener, ingestion, and WSS as separate states', async () => {
    mockLiveAdminService.getStatus.mockResolvedValue(statusFixture());
    await renderPage();
    expect(container.textContent).toContain('Synthetic Session');
    expect(container.textContent).toContain('已开放');
    expect(container.textContent).toContain('Listener / Source Adapter');
    expect(container.textContent).toContain('状态不可用');
    expect(container.textContent).toContain('B站 WSS');
    expect(container.textContent).toContain('连接状态是否权威否');
    expect(container.textContent).not.toContain('B站 WSS已连接');
  });

  test('shows no-session, conflict, blocked, and partial status explicitly', async () => {
    mockLiveAdminService.getStatus.mockResolvedValue(statusFixture({
      sessions: {
        state: 'conflict',
        active_count: 2,
        items: [
          ...statusFixture().sessions.items,
          {
            ...statusFixture().sessions.items[0],
            public_id: 'e15b3102-0ca4-4c3f-a1f0-f7dc33d2f203',
            title: 'Second Synthetic Session'
          }
        ]
      },
      listener: {
        ...statusFixture().listener,
        availability: 'blocked',
        enabled: true,
        configured: true,
        blocked: true,
        adapter_state: 'fatal',
        reason_code: 'official_wss_allowlist_unverified'
      },
      bilibili_connection: {
        api_state: 'disconnected',
        wss_state: 'blocked',
        authoritative: false
      }
    }));
    await renderPage();
    expect(container.textContent).toContain('多个场次待选择');
    expect(container.textContent).toContain('本页不会自行选择其中一场');
    expect(container.textContent).toContain('受到安全条件阻挡');
    expect(container.textContent).toContain('official_wss_allowlist_unverified');
    expect(container.textContent).toContain('部分状态可用');
  });

  test('renders an understandable error and can retry', async () => {
    mockLiveAdminService.getStatus
      .mockRejectedValueOnce(new Error('private stack detail'))
      .mockResolvedValueOnce(statusFixture({
        sessions: { state: 'none', active_count: 0, items: [] }
      }));
    await renderPage();
    expect(container.textContent).toContain('直播状态服务暂时不可用');
    expect(container.textContent).not.toContain('private stack detail');
    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重试');
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('当前没有开放或暂停中的网站直播场次');
    expect(mockLiveAdminService.getStatus).toHaveBeenCalledTimes(2);
  });
});
