import api from './api';

const liveAdminService = {
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
