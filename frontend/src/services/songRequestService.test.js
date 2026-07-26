jest.mock('./api', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn()
}));

const api = require('./api');
const songRequestService = require('./songRequestService').default;

describe('song request API service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: { status: 'ok' } });
    api.post.mockResolvedValue({ data: { status: 'accepted' } });
    api.put.mockResolvedValue({ data: { status: 'accepted' } });
  });

  test('uses the public center and authenticated viewer endpoints with cancellation', async () => {
    const controller = new AbortController();
    await songRequestService.getCenter({ signal: controller.signal });
    await songRequestService.getMine(
      { status: 'queued', page: 2, limit: 10 },
      { signal: controller.signal }
    );
    expect(api.get).toHaveBeenNthCalledWith(1, '/song-requests/center', {
      signal: controller.signal
    });
    expect(api.get).toHaveBeenNthCalledWith(2, '/song-requests/me', {
      params: { status: 'queued', page: 2, limit: 10 },
      signal: controller.signal
    });
    await songRequestService.getMine(
      { status: '', page: 1, limit: 10 },
      { signal: controller.signal }
    );
    expect(api.get).toHaveBeenNthCalledWith(3, '/song-requests/me', {
      params: { page: 1, limit: 10 },
      signal: controller.signal
    });
  });

  test('uses public ids only for authenticated withdraw and rerequest actions', async () => {
    await songRequestService.withdraw('request-id', 7);
    await songRequestService.rerequest('request-id', 'website:synthetic-key');
    expect(api.post).toHaveBeenNthCalledWith(
      1,
      '/song-requests/request-id/withdraw',
      { expected_revision: 7 }
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/song-requests/request-id/rerequest',
      {},
      { headers: { 'Idempotency-Key': 'website:synthetic-key' } }
    );
  });

  test('serializes match aliases and canonical transition reasons', async () => {
    await songRequestService.matchRequest('request-id', 3, 42, { saveAlias: true });
    await songRequestService.transitionRequest('request-id', 'reject', 4, {
      reasonCode: 'manual_rejection',
      publicReason: '本场无法演唱',
      internalNote: 'synthetic note',
      expectedRevision: 12
    });
    expect(api.post).toHaveBeenNthCalledWith(
      1,
      '/live-control/requests/request-id/match',
      {
        expected_version: 3,
        song_id: 42,
        save_alias: true
      }
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      '/live-control/requests/request-id/reject',
      {
        expected_version: 4,
        expected_revision: 12,
        reason_code: 'manual_rejection',
        public_reason: '本场无法演唱',
        internal_note: 'synthetic note'
      }
    );
  });

  test('whitelists queue settings and keeps ETA, policy, and undo in the service', async () => {
    await songRequestService.updateAdminSettings({
      queueLimit: 12,
      reopenThreshold: 8,
      maxEtaMinutes: 90,
      reopenEtaMinutes: 60,
      defaultSongSeconds: 240,
      bufferSeconds: 30,
      eta_paused: true,
      revision: 6,
      unrelated: 'must-not-leave-service'
    });
    await songRequestService.setEtaPaused(true, 6);
    await songRequestService.setSongPolicy(42, {
      blocked: true,
      publicReason: '活动限定',
      internalNote: 'synthetic note',
      expiresAt: '2026-07-27T00:00:00.000Z',
      expectedVersion: 0
    });
    await songRequestService.undoLastAction(7);

    expect(api.put).toHaveBeenNthCalledWith(
      1,
      '/live-control/song-requests/settings',
      {
        queue_limit: 12,
        reopen_threshold: 8,
        max_eta_minutes: 90,
        reopen_eta_minutes: 60,
        default_song_seconds: 240,
        buffer_seconds: 30,
        eta_paused: true,
        expected_revision: 6
      }
    );
    expect(api.put).toHaveBeenNthCalledWith(
      2,
      '/live-control/song-requests/eta',
      { paused: true, expected_revision: 6 }
    );
    expect(api.put).toHaveBeenNthCalledWith(
      3,
      '/live-control/songs/42/policy',
      {
        blocked: true,
        public_reason: '活动限定',
        internal_note: 'synthetic note',
        expires_at: '2026-07-27T00:00:00.000Z',
        expected_version: 0
      }
    );
    expect(api.post).toHaveBeenCalledWith(
      '/live-control/song-requests/undo',
      { expected_revision: 7 }
    );
  });
});
