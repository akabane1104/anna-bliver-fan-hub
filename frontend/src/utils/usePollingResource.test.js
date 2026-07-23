import React, { act, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import usePollingResource from './usePollingResource';

const flush = () => Promise.resolve();

function Harness({ loader, autoRefresh = true }) {
  const stableLoader = useCallback(loader, [loader]);
  const resource = usePollingResource(stableLoader, {
    intervalMs: 5000,
    autoRefresh
  });
  return (
    <div>
      <span>{resource.data?.value || 'empty'}</span>
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

  test('unmount aborts the pending request and clears polling timers', async () => {
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
    expect(jest.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
