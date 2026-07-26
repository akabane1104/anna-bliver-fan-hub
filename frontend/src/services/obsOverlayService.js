import api from './api';

function publicQuery() {
  const params = new URLSearchParams(window.location.search);
  const maxItems = params.get('maxItems');
  return maxItems ? { maxItems } : {};
}

function streamUrl() {
  const base = String(api.defaults.baseURL || '/api').replace(/\/+$/, '');
  const query = new URLSearchParams(publicQuery()).toString();
  return `${base}/public/obs-overlay/stream${query ? `?${query}` : ''}`;
}

const obsOverlayService = {
  async getState() {
    const response = await api.get('/public/obs-overlay/state', {
      params: publicQuery()
    });
    return response.data;
  },

  createEvent(event) {
    return api.post('/live-control/obs-overlay/events', event)
      .then((response) => response.data);
  },

  listEvents(limit = 30) {
    return api.get('/live-control/obs-overlay/events', { params: { limit } })
      .then((response) => response.data);
  },

  dismissEvent(publicId) {
    return api.delete(`/live-control/obs-overlay/events/${publicId}`);
  },

  createEventSource() {
    return new EventSource(streamUrl());
  }
};

export { streamUrl };
export default obsOverlayService;
