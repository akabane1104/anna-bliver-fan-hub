import {
  ROLE_DEFINITIONS,
  ROLE_LABELS,
  ROLES,
  isAdminRole,
  roleLabel
} from './roles';

test('six roles keep stable keys, simplified labels, and display order', () => {
  expect(ROLE_DEFINITIONS).toEqual([
    { key: 'fan_club', label: '粉丝团' },
    { key: 'captain', label: '舰长' },
    { key: 'admiral', label: '提督' },
    { key: 'governor', label: '总督' },
    { key: 'streamer', label: '主播' },
    { key: 'admin', label: '管理员' }
  ]);
  expect(new Set(ROLE_DEFINITIONS.map(({ key }) => key)).size).toBe(6);
  expect(ROLE_LABELS[ROLES.GOVERNOR]).toBe('总督');
  expect(roleLabel(ROLES.CAPTAIN)).toBe('舰长');
  expect(isAdminRole(ROLES.STREAMER)).toBe(false);
  expect(isAdminRole(ROLES.ADMIN)).toBe(true);
});
