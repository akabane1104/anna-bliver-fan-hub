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

function TestRoutes({ path }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>public-home</div>} />
        <Route path="/login" element={<div>login-page</div>} />
        <Route
          path={path}
          element={(
            <ProtectedRoute requiredPermissions={['live_control.manage']}>
              <div>private-live-admin</div>
            </ProtectedRoute>
          )}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('live administration route guards', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(path) {
    await act(async () => {
      root.render(<TestRoutes path={path} />);
      await flush();
    });
  }

  test('unauthenticated direct URLs go to login', async () => {
    mockAuthService.isAuthenticated.mockReturnValue(false);
    mockAuthService.getCurrentUser.mockReturnValue(null);
    await render('/admin/live-status');
    expect(container.textContent).toContain('login-page');
    expect(container.textContent).not.toContain('private-live-admin');
  });

  test('the live console direct URL uses the same permission boundary', async () => {
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'user' });
    mockPermissionService.getMyPermissions.mockResolvedValue({
      permissions: ['live_control.manage']
    });
    await render('/admin/live-control');
    expect(container.textContent).toContain('private-live-admin');
  });

  test('permission loading never reveals admin content', async () => {
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'user' });
    mockPermissionService.getMyPermissions.mockReturnValue(new Promise(() => {}));
    await render('/admin/live-events');
    expect(container.textContent).toContain('加载中');
    expect(container.textContent).not.toContain('private-live-admin');
  });

  test('unauthorized users are blocked from both routes', async () => {
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'user' });
    mockPermissionService.getMyPermissions.mockResolvedValue({ permissions: [] });
    await render('/admin/live-status');
    expect(container.textContent).toContain('public-home');
    act(() => root.unmount());
    root = createRoot(container);
    await render('/admin/live-events');
    expect(container.textContent).toContain('public-home');
  });

  test('admin and live_control.manage can enter', async () => {
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'admin' });
    await render('/admin/live-status');
    expect(container.textContent).toContain('private-live-admin');

    act(() => root.unmount());
    root = createRoot(container);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'user' });
    mockPermissionService.getMyPermissions.mockResolvedValue({
      permissions: ['live_control.manage']
    });
    await render('/admin/live-events');
    expect(container.textContent).toContain('private-live-admin');
  });
});
