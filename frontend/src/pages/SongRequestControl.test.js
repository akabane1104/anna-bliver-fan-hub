import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { FeedbackProvider } from '../components/FeedbackProvider';

jest.mock('../services', () => ({
  songRequestService: {
    getActiveSessions: jest.fn(),
    getRecoverableSessions: jest.fn(),
    getSessionRequests: jest.fn(),
    getCatalog: jest.fn(),
    getHistory: jest.fn(),
    createSession: jest.fn(),
    transitionSession: jest.fn(),
    createManualRequest: jest.fn(),
    transitionRequest: jest.fn(),
    setFulfillment: jest.fn(),
    matchRequest: jest.fn(),
    reorder: jest.fn()
  }
}));

const { songRequestService: mockSongRequestService } = jest.requireMock('../services');
const SongRequestControl = require('./SongRequestControl').default;

const session = {
  public_id: '14770010-286b-4324-bff5-3908af212b47',
  site_id: 'synthetic-site',
  room_id: '10001',
  playlist_id: 1,
  title: 'Synthetic Session',
  status: 'open',
  version: 4
};
const active = {
  public_id: 'db91693c-b19e-42b8-86f5-03bcc4db8e25',
  requested_title: '年轮',
  matched_song: { title: '年轮', artist: 'Synthetic Artist' },
  requester_display_name: 'Synthetic Viewer',
  source: 'website',
  status: 'active',
  fulfillment_type: 'sung',
  queue_order: null,
  version: 2
};
const firstWaiting = {
  public_id: '3100972f-95cc-4adc-bc53-ad8a716accc1',
  requested_title: '后来',
  matched_song: { title: '后来', artist: 'Synthetic Artist' },
  requester_display_name: 'Synthetic Viewer',
  source: 'website',
  status: 'queued',
  fulfillment_type: 'undecided',
  queue_order: '1',
  version: 0
};
const secondWaiting = {
  public_id: '0b31506c-0557-4a07-8350-cb1d23e2eb90',
  requested_title: '大鱼',
  matched_song: { title: '大鱼', artist: 'Synthetic Artist' },
  requester_display_name: 'Synthetic Viewer 2',
  source: 'bilibili_danmaku',
  status: 'queued',
  fulfillment_type: 'undecided',
  queue_order: '2',
  version: 1
};

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

