import React, { act, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import usePollingResource from './usePollingResource';

const flush = () => Promise.resolve();

function Harness({
  loader,
  autoRefresh = true,
  intervalMs = 5000,
  staleAfterMs = null
}) {
  const stableLoader = useCallback(loader, [loader]);
  const resource = usePollingResource(stableLoader, {
    intervalMs,
    autoRefresh,
    staleAfterMs
  });
  return (
    <div>
      <span>{resource.data?.value || 'empty'}</span>
      <span>{resource.stale ? 'stale' : 'fresh'}</span>
      <button type="button" onClick={resource.refresh}>refresh</button>
    </div>
  );
}

describe('usePollingResource', () => {
  let container;
  let root;
  let originalVisibility;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalVisibility) {
      Object.defineProperty(document, 'visibilityState', originalVisibility);
    }
  });

  test('polling never overlaps an in-flight request', async () => {
    let resolveFirst;
    const loader = jest.fn(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    await act(async () => {
      root.render(<Harness loader={loader} />);
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(10000);
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst({ value: 'ready' });
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('ready');
  });

  test('hidden pages pause polling and visible pages refresh immediately', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 'ready' });
    await act(async () => {
      root.render(<Harness loader={loader} />);
      await flush();
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      jest.advanceTimersByTime(10000);
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('unmount aborts the pending request', async () => {
    let capturedSignal;
    const loader = jest.fn(({ signal }) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });
    await act(async () => {
      root.render(<Harness loader={loader} />);
      await flush();
    });
    act(() => root.unmount());
    expect(capturedSignal.aborted).toBe(true);
    root = createRoot(container);
  });

  test('unmount clears the scheduled polling timer', async () => {
    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
    const loader = jest.fn().mockResolvedValue({ value: 'ready' });

    await act(async () => {
      root.render(<Harness loader={loader} />);
      await flush();
      await flush();
    });

    const pollingTimer = setTimeoutSpy.mock.calls
      .map((call, index) => ({
        delay: call[1],
        id: setTimeoutSpy.mock.results[index].value
      }))
      .findLast(({ delay }) => delay === 5000);

    expect(pollingTimer).toBeDefined();
    act(() => root.unmount());
    expect(clearTimeoutSpy).toHaveBeenCalledWith(pollingTimer.id);
    root = createRoot(container);
  });

  test('uses the latest backend-provided polling interval', async () => {
    const loader = jest.fn()
      .mockResolvedValueOnce({ value: 'offline', refresh_after_ms: 30000 })
      .mockResolvedValue({ value: 'live', refresh_after_ms: 5000 });
    const interval = (data) => data?.refresh_after_ms || 30000;
    await act(async () => {
      root.render(<Harness loader={loader} intervalMs={interval} />);
      await flush();
      await flush();
    });

    await act(async () => {
      jest.advanceTimersByTime(29999);
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await flush();
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await flush();
      await flush();
    });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  test('keeps the last success during a brief failure and marks it stale later', async () => {
    const loader = jest.fn()
      .mockResolvedValueOnce({ value: 'last-known' })
      .mockRejectedValue(new Error('offline'));
    await act(async () => {
      root.render(
        <Harness
          loader={loader}
          intervalMs={5000}
          staleAfterMs={6000}
        />
      );
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('last-known');
    expect(container.textContent).toContain('fresh');

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('last-known');
    expect(container.textContent).toContain('fresh');

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await flush();
      await flush();
    });
    expect(container.textContent).toContain('last-known');
    expect(container.textContent).toContain('stale');
  });
});
