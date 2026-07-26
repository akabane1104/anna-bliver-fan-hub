import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useObsOverlayState, {
  CONNECTED_RECONCILE_MS,
  DISCONNECTED_POLL_MS
} from './useObsOverlayState';

class FakeEventSource {
  constructor() {
    this.listeners = new Map();
    this.closed = false;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  emit(name, value = {}) {
    this.listeners.get(name)?.(value);
  }

  close() {
    this.closed = true;
  }
}

describe('useObsOverlayState', () => {
  let container;
  let root;

  beforeEach(() => {
    jest.useFakeTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  test('uses SSE snapshots, polls while disconnected, reconciles while connected, and cleans up', async () => {
    const source = new FakeEventSource();
    const service = {
      getState: jest.fn().mockResolvedValue({
        revision: 1,
        todayRequestCount: 1
      }),
      createEventSource: jest.fn(() => source)
    };

    function Harness() {
      const result = useObsOverlayState({ service });
      return (
        <output>
          {result.connected ? 'connected' : 'disconnected'}:
          {result.state?.todayRequestCount ?? 'none'}
        </output>
      );
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(service.getState).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('disconnected:1');

    await act(async () => {
      jest.advanceTimersByTime(DISCONNECTED_POLL_MS);
      await Promise.resolve();
    });
    expect(service.getState).toHaveBeenCalledTimes(2);

    act(() => source.emit('open'));
    act(() => source.emit('snapshot', {
      data: JSON.stringify({ revision: 2, todayRequestCount: 4 })
    }));
    expect(container.textContent).toContain('connected:4');

    await act(async () => {
      jest.advanceTimersByTime(CONNECTED_RECONCILE_MS);
      await Promise.resolve();
    });
    expect(service.getState).toHaveBeenCalledTimes(3);

    act(() => root.unmount());
    expect(source.closed).toBe(true);
    root = createRoot(container);
  });
});
