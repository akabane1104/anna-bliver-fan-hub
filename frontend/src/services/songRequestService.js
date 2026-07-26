import api from './api';

const songRequestService = {
  async getCenter({ signal } = {}) {
    const response = await api.get('/song-requests/center', { signal });
    return response.data;
  },

  async getMine(params = {}, { signal } = {}) {
    const query = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== '' && value !== undefined && value !== null)
    );
    const response = await api.get('/song-requests/me', { params: query, signal });
    return response.data;
  },

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

  async withdraw(publicId, expectedRevision = null) {
    const response = await api.post(
      `/song-requests/${publicId}/withdraw`,
      expectedRevision === null ? {} : { expected_revision: expectedRevision }
    );
    return response.data;
  },

  async rerequest(publicId, idempotencyKey) {
    const response = await api.post(
      `/song-requests/${publicId}/rerequest`,
      {},
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

  async transitionRequest(publicId, action, expectedVersion, options = {}) {
    const details = typeof options === 'string'
      ? { public_reason: options }
      : (options || {});
    const response = await api.post(
      `/live-control/requests/${publicId}/${action}`,
      {
        expected_version: expectedVersion,
        ...(details.expectedRevision !== undefined
          ? { expected_revision: details.expectedRevision }
          : {}),
        ...(details.reasonCode ? { reason_code: details.reasonCode } : {}),
        ...(details.publicReason ? { public_reason: details.publicReason } : {}),
        ...(details.internalNote ? { internal_note: details.internalNote } : {})
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

  async matchRequest(publicId, expectedVersion, songId, { saveAlias = false } = {}) {
    const response = await api.post(
      `/live-control/requests/${publicId}/match`,
      {
        expected_version: expectedVersion,
        song_id: songId,
        save_alias: Boolean(saveAlias)
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
  },

  async undoLastAction(expectedRevision) {
    const response = await api.post('/live-control/song-requests/undo', {
      expected_revision: expectedRevision
    });
    return response.data;
  },

  async getAdminSettings({ signal } = {}) {
    const response = await api.get('/live-control/song-requests/settings', { signal });
    return response.data;
  },

  async updateAdminSettings(settings) {
    const numeric = (value) => {
      if (value === '' || value === undefined || value === null) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const boolean = (value) => (
      value === undefined || value === null ? undefined : Boolean(value)
    );
    const entries = [
      ['cooldown_minutes', numeric(settings.cooldown_minutes ?? settings.cooldownMinutes)],
      ['block_repeat_today', boolean(
        settings.block_repeat_today ?? settings.blockRepeatToday
      )],
      ['queue_limit', numeric(settings.queue_limit ?? settings.queueLimit)],
      ['reopen_threshold', numeric(settings.reopen_threshold ?? settings.reopenThreshold)],
      ['max_eta_minutes', numeric(settings.max_eta_minutes ?? settings.maxEtaMinutes)],
      ['reopen_eta_minutes', numeric(settings.reopen_eta_minutes ?? settings.reopenEtaMinutes)],
      ['default_song_seconds', numeric(settings.default_song_seconds ?? settings.defaultSongSeconds)],
      ['buffer_seconds', numeric(settings.buffer_seconds ?? settings.bufferSeconds)],
      ['eta_paused', boolean(settings.eta_paused ?? settings.etaPaused)],
      ['active_event_tag_id', numeric(
        settings.active_event_tag_id ?? settings.activeEventTagId
      )],
      ['expected_revision', numeric(
        settings.expected_revision ?? settings.expectedRevision ?? settings.revision
      )]
    ];
    const body = Object.fromEntries(
      entries.filter(([, value]) => value !== undefined && value !== null)
    );
    const response = await api.put('/live-control/song-requests/settings', body);
    return response.data;
  },

  async setEtaPaused(paused, expectedRevision = null) {
    const response = await api.put('/live-control/song-requests/eta', {
      paused: Boolean(paused),
      ...(expectedRevision === null ? {} : { expected_revision: expectedRevision })
    });
    return response.data;
  },

  async setSongPolicy(songId, policy) {
    const has = (key) => Object.prototype.hasOwnProperty.call(policy, key);
    const body = {
      ...(has('blocked') ? { blocked: Boolean(policy.blocked) } : {}),
      ...(has('publicReason') ? { public_reason: policy.publicReason || '' } : {}),
      ...(has('internalNote') ? { internal_note: policy.internalNote || '' } : {}),
      ...(has('expiresAt') ? { expires_at: policy.expiresAt || null } : {}),
      ...(has('specialEventTagId')
        ? { special_event_tag_id: policy.specialEventTagId || null }
        : {}),
      ...(has('durationOverrideSeconds')
        ? { duration_override_seconds: policy.durationOverrideSeconds || null }
        : {}),
      expected_version: Number(policy.expectedVersion || 0)
    };
    const response = await api.put(`/live-control/songs/${songId}/policy`, body);
    return response.data;
  },

  async getSongPolicy(songId, { signal } = {}) {
    const response = await api.get(`/live-control/songs/${songId}/policy`, { signal });
    return response.data;
  },

  async getSongAliases(songId, { signal } = {}) {
    const response = await api.get(`/live-control/songs/${songId}/aliases`, { signal });
    return response.data;
  },

  async addSongAlias(songId, alias) {
    const response = await api.post(`/live-control/songs/${songId}/aliases`, { alias });
    return response.data;
  },

  async deleteSongAlias(aliasId) {
    const response = await api.delete(`/live-control/aliases/${aliasId}`);
    return response.data;
  }
};

export default songRequestService;
