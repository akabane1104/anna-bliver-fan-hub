const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const {
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  ROLE_ORDER,
  STREAMER_PERMISSIONS,
  VIEWER_ROLES,
  effectivePermissions,
  isValidRole,
  permissionsForRole,
  roleHasPermission
} = require('../src/config/accessControl');
const {
  hasPermission,
  requireAdmin
} = require('../src/middleware/permissions');

test('six roles have stable keys, labels, and display order', () => {
  assert.deepEqual(ROLE_ORDER, [
    'fan_club',
    'captain',
    'admiral',
    'governor',
    'streamer',
    'admin'
  ]);
  assert.equal(new Set(ROLE_ORDER).size, 6);
  assert.deepEqual(
    ROLE_ORDER.map((role) => ROLE_LABELS[role]),
    ['粉丝团', '舰长', '提督', '总督', '主播', '管理员']
  );
  assert.ok(ROLE_ORDER.every(isValidRole));
  assert.equal(isValidRole('user'), false);
  assert.equal(isValidRole('premium'), false);
});

test('four viewer roles share one base capability set without rank inheritance', () => {
  assert.deepEqual(VIEWER_ROLES, [
    ROLES.FAN_CLUB,
    ROLES.CAPTAIN,
    ROLES.ADMIRAL,
    ROLES.GOVERNOR
  ]);
  const shared = permissionsForRole(ROLES.FAN_CLUB);
  for (const role of VIEWER_ROLES) {
    assert.equal(permissionsForRole(role), shared);
    assert.deepEqual(permissionsForRole(role), []);
    assert.equal(roleHasPermission(role, PERMISSIONS.LIVE_CONTROL_MANAGE), false);
  }
  assert.equal(roleHasPermission(ROLES.GOVERNOR, PERMISSIONS.SITE_CONFIG_MANAGE), false);
});

test('streamer receives every existing daily operations capability', () => {
  assert.deepEqual(
    [...STREAMER_PERMISSIONS].sort(),
    Object.values(PERMISSIONS).sort()
  );
  for (const permission of Object.values(PERMISSIONS)) {
    assert.equal(roleHasPermission(ROLES.STREAMER, permission), true);
    assert.equal(roleHasPermission(ROLES.ADMIN, permission), true);
  }
});

test('effective permissions merge role capabilities with valid user grants', () => {
  assert.deepEqual(
    effectivePermissions(ROLES.FAN_CLUB, [
      PERMISSIONS.PLAYLIST_MANAGE,
      'unknown.permission',
      PERMISSIONS.PLAYLIST_MANAGE
    ]),
    [PERMISSIONS.PLAYLIST_MANAGE]
  );
  assert.deepEqual(
    effectivePermissions(ROLES.STREAMER, [PERMISSIONS.PLAYLIST_MANAGE]),
    [...STREAMER_PERMISSIONS].sort()
  );
});

test('permission middleware grants streamer operations and blocks viewers', async (t) => {
  const originalQuery = db.query;
  t.after(() => {
    db.query = originalQuery;
  });

  for (const permission of Object.values(PERMISSIONS)) {
    db.query = async (sql) => {
      if (sql.includes('SELECT role FROM users')) return [[{ role: ROLES.STREAMER }]];
      throw new Error(`unexpected query: ${sql}`);
    };
    assert.equal(await hasPermission(42, permission), true);
  }

  for (const role of VIEWER_ROLES) {
    db.query = async (sql) => {
      if (sql.includes('SELECT role FROM users')) return [[{ role }]];
      if (sql.includes('SELECT id FROM permissions')) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    };
    assert.equal(await hasPermission(42, PERMISSIONS.LIVE_CONTROL_MANAGE), false);
  }
});

test('admin-only middleware rejects streamer direct API calls with 403', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let nextCalled = false;
  requireAdmin(
    { userRole: ROLES.STREAMER },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { message: '仅管理员可以执行此操作' });
});

test('role and permission management routes enforce the admin boundary', () => {
  const root = path.resolve(__dirname, '..');
  const authRoutes = fs.readFileSync(path.join(root, 'src/routes/auth.js'), 'utf8');
  const permissionRoutes = fs.readFileSync(
    path.join(root, 'src/routes/permissions.js'),
    'utf8'
  );
  const settingsRoutes = fs.readFileSync(path.join(root, 'src/routes/settings.js'), 'utf8');

  assert.match(authRoutes, /router\.put\('\/users\/:id\/role', authMiddleware, requireAdmin,/);
  assert.match(permissionRoutes, /router\.get\('\/types', requireAdmin,/);
  assert.match(permissionRoutes, /router\.put\('\/users\/:userId', requireAdmin,/);
  assert.match(permissionRoutes, /router\.get\('\/users', requireAdmin,/);
  assert.match(settingsRoutes, /router\.put\('\/registration', authMiddleware, requireAdmin,/);
});

test('fresh registrations use fan_club and authorization reloads the database role', () => {
  const root = path.resolve(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'src/config/schema.sql'), 'utf8');
  const authController = fs.readFileSync(
    path.join(root, 'src/controllers/authController.js'),
    'utf8'
  );
  const authMiddleware = fs.readFileSync(
    path.join(root, 'src/middleware/auth.js'),
    'utf8'
  );

  assert.match(
    schema,
    /role ENUM\('fan_club','captain','admiral','governor','streamer','admin'\) NOT NULL DEFAULT 'fan_club'/
  );
  assert.match(
    authController,
    /INSERT INTO users \(username, email, password\) VALUES \(\?, \?, \?\)/
  );
  assert.match(authMiddleware, /SELECT role FROM users WHERE id = \?/);
  assert.match(authMiddleware, /req\.userRole = users\[0\]\.role/);
});
