import api from './api';

const liveHomeService = {
  async getHome({ signal } = {}) {
    const response = await api.get('/live-home', { signal });
    return response.data;
  }
};

export default liveHomeService;
