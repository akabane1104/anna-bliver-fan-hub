import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

jest.mock('../services', () => ({
  authService: {
    isAuthenticated: jest.fn(),
    getCurrentUser: jest.fn()
  },
  permissionService: {
    getMyPermissions: jest.fn()
  }
}));

const {
  authService: mockAuthService,
  permissionService: mockPermissionService
} = jest.requireMock('../services');
const ProtectedRoute = require('./ProtectedRoute').default;

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('live control route authorization', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'user' });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderRoute() {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/admin/song-requests']}>
          <Routes>
            <Route path="/" element={<div>public-home</div>} />
            <Route path="/admin/song-requests" element={(
              <ProtectedRoute requiredPermissions={['live_control.manage']}>
                <div>private-song-control</div>
              </ProtectedRoute>
            )} />
          </Routes>
        </MemoryRouter>
      );
      await flush();
    });
  }

  test('redirects an unauthorized direct URL to the public home', async () => {
    mockPermissionService.getMyPermissions.mockResolvedValue({ permissions: [] });
    await renderRoute();
    expect(container.textContent).toContain('public-home');
    expect(container.textContent).not.toContain('private-song-control');
  });

  test('allows an explicitly permitted user', async () => {
    mockPermissionService.getMyPermissions.mockResolvedValue({
      permissions: ['live_control.manage']
    });
    await renderRoute();
    expect(container.textContent).toContain('private-song-control');
  });
});
