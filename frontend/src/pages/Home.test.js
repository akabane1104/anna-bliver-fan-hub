import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

jest.mock('../utils/usePollingResource');
jest.mock('../services', () => ({
  authService: {
    getCurrentUser: jest.fn(() => null),
    isAuthenticated: jest.fn(() => false)
  },
  bilibiliService: {
    getInfo: jest.fn()
  },
  liveHomeService: {
    getHome: jest.fn()
  },
  permissionService: {
    getMyPermissions: jest.fn(),
    PERMISSIONS: {
      SITE_CONFIG_MANAGE: 'site_config.manage',
      POINTS_MANAGE: 'points.manage',
      PRIZE_MANAGE: 'prize.manage',
      MARSHMALLOW_MANAGE: 'marshmallow.manage',
      LIVE_CONTROL_MANAGE: 'live_control.manage'
    }
  }
}));
jest.mock('../context/SiteSettingsContext', () => ({
  useSiteSettings: () => ({
    siteSettings: {
      bilibiliUid: '',
      homeTitle: '安娜的粉丝站',
      homeSubtitle: '原本的首页内容',
      playlistCardTitle: '网页歌单',
      playlistCardDescription: '浏览歌单',
      marshmallowCardTitle: '棉花糖',
      marshmallowCardDescription: '匿名留言'
    }
  })
}));

const usePollingResource = require('../utils/usePollingResource').default;
const Home = require('./Home').default;

describe('Home live mode', () => {
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

  function render() {
    act(() => root.render(<MemoryRouter><Home /></MemoryRouter>));
  }

  test('offline and initial failures preserve the existing homepage', () => {
    usePollingResource.mockReturnValue({
      data: { mode: 'offline' },
      stale: false
    });
    render();
    expect(container.textContent).toContain('安娜的粉丝站');
    expect(container.textContent).toContain('原本的首页内容');
    expect(container.querySelector('.live-home-card')).toBeNull();
  });

  test('live and syncing data render above the existing homepage', () => {
    usePollingResource.mockReturnValue({
      data: {
        mode: 'syncing',
        status_label: '重新同步中',
        song_requests: {
          open: true,
          queue_count: 1,
          current: { title: '保留的当前歌曲', artist: '歌手' },
          next: null
        },
        recent_support: []
      },
      stale: false
    });
    render();
    const card = container.querySelector('.live-home-card');
    const intro = container.querySelector('.home-intro');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('保留的当前歌曲');
    expect(card.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('安娜的粉丝站');
  });

  test('long-stale data safely returns to the ordinary homepage', () => {
    usePollingResource.mockReturnValue({
      data: {
        mode: 'live',
        song_requests: { open: true, queue_count: 0 },
        recent_support: []
      },
      stale: true
    });
    render();
    expect(container.querySelector('.live-home-card')).toBeNull();
    expect(container.textContent).toContain('网页歌单');
  });
});
