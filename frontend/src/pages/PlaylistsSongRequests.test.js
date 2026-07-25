import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { FeedbackProvider } from '../components/FeedbackProvider';

jest.mock('../services', () => ({
  songRequestService: {
    getCatalog: jest.fn(),
    getCurrentQueue: jest.fn(),
    create: jest.fn()
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
  { id: 1, title: '年轮', artist: 'Synthetic Artist', tags: [{ id: 1, name: '流行', color: '#C04D00' }] },
  { id: 2, title: '後來', artist: 'Synthetic Artist', tags: [{ id: 2, name: '粤语', color: '#803200' }] }
];

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
    mockSongRequestService.getCurrentQueue.mockResolvedValue({
      session: { public_id: 'synthetic-session', status: 'open' },
      requests: []
    });
    mockSongRequestService.create.mockResolvedValue({
      status: 'accepted',
      request: {
        public_id: 'synthetic-request',
        requested_title: '年轮',
        status: 'queued',
        queue_order: '1'
      }
    });
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
          public_id: 'synthetic-request',
          requested_title: '年轮',
          status: 'queued',
          queue_order: '1'
        }
      });
      await flush();
    });
    expect(container.textContent).toContain('已加入队列');
    expect(mockSongRequestService.getCurrentQueue.mock.calls.length).toBeGreaterThan(1);
  });

  test('cleans up queue polling when leaving the page', async () => {
    const clearIntervalSpy = jest.spyOn(window, 'clearInterval');
    await renderPage();
    act(() => root.unmount());
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    root = createRoot(container);
  });
});
