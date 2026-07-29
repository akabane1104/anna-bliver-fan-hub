import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

jest.mock('../services', () => ({
  authService: {
    isAuthenticated: jest.fn(),
    getCurrentUser: jest.fn(),
    getProfile: jest.fn(),
    setCurrentUser: jest.fn(),
    logout: jest.fn()
  },
  permissionService: {
    getMyPermissions: jest.fn(),
    PERMISSIONS: {
      LIVE_CONTROL_MANAGE: 'live_control.manage'
    }
  }
}));

jest.mock('../context/SiteSettingsContext', () => ({
  useSiteSettings: () => ({
    siteSettings: {
      siteTitle: 'Synthetic Site',
      navbarBrandMode: 'text',
      navbarBrandText: 'Synthetic Site'
    }
  })
}));

jest.mock('./BrandMark', () => () => <span>Synthetic Site</span>);

const {
  authService: mockAuthService,
  permissionService: mockPermissionService
} = jest.requireMock('../services');
const Navbar = require('./Navbar').default;
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('Navbar live administration menu', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockAuthService.getCurrentUser.mockReturnValue({ role: 'fan_club', points: 0 });
    mockAuthService.getProfile.mockResolvedValue({ role: 'fan_club', points: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderNavbar() {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Navbar />
        </MemoryRouter>
      );
      await flush();
      await flush();
    });
  }

  test('unauthorized users never see the live administration links', async () => {
    mockPermissionService.getMyPermissions.mockResolvedValue({ permissions: [] });
    await renderNavbar();
    expect(container.querySelector('a[href="/song-requests"]')?.textContent).toBe('点歌中心');
    expect(container.textContent).not.toContain('直播管理');
    expect(container.querySelector('a[href="/admin/live-events"]')).toBeNull();
    expect(container.querySelector('a[href="/admin/live-control"]')).toBeNull();
  });

  test('permission loading does not briefly reveal the menu', async () => {
    mockPermissionService.getMyPermissions.mockReturnValue(new Promise(() => {}));
    await renderNavbar();
    expect(container.textContent).not.toContain('直播管理');
  });

  test('admin or explicit permission sees the live console and existing tools', async () => {
    mockPermissionService.getMyPermissions.mockResolvedValue({
      permissions: ['live_control.manage']
    });
    await renderNavbar();
    expect(container.textContent).toContain('直播管理');
    expect(container.querySelector('a[href="/admin/live-control"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/live-status"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/live-events"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/song-requests"]')).not.toBeNull();
  });
});
