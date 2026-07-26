import { useCallback, useEffect, useRef, useState } from 'react';
import obsOverlayService from '../services/obsOverlayService';

const DISCONNECTED_POLL_MS = 2500;
const CONNECTED_RECONCILE_MS = 30000;

function useObsOverlayState({ service = obsOverlayService } = {}) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const connectedRef = useRef(false);
  const requestPending = useRef(false);

  const refresh = useCallback(async () => {
    if (requestPending.current) return;
    requestPending.current = true;
    try {
      setState(await service.getState());
      setError(null);
    } catch {
      setError('overlay_state_unavailable');
    } finally {
      requestPending.current = false;
    }
  }, [service]);

  useEffect(() => {
    let source;
    let disposed = false;

    const updateConnected = (value) => {
      connectedRef.current = value;
      if (!disposed) setConnected(value);
    };

    void refresh();
    try {
      source = service.createEventSource();
      source.addEventListener('open', () => updateConnected(true));
      source.addEventListener('snapshot', (event) => {
        try {
          const nextState = JSON.parse(event.data);
          if (!disposed) {
            setState(nextState);
            setError(null);
            updateConnected(true);
          }
        } catch {
          if (!disposed) setError('overlay_snapshot_invalid');
        }
      });
      source.addEventListener('unavailable', () => {
        if (!disposed) setError('overlay_state_unavailable');
      });
      source.addEventListener('error', () => updateConnected(false));
    } catch {
      updateConnected(false);
    }

    const pollTimer = window.setInterval(() => {
      if (!connectedRef.current) void refresh();
    }, DISCONNECTED_POLL_MS);
    const reconcileTimer = window.setInterval(() => {
      if (connectedRef.current) void refresh();
    }, CONNECTED_RECONCILE_MS);

    return () => {
      disposed = true;
      connectedRef.current = false;
      window.clearInterval(pollTimer);
      window.clearInterval(reconcileTimer);
      source?.close();
    };
  }, [refresh, service]);

  return { state, connected, error, refresh };
}

export {
  CONNECTED_RECONCILE_MS,
  DISCONNECTED_POLL_MS
};
export default useObsOverlayState;
