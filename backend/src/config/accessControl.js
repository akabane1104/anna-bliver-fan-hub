const PERMISSIONS = Object.freeze({
  PLAYLIST_MANAGE: 'playlist.manage',
  MARSHMALLOW_MANAGE: 'marshmallow.manage',
  PRIZE_MANAGE: 'prize.manage',
  POINTS_MANAGE: 'points.manage',
  SITE_CONFIG_MANAGE: 'site_config.manage',
  LIVE_CONTROL_MANAGE: 'live_control.manage',
  VIEWER_IDENTITY_MANAGE: 'viewer_identity.manage'
});

const ROLES = Object.freeze({
  FAN_CLUB: 'fan_club',
  CAPTAIN: 'captain',
  ADMIRAL: 'admiral',
  GOVERNOR: 'governor',
  STREAMER: 'streamer',
  ADMIN: 'admin'
});

const ROLE_ORDER = Object.freeze([
  ROLES.FAN_CLUB,
  ROLES.CAPTAIN,
  ROLES.ADMIRAL,
  ROLES.GOVERNOR,
  ROLES.STREAMER,
  ROLES.ADMIN
]);

const ROLE_LABELS = Object.freeze({
  [ROLES.FAN_CLUB]: '粉丝团',
  [ROLES.CAPTAIN]: '舰长',
  [ROLES.ADMIRAL]: '提督',
  [ROLES.GOVERNOR]: '总督',
  [ROLES.STREAMER]: '主播',
  [ROLES.ADMIN]: '管理员'
});

const VIEWER_ROLES = Object.freeze([
  ROLES.FAN_CLUB,
  ROLES.CAPTAIN,
  ROLES.ADMIRAL,
  ROLES.GOVERNOR
]);

const VIEWER_PERMISSIONS = Object.freeze([]);
const STREAMER_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.FAN_CLUB]: VIEWER_PERMISSIONS,
  [ROLES.CAPTAIN]: VIEWER_PERMISSIONS,
  [ROLES.ADMIRAL]: VIEWER_PERMISSIONS,
  [ROLES.GOVERNOR]: VIEWER_PERMISSIONS,
  [ROLES.STREAMER]: STREAMER_PERMISSIONS,
  [ROLES.ADMIN]: STREAMER_PERMISSIONS
});

function isValidRole(role) {
  return ROLE_ORDER.includes(role);
}

function isAdminRole(role) {
  return role === ROLES.ADMIN;
}

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || VIEWER_PERMISSIONS;
}

function effectivePermissions(role, assignedPermissions = []) {
  return [...new Set([
    ...permissionsForRole(role),
    ...assignedPermissions.filter((key) => Object.values(PERMISSIONS).includes(key))
  ])].sort();
}

function roleHasPermission(role, permission) {
  return isAdminRole(role) || permissionsForRole(role).includes(permission);
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  ROLE_ORDER,
  ROLE_PERMISSIONS,
  STREAMER_PERMISSIONS,
  VIEWER_PERMISSIONS,
  VIEWER_ROLES,
  effectivePermissions,
  isAdminRole,
  isValidRole,
  permissionsForRole,
  roleHasPermission
};
