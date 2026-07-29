import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

jest.mock('../../services', () => ({
  authService: {
    getCurrentUser: jest.fn(() => ({ role: 'admin' }))
  },
  permissionService: {
    getAllUsers: jest.fn(),
    getPermissionTypes: jest.fn(),
    updateUserPermissions: jest.fn(),
    getViewerIdentityUsers: jest.fn()
  },
  settingsService: {
    getRegistrationStatus: jest.fn(),
    updateRegistrationStatus: jest.fn()
  }
}));
jest.mock('../../components/BackButton', () => () => null);

const {
  authService,
  permissionService,
  settingsService
} = jest.requireMock('../../services');
const PermissionManagement = require('./PermissionManagement').default;

const roles = [
  ['fan_club', '粉丝团'],
  ['captain', '舰长'],
  ['admiral', '提督'],
  ['governor', '总督'],
  ['streamer', '主播'],
  ['admin', '管理员']
];

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('PermissionManagement roles', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    authService.getCurrentUser.mockReturnValue({ role: 'admin' });
    permissionService.getAllUsers.mockResolvedValue(
      roles.map(([role, label], index) => ({
        id: index + 1,
        username: `测试用户${index + 1}`,
        email: `role-${index + 1}@example.test`,
        role,
        role_label: label,
        permissions: role === 'streamer' || role === 'admin'
          ? ['live_control.manage']
          : [],
        assigned_permissions: [],
        role_permissions: role === 'streamer' || role === 'admin'
          ? ['live_control.manage']
          : []
      }))
    );
    permissionService.getPermissionTypes.mockResolvedValue([
      { key: 'live_control.manage', name: '点歌控制' }
    ]);
    permissionService.getViewerIdentityUsers.mockResolvedValue([]);
    settingsService.getRegistrationStatus.mockResolvedValue({
      registrationOpen: true
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = false;
  });

  test('list and role filter display all six simplified role names', async () => {
    await act(async () => {
      root.render(<PermissionManagement />);
      await flush();
    });

    expect(
      [...container.querySelectorAll('.role-badge')].map((node) => node.textContent)
    ).toEqual(roles.map(([, label]) => label));
    expect(
      [...container.querySelectorAll('select[aria-label="按角色筛选"] option')]
        .map((option) => option.textContent)
    ).toEqual(['全部角色', ...roles.map(([, label]) => label)]);
    expect(container.textContent).not.toContain('普通用户');
    expect(container.textContent).not.toContain('协作者');
  });

  test('editor uses stable role keys and shows role-inherited permissions', async () => {
    await act(async () => {
      root.render(<PermissionManagement />);
      await flush();
    });
    await act(async () => {
      container.querySelectorAll('.edit-btn')[4].dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });

    expect(
      [...container.querySelectorAll('input[name="role"]')].map((input) => input.value)
    ).toEqual(roles.map(([key]) => key));
    const permission = container.querySelector('.permission-item input');
    expect(permission.checked).toBe(true);
    expect(permission.disabled).toBe(true);
    expect(container.textContent).toContain('由当前角色自动授予');
  });
});
