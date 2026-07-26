import api from './api';

const liveAdminService = {
  async getHome({ signal } = {}) {
    const response = await api.get('/live-control/home', { signal });
    return response.data;
  },

  async setOverride(mode, expiresAt = null) {
    const response = await api.put('/live-control/home/override', {
      mode,
      expires_at: expiresAt
    });
    return response.data;
  },

  async setSongRequestsOpen(open) {
    const response = await api.put('/live-control/home/song-requests', { open });
    return response.data;
  },

  async setActivity(activity) {
    const response = await api.put('/live-control/home/activity', activity);
    return response.data;
  },

  async advanceCurrent(publicId, input) {
    const response = await api.post(
      `/live-control/home/requests/${publicId}/advance`,
      input
    );
    return response.data;
  },

  async getStatus({ signal } = {}) {
    const response = await api.get('/live-control/status', { signal });
    return response.data;
  },

  async getEvents(params = {}, { signal } = {}) {
    const response = await api.get('/live-control/events', { params, signal });
    return response.data;
  }
};

export default liveAdminService;
