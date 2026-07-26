import { useCallback, useEffect, useRef, useState } from 'react';

export default function usePollingResource(loader, {
  intervalMs = 5000,
  autoRefresh = true,
  staleAfterMs = null
} = {}) {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
    lastSuccessAt: null,
    stale: false
  });
  const executeRef = useRef(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer = null;
    let controller = null;
    let latestData = null;
    let lastSuccessAtMs = null;

    const clearScheduled = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const resolveInterval = () => {
      const configured = typeof intervalMs === 'function'
        ? intervalMs(latestData)
        : intervalMs;
      const numeric = Number(configured);
      return Number.isFinite(numeric) && numeric >= 1000
        ? Math.min(numeric, 300000)
        : 5000;
    };

    const schedule = () => {
      clearScheduled();
      if (
        !active ||
        !autoRefresh ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      timer = window.setTimeout(() => {
        execute('poll');
      }, resolveInterval());
    };

    const execute = async () => {
      if (!active || inFlight) return false;
      clearScheduled();
      inFlight = true;
      controller = new AbortController();
      setState((current) => ({
        ...current,
        error: null,
        loading: current.data === null,
        refreshing: current.data !== null
      }));
      try {
        const data = await loader({ signal: controller.signal });
        if (!active) return false;
        latestData = data;
        lastSuccessAtMs = Date.now();
        setState({
          data,
          error: null,
          loading: false,
          refreshing: false,
          lastSuccessAt: new Date(lastSuccessAtMs).toISOString(),
          stale: false
        });
        return true;
      } catch (error) {
        if (!active || error?.name === 'CanceledError' || error?.name === 'AbortError') {
          return false;
        }
        setState((current) => ({
          ...current,
          error,
          loading: false,
          refreshing: false,
          stale: (
            Number.isFinite(staleAfterMs) &&
            staleAfterMs >= 0 &&
            lastSuccessAtMs !== null &&
            Date.now() - lastSuccessAtMs >= staleAfterMs
          )
        }));
        return false;
      } finally {
        inFlight = false;
        controller = null;
        schedule();
      }
    };

    const handleVisibility = () => {
      clearScheduled();
      if (document.visibilityState === 'visible' && autoRefresh) {
        execute('visibility');
      }
    };

    executeRef.current = execute;
    document.addEventListener('visibilitychange', handleVisibility);
    execute('initial');

    return () => {
      active = false;
      executeRef.current = null;
      clearScheduled();
      controller?.abort();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [autoRefresh, intervalMs, loader, staleAfterMs]);

  const refresh = useCallback(() => executeRef.current?.('manual'), []);

  return {
    ...state,
    refresh
  };
}
