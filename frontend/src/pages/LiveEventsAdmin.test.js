import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../services', () => ({
  liveAdminService: {
    getEvents: jest.fn()
  }
}));

const { liveAdminService: mockLiveAdminService } = jest.requireMock('../services');
const LiveEventsAdmin = require('./LiveEventsAdmin').default;
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));
const SESSION_ID = '21bf55c8-3b83-4a88-b7f8-fb8af41b2a4d';

function eventFixture(overrides = {}) {
  return {
    event_ref: 'safe-event-reference',
    event_type: 'danmaku',
    source: { mode: 'simulation', command: 'LIVE_OPEN_PLATFORM_DM' },
    target: {
      site_id: 'synthetic-site',
      room_id: '99000000000000000009',
      display_name: 'synthetic-site / 房间 99000000000000000009'
    },
    session: { public_id: SESSION_ID, title: 'Synthetic Session' },
    actor_display_name: 'Synthetic Viewer With A Very Long Display Name',
    occurred_at: '2026-07-23T01:00:00.000Z',
    received_at: '2026-07-23T01:00:01.000Z',
    content: {
      summary: '弹幕消息',
      text: '<script>window.privateLeak=true</script> 点歌 年轮 '.repeat(5)
    },
    processing: {
      status: 'recorded',
      reason_code: null,
      completed_at: '2026-07-23T01:00:01.500Z'
    },
    song_request: {
      public_id: 'a1ea2b41-e872-4509-8816-4a8a21e67fb7',
      requested_title: '年轮'.repeat(30),
      matched_song_title: '年轮',
      status: 'queued',
      match_method: 'exact',
      queue_assigned: true
    },
    actor_open_id: 'must-not-render-open-id',
    raw_payload: 'must-not-render-raw-payload',
    token: 'must-not-render-token',
    ...overrides
  };
}

function responseFixture(overrides = {}) {
  return {
    events: [eventFixture()],
    filters: {
      session_options: [{
        public_id: SESSION_ID,
        title: 'Synthetic Session',
        status: 'open',
        target: {
          display_name: 'synthetic-site / 房间 99000000000000000009'
        }
      }]
    },
    pagination: { page: 1, limit: 20, total: 21, totalPages: 2 },
    sort: ['received_at:desc', 'internal_stable_key:desc'],
    ...overrides
  };
}

describe('LiveEventsAdmin', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockLiveAdminService.getEvents.mockResolvedValue(responseFixture());
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
        <MemoryRouter initialEntries={['/admin/live-events']}>
          <LiveEventsAdmin />
        </MemoryRouter>
      );
      await flush();
      await flush();
    });
  }

  test('renders a safe event list, mobile cards, and escaped long content', async () => {
    await renderPage();
    expect(container.textContent).toContain('直播事件记录');
    expect(container.textContent).toContain('离线模拟');
    expect(container.textContent).toContain('Synthetic Viewer With A Very Long Display Name');
    expect(container.textContent).toContain('已进入统一点歌队列');
    expect(container.querySelector('.live-event-table')).not.toBeNull();
    expect(container.querySelector('.live-event-cards')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(window.privateLeak).toBeUndefined();
    expect(container.textContent).not.toMatch(
      /must-not-render-open-id|must-not-render-raw-payload|must-not-render-token/
    );
  });

  test('applies keyword, type, status, source, session, and date filters', async () => {
    await renderPage();
    const values = {
      query: '年轮',
      event_type: 'danmaku',
      status: 'recorded',
      source: 'simulation',
      session: SESSION_ID,
      start: '2026-07-23T08:00',
      end: '2026-07-23T10:00'
    };
    await act(async () => {
      for (const [name, value] of Object.entries(values)) {
        const input = container.querySelector(`[name="${name}"]`);
        const prototype = input.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event(
          input.tagName === 'SELECT' ? 'change' : 'input',
          { bubbles: true }
        ));
      }
      await flush();
    });
    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true
      }));
      await flush();
      await flush();
    });
    const lastParams = mockLiveAdminService.getEvents.mock.calls.at(-1)[0];
    expect(lastParams).toEqual(expect.objectContaining({
      query: '年轮',
      event_type: 'danmaku',
      status: 'recorded',
      source: 'simulation',
      session: SESSION_ID,
      page: 1,
      limit: 20
    }));
    expect(lastParams.start).toMatch(/Z$/);
    expect(lastParams.end).toMatch(/Z$/);
  });

  test('clears filters and uses server-side pagination without polling an old page', async () => {
    await renderPage();
    const next = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '下一页');
    await act(async () => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    expect(mockLiveAdminService.getEvents.mock.calls.at(-1)[0].page).toBe(2);
    expect(container.textContent).toContain('当前页不会自动插入新事件');

    const clear = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '清除全部');
    await act(async () => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    expect(mockLiveAdminService.getEvents.mock.calls.at(-1)[0]).toEqual({
      page: 1,
      limit: 20
    });
  });

  test('renders empty and safe error states', async () => {
    mockLiveAdminService.getEvents.mockResolvedValueOnce(responseFixture({
      events: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1 }
    }));
    await renderPage();
    expect(container.textContent).toContain('当前筛选条件下没有已保存事件');

    mockLiveAdminService.getEvents.mockRejectedValueOnce(new Error('private backend stack'));
    const refresh = [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === '刷新直播事件');
    await act(async () => {
      refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('事件记录服务暂时不可用');
    expect(container.textContent).not.toContain('private backend stack');
  });
});
