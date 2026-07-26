import {
  createIdempotencyKey,
  createRequestCoordinator,
  formatEtaRange,
  getRequestDisplayTitle,
  isReorderable,
  normalizeQueueItem,
  normalizeRequestStatus,
  normalizeSongRequestCenter,
  requestErrorMessage,
  splitCurrentQueue
} from './songRequestUi';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe('song request UI helpers', () => {
  test('splits active, next, and waiting requests with stable numeric order', () => {
    const result = splitCurrentQueue({
      requests: [
        { public_id: 'later', status: 'queued', queue_order: '9' },
        { public_id: 'active', status: 'active', queue_order: null },
        { public_id: 'next', status: 'needs_match', queue_order: '2' },
        { public_id: 'done', status: 'completed', queue_order: null }
      ]
    });
    expect(result.active.public_id).toBe('active');
    expect(result.next.public_id).toBe('next');
    expect(result.waiting.map(({ public_id }) => public_id)).toEqual(['next', 'later']);
    expect(result.waitingCount).toBe(2);
  });

  test('empty queue has no current or next song', () => {
    expect(splitCurrentQueue(null)).toEqual({
      active: null,
      next: null,
      waiting: [],
      waitingCount: 0
    });
  });

  test('display title prefers the server matched song without changing text', () => {
    expect(getRequestDisplayTitle({
      requested_title: '年輪',
      matched_song: { title: '年轮' }
    })).toBe('年轮');
    expect(getRequestDisplayTitle({ requested_title: '年輪' })).toBe('年輪');
  });

  test('idempotency keys are valid and differ between deliberate actions', () => {
    const first = createIdempotencyKey();
    const second = createIdempotencyKey();
    expect(first).toMatch(/^[A-Za-z0-9._:/-]{8,128}$/);
    expect(second).toMatch(/^[A-Za-z0-9._:/-]{8,128}$/);
    expect(first).not.toBe(second);
  });

  test.each([
    [401, undefined, '请先登录后再点歌。'],
    [403, undefined, '当前账号没有执行此操作的权限。'],
    [409, 'no_open_session', '当前还没有开放点歌，请稍后再来。'],
    [409, 'version_conflict', '队列刚刚发生变化，已为你重新加载。'],
    [429, undefined, '操作太频繁了，请稍后再试。'],
    [503, undefined, '服务暂时不可用，请稍后重试。']
  ])('maps HTTP %s to a safe user-facing message', (status, code, message) => {
    expect(requestErrorMessage({
      response: { status, data: { code, message: 'raw backend exception' } }
    })).toBe(message);
  });

  test('network errors never expose a raw exception', () => {
    const message = requestErrorMessage(new Error('socket secret leaked'));
    expect(message).toBe('服务暂时不可用，请稍后重试。');
    expect(message).not.toMatch(/secret|socket/);
  });

  test('only needs_match and queued requests can be reordered', () => {
    expect(isReorderable({ status: 'needs_match' })).toBe(true);
    expect(isReorderable({ status: 'queued' })).toBe(true);
    expect(isReorderable({ status: 'active' })).toBe(false);
    expect(isReorderable({ status: 'completed' })).toBe(false);
  });

  test('normalizes canonical statuses and ETA ranges', () => {
    expect(normalizeRequestStatus('observed')).toBe('pending_review');
    expect(normalizeRequestStatus('active')).toBe('singing');
    expect(normalizeRequestStatus('cancelled')).toBe('withdrawn');
    expect(formatEtaRange({ min_minutes: 4, max_minutes: 7 })).toBe('约 4–7 分钟');
    expect(formatEtaRange({ paused: true })).toBe('时间估算已暂停');
  });

  test('public queue normalization drops raw ids and unmasked requester names', () => {
    const item = normalizeQueueItem({
      public_id: 'private-id',
      user_id: 42,
      requester_display_name: 'Raw Name',
      display_key: 'safe-key',
      position: 3,
      canonical_song: { title: '年轮' },
      masked_display_name: 'R***e',
      status: 'queued',
      is_mine: true
    });
    expect(item).toEqual({
      displayKey: 'safe-key',
      position: 3,
      canonicalSong: { title: '年轮' },
      maskedDisplayName: 'R***e',
      eta: null,
      status: 'queued',
      isMine: true
    });
    expect(item).not.toHaveProperty('public_id');
    expect(item).not.toHaveProperty('user_id');
    expect(normalizeSongRequestCenter(null).queue).toEqual([]);
  });

  test('newer success wins when an older success arrives later', async () => {
    const coordinator = createRequestCoordinator();
    const older = deferred();
    const newer = deferred();
    const state = { data: null, error: '', loading: true };
    const olderToken = coordinator.begin('history');
    const olderTask = older.promise.then((value) => {
      if (coordinator.isCurrent(olderToken)) state.data = value;
    }).finally(() => {
      if (coordinator.isCurrent(olderToken)) state.loading = false;
    });
    const newerToken = coordinator.begin('history');
    const newerTask = newer.promise.then((value) => {
      if (coordinator.isCurrent(newerToken)) state.data = value;
    }).finally(() => {
      if (coordinator.isCurrent(newerToken)) state.loading = false;
    });

    newer.resolve('newer');
    await newerTask;
    older.resolve('older');
    await olderTask;
    expect(state).toEqual({ data: 'newer', error: '', loading: false });
  });

  test('stale errors and successes cannot replace the latest request outcome', async () => {
    const successCoordinator = createRequestCoordinator();
    const staleFailure = deferred();
    const latestSuccess = deferred();
    const successState = { data: null, error: '' };
    const staleFailureToken = successCoordinator.begin('history');
    const staleFailureTask = staleFailure.promise.catch(() => {
      if (successCoordinator.isCurrent(staleFailureToken)) successState.error = 'stale-error';
    });
    const latestSuccessToken = successCoordinator.begin('history');
    const latestSuccessTask = latestSuccess.promise.then((value) => {
      if (successCoordinator.isCurrent(latestSuccessToken)) {
        successState.data = value;
        successState.error = '';
      }
    });
    latestSuccess.resolve('latest-success');
    await latestSuccessTask;
    staleFailure.reject(new Error('synthetic stale failure'));
    await staleFailureTask;
    expect(successState).toEqual({ data: 'latest-success', error: '' });

    const failureCoordinator = createRequestCoordinator();
    const staleSuccess = deferred();
    const latestFailure = deferred();
    const failureState = { data: 'confirmed', error: '' };
    const staleSuccessToken = failureCoordinator.begin('queue');
    const staleSuccessTask = staleSuccess.promise.then((value) => {
      if (failureCoordinator.isCurrent(staleSuccessToken)) {
        failureState.data = value;
        failureState.error = '';
      }
    });
    const latestFailureToken = failureCoordinator.begin('queue');
    const latestFailureTask = latestFailure.promise.catch(() => {
      if (failureCoordinator.isCurrent(latestFailureToken)) {
        failureState.error = 'latest-error';
      }
    });
    latestFailure.reject(new Error('synthetic latest failure'));
    await latestFailureTask;
    staleSuccess.resolve('stale-success');
    await staleSuccessTask;
    expect(failureState).toEqual({ data: 'confirmed', error: 'latest-error' });
  });

  test('mutation invalidation and unmount block late recovery commits', async () => {
    const coordinator = createRequestCoordinator();
    const recovery = deferred();
    const state = { session: null, writes: 0 };
    const recoveryToken = coordinator.begin('sessions');
    const recoveryTask = recovery.promise.then((session) => {
      if (coordinator.isCurrent(recoveryToken)) {
        state.session = session;
        state.writes += 1;
      }
    });

    coordinator.invalidateAll();
    const mutationToken = coordinator.begin('mutation:session');
    if (coordinator.isCurrent(mutationToken)) {
      state.session = 'newer-mutation';
      state.writes += 1;
    }
    recovery.resolve('stale-draft');
    await recoveryTask;
    expect(state).toEqual({ session: 'newer-mutation', writes: 1 });

    const afterUnmount = deferred();
    const unmountToken = coordinator.begin('queue');
    const unmountTask = afterUnmount.promise.then(() => {
      if (coordinator.isCurrent(unmountToken)) state.writes += 1;
    });
    coordinator.dispose();
    afterUnmount.resolve('late-response');
    await unmountTask;
    expect(state.writes).toBe(1);
  });
});
