import api from './api';

export const authService = {
  async sendVerificationCode(email, username, captchaVerifyParam) {
    const response = await api.post('/auth/send-code', { email, username, captchaVerifyParam });
    return response.data;
  },

  async register(username, email, password, verificationCode, captchaVerifyParam) {
    const response = await api.post('/auth/register', {
      username,
      email,
      password,
      verificationCode,
      captchaVerifyParam
    });
    return response.data;
  },

  async login(email, password, captchaVerifyParam) {
    const response = await api.post('/auth/login', { email, password, captchaVerifyParam });
    if (response.data.token) {
      localStorage.setItem('token', response.data.token);
      this.setCurrentUser(response.data.user);
    }
    return response.data;
  },

  async getProfile() {
    const response = await api.get('/auth/profile');
    return response.data;
  },

  async getAllUsers(page = 1, limit = 10, search = '') {
    const response = await api.get('/auth/users', {
      params: { page, limit, search }
    });
    return response.data;
  },

  async updateUserRole(userId, role) {
    const response = await api.put(`/auth/users/${userId}/role`, { role });
    return response.data;
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.dispatchEvent(new Event('auth:userUpdated'));
  },

  getCurrentUser() {
    const userStr = localStorage.getItem('user');
    return userStr ? JSON.parse(userStr) : null;
  },

  setCurrentUser(user) {
    if (user) {
      localStorage.setItem('user', JSON.stringify(user));
    } else {
      localStorage.removeItem('user');
    }
    window.dispatchEvent(new Event('auth:userUpdated'));
  },

  isAuthenticated() {
    return !!localStorage.getItem('token');
  }
};

export const settingsService = {
  async getRegistrationStatus() {
    const response = await api.get('/settings/registration');
    return response.data;
  },

  async updateRegistrationStatus(isOpen) {
    const response = await api.put('/settings/registration', { isOpen });
    return response.data;
  },

  async getCaptchaConfig() {
    const response = await api.get('/settings/captcha');
    return response.data;
  },

  async getSiteConfig() {
    const response = await api.get('/settings/site');
    return response.data;
  },

  async updateSiteConfig(config) {
    const response = await api.put('/settings/site', config);
    return response.data;
  },

  async uploadNavbarLogo(dataUrl) {
    const response = await api.post('/settings/site/logo', { dataUrl });
    return response.data;
  }
};

export const playlistService = {
  async getAllSongs() {
    const response = await api.get('/playlists/songs');
    return response.data;
  },

  async getAllPlaylists() {
    const response = await api.get('/playlists');
    return response.data;
  },

  async getPlaylistById(id) {
    const response = await api.get(`/playlists/${id}`);
    return response.data;
  },

  async addSong(songData) {
    const response = await api.post('/playlists/songs', songData);
    return response.data;
  },

  async batchAddSongs(songs) {
    const response = await api.post('/playlists/songs/batch', { songs });
    return response.data;
  },

  async updateSong(songId, songData) {
    const response = await api.put(`/playlists/songs/${songId}`, songData);
    return response.data;
  },

  async deleteSong(songId) {
    const response = await api.delete(`/playlists/songs/${songId}`);
    return response.data;
  },

  async getAllTags() {
    const response = await api.get('/playlists/tags');
    return response.data;
  },

  async createTag(tagData) {
    const response = await api.post('/playlists/tags', tagData);
    return response.data;
  },

  async updateTag(id, tagData) {
    const response = await api.put(`/playlists/tags/${id}`, tagData);
    return response.data;
  },

  async deleteTag(id) {
    const response = await api.delete(`/playlists/tags/${id}`);
    return response.data;
  }
};

