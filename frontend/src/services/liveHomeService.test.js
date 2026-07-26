jest.mock('./api', () => ({
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn()
}));

const api = require('./api');
const liveHomeService = require('./liveHomeService').default;
const liveAdminService = require('./liveAdminService').default;

describe('live home API services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: { mode: 'offline' } });
    api.put.mockResolvedValue({ data: { status: 'ok' } });
    api.post.mockResolvedValue({ data: { status: 'ok' } });
  });

  test('uses one public aggregate endpoint with cancellation', async () => {
    const controller = new AbortController();
    await liveHomeService.getHome({ signal: controller.signal });
    expect(api.get).toHaveBeenCalledWith('/live-home', {
      signal: controller.signal
    });
  });

  test('uses the existing protected live-control endpoints', async () => {
    await liveAdminService.setOverride('force_live', '2026-07-26T12:00:00.000Z');
    await liveAdminService.setSongRequestsOpen(false);
    await liveAdminService.setActivity({
      enabled: false,
      title: '',
      content: '',
      starts_at: null,
      ends_at: null
    });
    await liveAdminService.advanceCurrent('req-1', {
      expected_version: 2,
      outcome: 'skipped',
      activate_next: true
    });
    await liveAdminService.setEtaPaused(true, 9);
    await liveAdminService.undoLastAction(10);

    expect(api.put).toHaveBeenNthCalledWith(
      1,
      '/live-control/home/override',
      {
        mode: 'force_live',
        expires_at: '2026-07-26T12:00:00.000Z'
      }
    );
    expect(api.put).toHaveBeenNthCalledWith(
      2,
      '/live-control/home/song-requests',
      { open: false }
    );
    expect(api.post).toHaveBeenCalledWith(
      '/live-control/home/requests/req-1/advance',
      {
        expected_version: 2,
        outcome: 'skipped',
        activate_next: true
      }
    );
    expect(api.put).toHaveBeenCalledWith(
      '/live-control/home/eta',
      { paused: true, expected_revision: 9 }
    );
    expect(api.post).toHaveBeenCalledWith(
      '/live-control/home/undo',
      { expected_revision: 10 }
    );
  });
});
