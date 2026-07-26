import api from './api';

const songRequestService = {
  async getCatalog(params = {}) {
    const response = await api.get('/song-requests/catalog', { params });
    return response.data;
  },

  async getCurrentQueue(params = {}) {
    const response = await api.get('/song-requests/current', { params });
    return response.data;
  },

  async create(songId, idempotencyKey) {
    const response = await api.post(
      '/song-requests',
      { song_id: songId },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    );
    return response.data;
  },

  async getActiveSessions() {
    const response = await api.get('/live-control/sessions/active');
    return response.data;
  },

  async getRecoverableSessions({ signal } = {}) {
    const response = await api.get('/live-control/sessions/recoverable', { signal });
    return response.data;
  },

  async getSessionRequests(publicId, { signal } = {}) {
    const response = await api.get(
      `/live-control/sessions/${publicId}/requests`,
      { signal }
    );
    return response.data;
  },

  async createSession(input) {
    const response = await api.post('/live-control/sessions', input);
    return response.data;
  },

  async transitionSession(publicId, action, expectedVersion) {
    const response = await api.post(
      `/live-control/sessions/${publicId}/${action}`,
      { expected_version: expectedVersion }
    );
    return response.data;
  },

  async createManualRequest(input) {
    const response = await api.post('/live-control/requests', input);
    return response.data;
  },

  async transitionRequest(publicId, action, expectedVersion, reason) {
    const response = await api.post(
      `/live-control/requests/${publicId}/${action}`,
      {
        expected_version: expectedVersion,
        ...(reason ? { reason } : {})
      }
    );
    return response.data;
  },

  async setFulfillment(publicId, expectedVersion, fulfillmentType) {
    const response = await api.post(
      `/live-control/requests/${publicId}/fulfillment`,
      {
        expected_version: expectedVersion,
        fulfillment_type: fulfillmentType
      }
    );
    return response.data;
  },

  async matchRequest(publicId, expectedVersion, songId) {
    const response = await api.post(
      `/live-control/requests/${publicId}/match`,
      {
        expected_version: expectedVersion,
        song_id: songId
      }
    );
    return response.data;
  },

  async reorder(sessionPublicId, expectedVersion, requestPublicIds) {
    const response = await api.put(
      `/live-control/sessions/${sessionPublicId}/reorder`,
      {
        expected_version: expectedVersion,
        request_public_ids: requestPublicIds
      }
    );
    return response.data;
  },

  async getHistory(params = {}) {
    const response = await api.get('/live-control/history', { params });
    return response.data;
  }
};

export default songRequestService;
