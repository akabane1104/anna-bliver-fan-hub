import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

jest.mock('../../services', () => ({
  authService: {
    getCurrentUser: jest.fn()
  },
  permissionService: {
    getViewerIdentityUsers: jest.fn(),
    getViewerIdentityAudit: jest.fn(),
    resyncViewerIdentity: jest.fn(),
    setViewerIdentityFallback: jest.fn(),
    revokeViewerIdentityFallback: jest.fn()
  }
}));

const { authService, permissionService } = jest.requireMock('../../services');
const ViewerIdentityManagement = require('./ViewerIdentityManagement').default;

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('ViewerIdentityManagement', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    authService.getCurrentUser.mockReturnValue({ role: 'streamer' });
    permissionService.getViewerIdentityUsers.mockResolvedValue([
      {
        id: 1,
        username: '普通观众',
        role: 'captain',
        protected_role: false,
        bindings: [{
          bilibili_uid: '10001',
          fans_medal_name: '测试勋章',
          fans_medal_level: 23,
          guard_role: 'captain',
          identity_sync_status: 'failed',
          last_sync_success_at: '2026-07-27T00:00:00.000Z',
          manual_role: null
        }]
      },
      {
        id: 2,
        username: '主播账号',
        role: 'streamer',
        protected_role: true,
        bindings: [{
          bilibili_uid: '10002',
          guard_role: 'governor',
          identity_sync_status: 'failed',
          manual_role: null
        }]
      },
      {
        id: 3,
        username: '自动用户',
        role: 'governor',
        protected_role: false,
        bindings: [{
          bilibili_uid: '10003',
          guard_role: 'governor',
          identity_sync_status: 'success',
          manual_role: null
        }]
      }
    ]);
    permissionService.getViewerIdentityAudit.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = false;
  });

  test('shows simplified sync states and keeps protected roles read-only', async () => {
    await act(async () => {
      root.render(<ViewerIdentityManagement />);
      await flush();
    });
    expect(container.textContent).toContain('同步失败');
    expect(container.textContent).toContain('自动识别');
    expect(container.textContent).toContain('主播和管理员身份受保护');
    expect(container.textContent).not.toContain('自動同步');
    expect(container.textContent).not.toContain('同步失敗');

    const protectedCard = [...container.querySelectorAll('.viewer-identity-user')]
      .find((card) => card.textContent.includes('主播账号'));
    expect(protectedCard.textContent).not.toContain('人工补录');
    expect(protectedCard.textContent).not.toContain('重新同步');
  });

  test('allows fallback only when automatic classification is unavailable', async () => {
    await act(async () => {
      root.render(<ViewerIdentityManagement />);
      await flush();
    });
    const cards = [...container.querySelectorAll('.viewer-identity-user')];
    expect(cards[0].textContent).toContain('人工补录');
    expect(cards[2].textContent).not.toContain('人工补录');
  });

  test('manual guard fallback exposes an expiry field and uses stable role keys', async () => {
    await act(async () => {
      root.render(<ViewerIdentityManagement />);
      await flush();
    });
    const fallbackButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '人工补录');
    await act(async () => {
      fallbackButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const select = container.querySelector('.viewer-identity-modal select');
    await act(async () => {
      select.value = 'captain';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect([...select.options].map((option) => option.value)).toEqual([
      'fan_club',
      'captain',
      'admiral',
      'governor'
    ]);
    expect(container.querySelector('input[type="datetime-local"]')).not.toBeNull();
  });
});
