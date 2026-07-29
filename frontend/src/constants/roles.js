export const ROLES = Object.freeze({
  FAN_CLUB: 'fan_club',
  CAPTAIN: 'captain',
  ADMIRAL: 'admiral',
  GOVERNOR: 'governor',
  STREAMER: 'streamer',
  ADMIN: 'admin'
});

export const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({ key: ROLES.FAN_CLUB, label: '粉丝团' }),
  Object.freeze({ key: ROLES.CAPTAIN, label: '舰长' }),
  Object.freeze({ key: ROLES.ADMIRAL, label: '提督' }),
  Object.freeze({ key: ROLES.GOVERNOR, label: '总督' }),
  Object.freeze({ key: ROLES.STREAMER, label: '主播' }),
  Object.freeze({ key: ROLES.ADMIN, label: '管理员' })
]);

export const ROLE_LABELS = Object.freeze(Object.fromEntries(
  ROLE_DEFINITIONS.map(({ key, label }) => [key, label])
));

export const roleLabel = (role) => ROLE_LABELS[role] || role || '-';
export const isAdminRole = (role) => role === ROLES.ADMIN;
