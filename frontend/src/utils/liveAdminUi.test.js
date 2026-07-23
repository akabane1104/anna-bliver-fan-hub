import {
  formatLiveAdminDate,
  liveAdminErrorMessage,
  localDateTimeToIso,
  statusTone
} from './liveAdminUi';

describe('live admin UI utilities', () => {
  test('formats valid dates without depending on an exact machine timezone', () => {
    const formatted = formatLiveAdminDate('2026-07-23T01:02:03.000Z');
    expect(formatted).not.toBe('暂无');
    expect(formatLiveAdminDate('invalid')).toBe('暂无');
  });

  test('maps stable HTTP errors to safe administrator messages', () => {
    expect(liveAdminErrorMessage({ response: { status: 401 } })).toContain('重新登录');
    expect(liveAdminErrorMessage({ response: { status: 403 } })).toContain('没有直播管理权限');
    expect(liveAdminErrorMessage({ response: { status: 409 } })).toContain('冲突');
    expect(liveAdminErrorMessage({ response: { status: 429 } })).toContain('频繁');
    expect(liveAdminErrorMessage({
      response: { status: 400, data: { code: 'invalid_live_event_query' } }
    })).toContain('筛选条件无效');
    expect(liveAdminErrorMessage(new Error('private stack'), '事件记录')).not.toContain('private');
  });

  test('converts local date input to ISO and classifies semantic tones', () => {
    expect(localDateTimeToIso('')).toBeUndefined();
    expect(localDateTimeToIso('not-a-date')).toBeNull();
    expect(localDateTimeToIso('2026-07-23T09:30')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(statusTone('connected')).toBe('positive');
    expect(statusTone('blocked')).toBe('negative');
    expect(statusTone('partial')).toBe('warning');
    expect(statusTone('unknown')).toBe('neutral');
  });
});