describe('SongRequestControl', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockSongRequestService.getActiveSessions.mockResolvedValue({ sessions: [session] });
    mockSongRequestService.getRecoverableSessions.mockResolvedValue({ sessions: [session] });
    mockSongRequestService.getSessionRequests.mockResolvedValue({
      session,
      requests: [active, firstWaiting, secondWaiting]
    });
    mockSongRequestService.getCatalog.mockResolvedValue({
      playlist: { id: 1, title: 'Synthetic Playlist' },
      songs: [
        { id: 1, title: '年轮', artist: 'Synthetic Artist' },
        { id: 2, title: '后来', artist: 'Synthetic Artist' }
      ],
      pagination: { page: 1, totalPages: 1, total: 2 }
    });
    mockSongRequestService.getHistory.mockResolvedValue({
      requests: [{
        ...active,
        status: 'completed',
        source: 'website',
        requested_at: '2026-07-23T00:00:00.000Z',
        last_actor_display_name: 'Synthetic Admin'
      }],
      pagination: { page: 1, totalPages: 1, total: 1 }
    });
    for (const method of [
      'transitionSession',
      'createManualRequest',
      'transitionRequest',
      'setFulfillment',
      'matchRequest',
      'reorder'
    ]) {
      mockSongRequestService[method].mockResolvedValue({ status: 'accepted' });
    }
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
        <MemoryRouter>
          <FeedbackProvider>
            <SongRequestControl />
          </FeedbackProvider>
        </MemoryRouter>
      );
      await flush();
      await flush();
    });
  }

  test('loads current, next, waiting queue, source, and paginated history', async () => {
    await renderPage();
    expect(container.textContent).toContain('点歌控制');
    expect(container.textContent).toContain('年轮');
    expect(container.textContent).toContain('后来');
    expect(container.textContent).toContain('B站弹幕');
    expect(container.textContent).toContain('Synthetic Admin');
    expect(container.textContent).toContain('第 1 / 1 页，共 1 条');
    expect(container.textContent).not.toMatch(/open_id|event_id|Secret/);
  });

  test('manual add, complete, skip, and reorder call the existing APIs', async () => {
    await renderPage();
    const addButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '加入队列');
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(mockSongRequestService.createManualRequest).toHaveBeenCalledWith(expect.objectContaining({
      site_id: session.site_id,
      room_id: session.room_id,
      session_public_id: session.public_id,
      song_id: 1
    }));

    const completeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '完成');
    const skipButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '跳过');
    await act(async () => {
      completeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      skipButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(mockSongRequestService.transitionRequest).toHaveBeenCalledWith(
      active.public_id,
      'complete',
      active.version
    );
    expect(mockSongRequestService.transitionRequest).toHaveBeenCalledWith(
      active.public_id,
      'skip',
      active.version
    );

    const moveDown = container.querySelector(`button[aria-label="下移 后来"]`);
    await act(async () => {
      moveDown.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(mockSongRequestService.reorder).toHaveBeenCalledWith(
      session.public_id,
      session.version,
      [secondWaiting.public_id, firstWaiting.public_id]
    );
  });

  test('remove requires confirmation before issuing cancel', async () => {
    await renderPage();
    const removeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '移除');
    act(() => removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(mockSongRequestService.transitionRequest).not.toHaveBeenCalledWith(
      firstWaiting.public_id,
      'cancel',
      firstWaiting.version
    );

    const confirmButton = [...container.querySelectorAll('.feedback-modal-actions button')]
      .find((button) => button.textContent === '确认移除');
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(mockSongRequestService.transitionRequest).toHaveBeenCalledWith(
      firstWaiting.public_id,
      'cancel',
      firstWaiting.version
    );
  });

  test('same-tick destructive action enters the API only once before the first promise settles', async () => {
    const transition = deferred();
    mockSongRequestService.transitionSession.mockReturnValue(transition.promise);
    await renderPage();
    const closeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '关闭场次');

    act(() => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const callsBeforeRelease = mockSongRequestService.transitionSession.mock.calls.length;
    await act(async () => {
      transition.resolve({ status: 'accepted' });
      await flush();
      await flush();
    });
    expect(callsBeforeRelease).toBe(1);
  });

  test('same-tick session creation enters the API only once', async () => {
    const creation = deferred();
    mockSongRequestService.getRecoverableSessions.mockResolvedValue({ sessions: [] });
    mockSongRequestService.createSession.mockReturnValue(creation.promise);
    await renderPage();
    const form = container.querySelector('.song-session-form');

    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const callsBeforeRelease = mockSongRequestService.createSession.mock.calls.length;
    await act(async () => {
      creation.resolve({ session: { ...session, status: 'draft', version: 0 } });
      await flush();
      await flush();
    });
    expect(callsBeforeRelease).toBe(1);
    expect(mockSongRequestService.transitionSession).toHaveBeenCalledTimes(1);
  });

  test('reload recovers a draft and uses its real identity when opening it', async () => {
    const draft = { ...session, public_id: 'synthetic-draft', status: 'draft', version: 2 };
    mockSongRequestService.getActiveSessions.mockResolvedValue({ sessions: [] });
    mockSongRequestService.getRecoverableSessions.mockResolvedValue({ sessions: [draft] });
    mockSongRequestService.getSessionRequests.mockResolvedValue({
      session: draft,
      requests: []
    });
    await renderPage();

    expect(mockSongRequestService.getRecoverableSessions).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('草稿待开放');
    const openButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '开放草稿');
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });
    expect(mockSongRequestService.transitionSession).toHaveBeenCalledWith(
      draft.public_id,
      'open',
      draft.version
    );
    expect(mockSongRequestService.createSession).not.toHaveBeenCalled();
  });

  test('remount recovers the same draft without creating a replacement', async () => {
    const draft = { ...session, public_id: 'synthetic-remount-draft', status: 'draft', version: 3 };
    mockSongRequestService.getRecoverableSessions.mockResolvedValue({ sessions: [draft] });
    mockSongRequestService.getSessionRequests.mockResolvedValue({
      session: draft,
      requests: []
    });
    await renderPage();

    act(() => root.unmount());
    root = createRoot(container);
    await renderPage();

    expect(mockSongRequestService.getRecoverableSessions).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('草稿待开放');
    expect(mockSongRequestService.createSession).not.toHaveBeenCalled();
  });

  test('ambiguous draft recovery fails closed and does not choose or create a session', async () => {
    mockSongRequestService.getRecoverableSessions.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'ambiguous_draft_sessions' }
      }
    });
    await renderPage();

    expect(container.textContent).toContain('请求与当前队列状态冲突，请刷新后重试。');
    expect(container.textContent).toContain('开放点歌场次');
    expect(mockSongRequestService.getSessionRequests).not.toHaveBeenCalled();
    expect(mockSongRequestService.createSession).not.toHaveBeenCalled();
  });

  test('older history success cannot overwrite a newer manual refresh', async () => {
    await renderPage();
    const older = deferred();
    const newer = deferred();
    mockSongRequestService.getHistory
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const refreshButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重新整理');

    act(() => {
      refreshButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      refreshButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockSongRequestService.getHistory).toHaveBeenCalledTimes(3);
    expect(mockSongRequestService.getHistory.mock.results[1].value).toBe(older.promise);
    expect(mockSongRequestService.getHistory.mock.results[2].value).toBe(newer.promise);
    await act(async () => {
      newer.resolve({
        requests: [{
          ...active,
          public_id: 'newer-history',
          requested_title: 'Newer Synthetic Song',
          matched_song: { title: 'Newer Synthetic Song', artist: 'Synthetic Artist' },
          requested_at: '2026-07-24T00:00:00.000Z'
        }],
        pagination: { page: 1, totalPages: 1, total: 1 }
      });
      await flush();
    });
    expect(container.textContent).toContain('Newer Synthetic Song');

    await act(async () => {
      older.resolve({
        requests: [{
          ...active,
          public_id: 'older-history',
          requested_title: 'Older Synthetic Song',
          matched_song: { title: 'Older Synthetic Song', artist: 'Synthetic Artist' },
          requested_at: '2026-07-23T00:00:00.000Z'
        }],
        pagination: { page: 1, totalPages: 1, total: 1 }
      });
      await flush();
    });
    expect(container.textContent).toContain('Newer Synthetic Song');
    expect(container.textContent).not.toContain('Older Synthetic Song');
  });

  test('older visibility polling response cannot overwrite a newer manual queue refresh', async () => {
    await renderPage();
    const polling = deferred();
    const manual = deferred();
    mockSongRequestService.getSessionRequests
      .mockImplementationOnce(() => polling.promise)
      .mockImplementationOnce(() => manual.promise);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    });
    const refreshButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重新整理');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      refreshButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      manual.resolve({
        session,
        requests: [{
          ...firstWaiting,
          public_id: 'newer-queue',
          requested_title: 'Newer Queue Song',
          matched_song: { title: 'Newer Queue Song', artist: 'Synthetic Artist' }
        }]
      });
      await flush();
    });
    expect(container.textContent).toContain('Newer Queue Song');

    await act(async () => {
      polling.resolve({
        session,
        requests: [{
          ...firstWaiting,
          public_id: 'older-queue',
          requested_title: 'Older Queue Song',
          matched_song: { title: 'Older Queue Song', artist: 'Synthetic Artist' }
        }]
      });
      await flush();
    });
    expect(container.textContent).toContain('Newer Queue Song');
    expect(container.textContent).not.toContain('Older Queue Song');
  });

  test('late recovery response cannot revive a session closed by a newer mutation', async () => {
    await renderPage();
    const staleRecovery = deferred();
    const postMutationRecovery = deferred();
    mockSongRequestService.getRecoverableSessions
      .mockImplementationOnce(() => staleRecovery.promise)
      .mockImplementationOnce(() => postMutationRecovery.promise);
    const refreshButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重新整理');
    const closeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '关闭场次');

    act(() => {
      refreshButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await flush();
      postMutationRecovery.resolve({ sessions: [] });
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('开放点歌场次');

    await act(async () => {
      staleRecovery.resolve({ sessions: [session] });
      await flush();
    });
    expect(container.textContent).toContain('开放点歌场次');
    expect(container.textContent).not.toContain('暂停场次');
  });
});