export const prizeService = {
  async getAllPrizes() {
    const response = await api.get('/prizes');
    return response.data.data || response.data;
  },

  async getPrizeById(id) {
    const response = await api.get(`/prizes/${id}`);
    return response.data.data || response.data;
  },

  async redeemPrize(prizeId, options = 'points') {
    const payload = typeof options === 'string'
      ? { prizeId, currency_type: options }
      : {
          prizeId,
          currency_type: options.currencyType || options.currency_type || 'points',
          prize_option_id: options.prizeOptionId || options.prize_option_id || null,
          quantity: options.quantity || 1,
          address_id: options.addressId || options.address_id || null,
          remark: options.remark || ''
        };
    const response = await api.post('/prizes/redeem', payload);
    return response.data.data || response.data;
  },

  async getCart() {
    const response = await api.get('/prizes/cart');
    return response.data.data || response.data;
  },

  async addCartItem(data) {
    const response = await api.post('/prizes/cart/items', data);
    return response.data.data || response.data;
  },

  async updateCartItem(id, data) {
    const response = await api.put(`/prizes/cart/items/${id}`, data);
    return response.data.data || response.data;
  },

  async deleteCartItem(id) {
    const response = await api.delete(`/prizes/cart/items/${id}`);
    return response.data.data || response.data;
  },

  async clearCart() {
    const response = await api.delete('/prizes/cart');
    return response.data.data || response.data;
  },

  async checkoutCart(data = {}) {
    const response = await api.post('/prizes/cart/checkout', data);
    return response.data.data || response.data;
  },

  async getShippingAddresses() {
    const response = await api.get('/prizes/shipping-addresses');
    return response.data.data || response.data;
  },

  async createShippingAddress(data) {
    const response = await api.post('/prizes/shipping-addresses', data);
    return response.data.data || response.data;
  },

  async updateShippingAddress(id, data) {
    const response = await api.put(`/prizes/shipping-addresses/${id}`, data);
    return response.data.data || response.data;
  },

  async deleteShippingAddress(id) {
    const response = await api.delete(`/prizes/shipping-addresses/${id}`);
    return response.data;
  },

  async setDefaultShippingAddress(id) {
    const response = await api.put(`/prizes/shipping-addresses/${id}/default`);
    return response.data;
  },

  async getUserRedemptions() {
    const response = await api.get('/prizes/user/redemptions');
    return response.data.data || response.data;
  },

  async getUserOrders() {
    const response = await api.get('/prizes/user/orders');
    return response.data.data || response.data;
  },

  async getUserOrder(id) {
    const response = await api.get(`/prizes/user/orders/${id}`);
    return response.data.data || response.data;
  },

  async getAdminItems() {
    const response = await api.get('/prizes/admin/items');
    return response.data;
  },

  async createAdminItem(data) {
    const response = await api.post('/prizes/admin/items', data);
    return response.data;
  },

  async updateAdminItem(id, data) {
    const response = await api.put(`/prizes/admin/items/${id}`, data);
    return response.data;
  },

  async updateAdminItemOrder(itemIds) {
    const response = await api.put('/prizes/admin/items/order', { item_ids: itemIds });
    return response.data;
  },

  async deleteAdminItem(id) {
    const response = await api.delete(`/prizes/admin/items/${id}`);
    return response.data;
  },

  async uploadPrizeImages(id, images) {
    const response = await api.post(`/prizes/admin/items/${id}/images`, { images });
    return response.data;
  },

  async updatePrizeImageOrder(id, imageIds) {
    const response = await api.put(`/prizes/admin/items/${id}/images/order`, { image_ids: imageIds });
    return response.data;
  },

  async deletePrizeImage(id, imageId) {
    const response = await api.delete(`/prizes/admin/items/${id}/images/${imageId}`);
    return response.data;
  },

  async getAdminRedemptions(params = {}) {
    const response = await api.get('/prizes/admin/redemptions', { params });
    return response.data;
  },

  async updateRedemptionStatus(id, status, reason = '') {
    const response = await api.put(`/prizes/admin/redemptions/${id}/status`, { status, reason });
    return response.data;
  },

  async getAdminOrders(params = {}) {
    const response = await api.get('/prizes/admin/orders', { params });
    return response.data;
  },

  async getAdminOrder(id) {
    const response = await api.get(`/prizes/admin/orders/${id}`);
    return response.data;
  },

  async updateOrderStatus(id, status, reason = '') {
    const response = await api.put(`/prizes/admin/orders/${id}/status`, { status, reason });
    return response.data;
  }
};

export const marshmallowService = {
  async createMarshmallow(data) {
    const response = await api.post('/marshmallows', data);
    return response.data;
  },

  async getMyMarshmallows() {
    const response = await api.get('/marshmallows/my');
    return response.data;
  },

  async bindMarshmallow(marshmallowId) {
    const response = await api.post('/marshmallows/bind', { marshmallowId });
    return response.data;
  },

  async getAllMarshmallows() {
    const response = await api.get('/marshmallows/admin');
    return response.data;
  },

  async replyMarshmallow(id, replyContent) {
    const response = await api.put(`/marshmallows/${id}/reply`, { reply_content: replyContent });
    return response.data;
  },

  async markAsRead(id) {
    const response = await api.post(`/marshmallows/${id}/read`);
    return response.data;
  },

  async deleteMarshmallows(ids) {
    const response = await api.post('/marshmallows/delete', { ids });
    return response.data;
  }
};

export const bilibiliService = {
  async getInfo() {
    // 直接从后端获取，后端已实现缓存
    const response = await api.get('/bilibili/info');
    return response.data;
  }
};

export const bilibiliBindingService = {
  async getBindingStatus() {
    const response = await api.get('/bilibili-binding/status');
    return response.data;
  }
};

export { default as permissionService } from './permissionService';
export { default as pointsService } from './pointsService';
export { default as songRequestService } from './songRequestService';
export { default as liveAdminService } from './liveAdminService';
export { default as liveHomeService } from './liveHomeService';
