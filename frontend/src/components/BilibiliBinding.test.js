import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import BilibiliBinding from './BilibiliBinding';

const statusResponse = {
  bound: true,
  binding_limit: 5,
  role: 'captain',
  bindings: [{
    bilibili_uid: '10001',
    bilibili_uname: '测试用户',
    bilibili_face: '',
    is_primary: true,
    fans_medal_name: '测试勋章',
    fans_medal_level: 21,
    fans_medal_status: 'active',
    guard_role: 'captain',
    identity_sync_status: 'failed',
    last_sync_success_at: '2026-07-27T00:00:00.000Z'
  }]
};

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

describe('BilibiliBinding identity status', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('token', 'synthetic-test-token');
    global.fetch = jest.fn(async (url, options = {}) => {
      if (url === '/api/bilibili-binding/status') {
        return { ok: true, json: async () => statusResponse };
      }
      if (
        url === '/api/bilibili-binding/10001/sync'
        && options.method === 'POST'
      ) {
        return {
          ok: true,
          json: async () => ({ status: 'unavailable' })
        };
      }
      throw new Error(`unexpected request: ${options.method || 'GET'} ${url}`);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    delete global.fetch;
    global.IS_REACT_ACT_ENVIRONMENT = false;
  });

  test('shows per-UID medal, guard, website role and resync status in Simplified Chinese', async () => {
    await act(async () => {
      root.render(<BilibiliBinding />);
      await flush();
    });

    expect(container.textContent).toContain('当前网站角色：舰长');
    expect(container.textContent).toContain('测试勋章 · 21 级 · 有效');
    expect(container.textContent).toContain('当前大航海：舰长');
    expect(container.textContent).toContain('同步状态：同步失败');
    expect(container.textContent).not.toMatch(/粉絲團|艦長|總督|管理員|同步失敗/);

    const resyncButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重新同步');
    await act(async () => {
      resyncButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/bilibili-binding/10001/sync',
      expect.objectContaining({ method: 'POST' })
    );
    expect(container.textContent).toContain('身份数据源暂时不可用，已保留上次确认结果');
  });
});
