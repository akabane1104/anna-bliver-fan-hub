import api from './api';
import { isAdminRole } from '../constants/roles';

const permissionService = {
  async getPermissionTypes() {
    const response = await api.get('/permissions/types');
    return response.data.permissions || response.data;
  },
  async getMyPermissions() {
    const response = await api.get('/permissions/my');
    return response.data;
  },
  async getAllUsers() {
    const response = await api.get('/permissions/users');
    return response.data;
  },
  async getUserPermissions(userId) {
    const response = await api.get(`/permissions/users/${userId}`);
    return response.data;
  },
  async updateUserPermissions(userId, permissions, role) {
    const response = await api.put(`/permissions/users/${userId}`, { permissions, role });
    return response.data;
  },
  async getViewerIdentityUsers() {
    const response = await api.get('/viewer-identities/users');
    return response.data;
  },
  async getViewerIdentityAudit(userId) {
    const response = await api.get(`/viewer-identities/users/${userId}/audit`);
    return response.data;
  },
  async resyncViewerIdentity(userId, bilibiliUid) {
    const response = await api.post(
      `/viewer-identities/users/${userId}/bindings/${bilibiliUid}/sync`
    );
    return response.data;
  },
  async setViewerIdentityFallback(userId, bilibiliUid, fallback) {
    const response = await api.put(
      `/viewer-identities/users/${userId}/bindings/${bilibiliUid}/fallback`,
      fallback
    );
    return response.data;
  },
  async revokeViewerIdentityFallback(userId, bilibiliUid) {
    const response = await api.delete(
      `/viewer-identities/users/${userId}/bindings/${bilibiliUid}/fallback`
    );
    return response.data;
  },
  hasPermission(current, key) {
    return isAdminRole(current?.role) || current?.permissions?.includes(key);
  },
  PERMISSIONS: {
    PLAYLIST_MANAGE: 'playlist.manage',
    MARSHMALLOW_MANAGE: 'marshmallow.manage',
    PRIZE_MANAGE: 'prize.manage',
    POINTS_MANAGE: 'points.manage',
    SITE_CONFIG_MANAGE: 'site_config.manage',
    LIVE_CONTROL_MANAGE: 'live_control.manage',
    VIEWER_IDENTITY_MANAGE: 'viewer_identity.manage'
  }
};

export default permissionService;
