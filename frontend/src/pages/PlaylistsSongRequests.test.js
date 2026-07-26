import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { FeedbackProvider } from '../components/FeedbackProvider';

jest.mock('../services', () => ({
  songRequestService: {
    getCatalog: jest.fn(),
    getCenter: jest.fn(),
    getMine: jest.fn(),
    create: jest.fn(),
    withdraw: jest.fn(),
    rerequest: jest.fn()
  },
  playlistService: {
    getAllSongs: jest.fn(),
    getAllTags: jest.fn(),
    updateSong: jest.fn(),
    deleteSong: jest.fn(),
    addSong: jest.fn(),
    batchAddSongs: jest.fn(),
    updateTag: jest.fn(),
    deleteTag: jest.fn()
  },
  authService: {
    getCurrentUser: jest.fn(),
    isAuthenticated: jest.fn()
  },
  permissionService: {
    getMyPermissions: jest.fn(),
    PERMISSIONS: { PLAYLIST_MANAGE: 'playlist.manage' }
  }
}));

jest.mock('../context/SiteSettingsContext', () => ({
  useSiteSettings: () => ({
    siteSettings: {
      playlistTitle: 'Synthetic Playlist',
      playlistSubtitle: 'Synthetic Subtitle'
    }
  })
}));

const {
  songRequestService: mockSongRequestService,
  playlistService: mockPlaylistService,
  authService: mockAuthService,
  permissionService: mockPermissionService
} = jest.requireMock('../services');
const Playlists = require('./Playlists').default;

const songs = [
  {
    id: 1,
    title: '年轮',
    artist: 'Synthetic Artist',
    tags: [{ id: 1, name: '流行', color: '#C04D00' }],
    availability: { requestable: true }
  },
  {
    id: 2,
    title: '後來',
    artist: 'Synthetic Artist',
    tags: [{ id: 2, name: '粤语', color: '#803200' }],
    availability: {
      requestable: false,
      reason_code: 'song_cooldown',
      public_reason: '这首歌仍在冷却时间'
    }
  }
];

const center = {
  public: {
    effectiveOpen: true,
    manualOpen: true,
    autoCapacityBlocked: false,
    closeReason: '',
    capacityCount: 1,
    queueLimit: 12,
    reopenThreshold: 8,
    current: null,
    next: {
      displayKey: 'queue-next',
      position: 1,
      canonicalSong: { title: '年轮', artist: 'Synthetic Artist' },
      maskedDisplayName: 'S***r',
      eta: { minMinutes: 3, maxMinutes: 6 },
      status: 'queued',
      isMine: true
    },
    queue: [],
    todayCompleted: [],
    activity: null,
    updatedAt: '2026-07-26T10:00:00.000Z'
  }
};

const mine = {
  binding: { bound: true, count: 1 },
  activeRequest: null,
  history: [],
  pagination: { page: 1, totalPages: 1, total: 0 }
};

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('Playlists song request integration', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockAuthService.getCurrentUser.mockReturnValue({ id: 42, role: 'user', username: 'Synthetic Viewer' });
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockPermissionService.getMyPermissions.mockResolvedValue({ permissions: [] });
    mockPlaylistService.getAllSongs.mockResolvedValue(songs);
    mockPlaylistService.getAllTags.mockResolvedValue([
      { id: 1, name: '流行' },
      { id: 2, name: '粤语' }
    ]);
    mockSongRequestService.getCatalog.mockResolvedValue({
      playlist: { id: 1, title: 'Synthetic Playlist' },
      songs,
      pagination: { page: 1, limit: 500, total: 2, totalPages: 1 }
    });
    mockSongRequestService.getCenter.mockResolvedValue(center);
    mockSongRequestService.getMine.mockResolvedValue(mine);
    mockSongRequestService.create.mockResolvedValue({
      status: 'accepted',
      request: {
        publicId: 'synthetic-request',
        canonicalSong: { title: '年轮' },
        status: 'queued',
        position: 1
      }
    });
    mockSongRequestService.withdraw.mockResolvedValue({ status: 'accepted' });
    mockSongRequestService.rerequest.mockResolvedValue({ status: 'accepted' });
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
            <Playlists />
          </FeedbackProvider>
        </MemoryRouter>
      );
      await flush();
      await flush();
    });
  }

  test('loads songs and queue, debounces search, and applies category filters', async () => {
    await renderPage();
    expect(container.textContent).toContain('年轮');
    expect(container.textContent).toContain('後來');
    expect(container.textContent).toContain('当前点歌进度');
    expect(container.textContent).toContain('点歌进度与历史');
    expect(container.textContent).toContain('这首歌仍在冷却时间');
    expect(container.querySelector('button[aria-label="这首歌仍在冷却时间 後來"]').disabled).toBe(true);

    const search = container.querySelector('input[aria-label="搜索歌名、歌手或别名"]');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;
      setValue.call(search, '年輪');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 330));
      await flush();
      await flush();
    });
    expect(mockSongRequestService.getCatalog).toHaveBeenCalledWith(expect.objectContaining({
      query: '年輪'
    }));

    const tagButton = [...container.querySelectorAll('.filter-tag-btn')]
      .find((button) => button.textContent === '粤语');
    await act(async () => {
      tagButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(mockSongRequestService.getCatalog).toHaveBeenCalledWith(expect.objectContaining({
      tag: '粤语'
    }));
  });

  test('prevents double submission and refreshes only after server acceptance', async () => {
    let resolveCreate;
    mockSongRequestService.create.mockReturnValue(new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    await renderPage();
    const button = container.querySelector('button[aria-label="点歌 年轮"]');

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockSongRequestService.create).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('已加入队列');

    await act(async () => {
      resolveCreate({
        status: 'accepted',
        request: {
          publicId: 'synthetic-request',
          canonicalSong: { title: '年轮' },
          status: 'queued',
          position: 1
        }
      });
      await flush();
    });
    expect(container.textContent).toContain('已加入队列');
    expect(mockSongRequestService.getCenter.mock.calls.length).toBeGreaterThan(1);
    expect(mockSongRequestService.getMine.mock.calls.length).toBeGreaterThan(1);
  });

  test('cleans up queue polling when leaving the page', async () => {
    const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
    await renderPage();
    act(() => root.unmount());
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    root = createRoot(container);
  });

  test('withdraws an active viewer request and refreshes both private and public state', async () => {
    mockSongRequestService.getMine.mockResolvedValue({
      ...mine,
      activeRequest: {
        publicId: 'viewer-request',
        revision: 7,
        status: 'queued',
        canonicalSong: { title: '年轮' },
        position: 2,
        aheadCount: 1,
        eta: { minMinutes: 5, maxMinutes: 8 }
      }
    });
    await renderPage();
    const withdraw = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '撤回点歌');
    await act(async () => {
      withdraw.click();
      await flush();
    });
    expect(mockSongRequestService.withdraw).toHaveBeenCalledWith('viewer-request', 7);
    expect(mockSongRequestService.getCenter.mock.calls.length).toBeGreaterThan(1);
  });
});
