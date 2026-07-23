import api from './api';

const permissionService = {
  async getPermissionTypes() {
    const response = await api.get('/permissions/types');
    return response.data;
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
  hasPermission(current, key) {
    return current?.role === 'admin' || current?.permissions?.includes(key);
  },
  PERMISSIONS: {
    PLAYLIST_MANAGE: 'playlist.manage',
    MARSHMALLOW_MANAGE: 'marshmallow.manage',
    PRIZE_MANAGE: 'prize.manage',
    POINTS_MANAGE: 'points.manage',
    SITE_CONFIG_MANAGE: 'site_config.manage',
    LIVE_CONTROL_MANAGE: 'live_control.manage'
  }
};

export default permissionService;
