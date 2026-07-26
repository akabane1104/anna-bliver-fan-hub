const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const settings = require('../src/controllers/settingsController').__test__;

test('site config resolves database over environment over defaults', () => {
  const resolved = settings.resolveConfig(
    [{ setting_key: 'site_title', setting_value: 'Database title' }],
    { SITE_TITLE: 'Environment title', BILIBILI_UID: '12345' }
  );
  assert.equal(resolved.siteTitle, 'Database title');
  assert.equal(resolved.bilibiliUid, '12345');
  assert.equal(resolved.navbarLogoUrl, '/annapiggy-logo.png');
  assert.equal(resolved.navbarBrandMode, 'image');
  assert.equal(resolved.navbarBrandText, '小猪anna的秘密基地');
});

test('site config validates UID, colors and remote assets', () => {
  assert.equal(settings.normalizeValue('bilibiliUid', '12345'), '12345');
  assert.throws(() => settings.normalizeValue('bilibiliUid', 'uid-1'));
  assert.throws(() => settings.normalizeValue('primaryColor', '#1234'));
  assert.throws(() => settings.normalizeValue('navbarLogoUrl', 'http://example.test/logo.png'));
  assert.equal(settings.normalizeValue('navbarBrandMode', 'icon-text'), 'icon-text');
  assert.throws(() => settings.normalizeValue('navbarBrandMode', 'logo-and-text'));
  assert.throws(() => settings.normalizeValue('navbarBrandText', '字'.repeat(61)));
});

test('navbar logo upload accepts verified image data and rejects spoofed or oversized payloads', () => {
  const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const decoded = settings.decodeBrandingImage(`data:image/png;base64,${pngBytes.toString('base64')}`);
  assert.equal(decoded.extension, 'png');
  assert.deepEqual(decoded.buffer, pngBytes);

  const jpegBytes = Buffer.from('ffd8ff0000000000', 'hex');
  assert.throws(() => settings.decodeBrandingImage(`data:image/png;base64,${jpegBytes.toString('base64')}`));

  const oversized = Buffer.alloc(settings.MAX_BRANDING_IMAGE_BYTES + 1);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(oversized);
  assert.throws(() => settings.decodeBrandingImage(`data:image/png;base64,${oversized.toString('base64')}`));
});

test('admin navbar logo upload writes a served branding asset', async () => {
  const controller = require('../src/controllers/settingsController');
  const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let statusCode = 200;
  let payload;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return body;
    }
  };

  await controller.uploadNavbarLogo({
    userRole: 'admin',
    body: { dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}` }
  }, response);

  assert.equal(statusCode, 201);
  assert.match(payload.url, /^\/uploads\/branding\/[0-9]+-[0-9a-f-]+\.png$/);
  const storedPath = path.join(root, 'backend', 'uploads', 'branding', path.basename(payload.url));
  try {
    assert.deepEqual(fs.readFileSync(storedPath), pngBytes);
  } finally {
    fs.rmSync(storedPath, { force: true });
  }
});

test('navbar branding supports image, text and icon-text modes with an admin upload endpoint', () => {
  const navbar = read('frontend', 'src', 'components', 'Navbar.js');
  const brandMark = read('frontend', 'src', 'components', 'BrandMark.js');
  const siteConfig = read('frontend', 'src', 'pages', 'SiteConfig', 'SiteConfig.js');
  const appCss = read('frontend', 'src', 'styles', 'App.css');
  const siteConfigCss = read('frontend', 'src', 'pages', 'SiteConfig', 'SiteConfig.css');
  const routes = read('backend', 'src', 'routes', 'settings.js');
  const server = read('backend', 'src', 'server.js');

  assert.match(navbar, /<BrandMark settings=\{siteSettings\}/);
  for (const mode of ["'image'", "'text'", "'icon-text'"]) assert.equal(siteConfig.includes(mode), true);
  assert.match(siteConfig, /type="file"/);
  assert.match(siteConfig, /image\/png,image\/jpeg,image\/webp/);
  assert.match(brandMark, /onError=\{\(\) => setImageFailed\(true\)\}/);
  for (const selector of ['site-brand-image--image', 'site-brand-image--icon', 'site-brand-text']) {
    assert.equal(appCss.includes(`.${selector}`), true, `navbar CSS is missing ${selector}`);
  }
  for (const selector of ['site-config-brand-mode-grid', 'site-config-logo-upload', 'site-config-brand-preview']) {
    assert.equal(siteConfigCss.includes(`.${selector}`), true, `site config CSS is missing ${selector}`);
  }
  assert.match(routes, /router\.post\('\/site\/logo', authMiddleware, requirePermission\(PERMISSIONS\.SITE_CONFIG_MANAGE\), asyncHandler\(settingsController\.uploadNavbarLogo\)\)/);
  assert.match(server, /app\.use\('\/uploads\/branding', express\.static/);
});

test('theme presets start with the original anna_site palette and stay light-layout compatible', () => {
  const themeSource = read('frontend', 'src', 'constants', 'siteTheme.js');
  const contextSource = read('frontend', 'src', 'context', 'SiteSettingsContext.js');
  const expectedOriginal = {
    primaryColor: '#9b59b6',
    lightColor: '#b19cd9',
    darkColor: '#7d3c98',
    backgroundColor: '#f5f7fa',
    backgroundAccentColor: '#f0e6f6',
    textDarkColor: '#2c3e50',
    textLightColor: '#7f8c8d'
  };

  assert.match(themeSource, /key: 'anna-classic'[\s\S]*?name: '原站经典'/);
  for (const presetKey of ['sakura-cream', 'sea-salt-mint', 'blueberry-sky', 'caramel-apricot']) {
    assert.equal(themeSource.includes(`key: '${presetKey}'`), true, `theme presets are missing ${presetKey}`);
  }
  assert.equal((themeSource.match(/key: '/g) || []).length, 5);
  for (const [field, value] of Object.entries(expectedOriginal)) {
    assert.equal(settings.SITE_FIELDS[field][2], value, `backend default differs for ${field}`);
    assert.match(themeSource, new RegExp(`${field}: '${value.replace('#', '\\#')}'`));
  }
  assert.match(contextSource, /linear-gradient\(135deg, \$\{siteSettings\.backgroundColor\} 0%, \$\{siteSettings\.backgroundAccentColor\} 100%\)/);
  for (const removedPreset of ['crimson-nocturne', 'rose-reliquary', 'moonlit-violet', 'black-garnet']) {
    assert.equal(themeSource.includes(removedPreset), false);
  }
});

test('administration pages share the active site theme instead of fixed legacy colors', () => {
  const app = read('frontend', 'src', 'App.js');
  const context = read('frontend', 'src', 'context', 'SiteSettingsContext.js');
  const adminTheme = read('frontend', 'src', 'styles', 'AdminTheme.css');
  const marshmallowAdmin = read('frontend', 'src', 'pages', 'MarshmallowAdmin.js');
  const siteConfigCss = read('frontend', 'src', 'pages', 'SiteConfig', 'SiteConfig.css');

  assert.ok(app.indexOf("import './styles/App.css'") < app.indexOf("import './styles/AdminTheme.css'"));
  for (const rootSelector of [
    '.admin-prizes',
    '.admin-points',
    '.admin-prize-orders',
    '.permission-management',
    '.marshmallow-admin-page'
  ]) {
    assert.equal(adminTheme.includes(rootSelector), true, `shared admin theme is missing ${rootSelector}`);
  }
  for (const token of [
    '--theme-card-surface',
    '--theme-input-surface',
    '--theme-border-soft',
    '--theme-primary-soft',
    '--theme-success-surface',
    '--theme-warning-surface',
    '--theme-danger-surface',
    '--theme-overlay',
    '--theme-modal-shadow'
  ]) {
    assert.equal(adminTheme.includes(`var(${token})`), true, `shared admin theme does not consume ${token}`);
  }
  for (const dynamicToken of [
    '--theme-primary-soft',
    '--theme-success-surface',
    '--theme-warning-surface',
    '--theme-danger-surface',
    '--theme-modal-shadow'
  ]) {
    assert.equal(context.includes(`setProperty('${dynamicToken}'`), true, `theme context does not update ${dynamicToken}`);
  }
  assert.doesNotMatch(marshmallowAdmin, /background: '#e74c3c'|5px solid #(?:27ae60|e74c3c)/);
  assert.doesNotMatch(siteConfigCss, /rgba\(216, 199, 207/);
});

test('profile cards and status colors follow the active site theme', () => {
  const profile = read('frontend', 'src', 'pages', 'Profile.js');
  const profileCss = read('frontend', 'src', 'pages', 'Profile.css');

  assert.match(profile, /className="container profile-page"/);
  for (const token of [
    '--theme-card-surface',
    '--theme-card-surface-alt',
    '--theme-input-surface',
    '--theme-border-soft',
    '--theme-primary-soft',
    '--theme-success-surface',
    '--theme-warning-surface',
    '--theme-danger-surface',
    '--theme-focus-ring'
  ]) {
    assert.equal(profileCss.includes(`var(${token})`), true, `profile CSS does not consume ${token}`);
  }
  assert.doesNotMatch(profileCss, /#[0-9a-f]{3,8}|rgba?\(/i);
});

test('footer keeps an opaque protected slot without a plaintext fallback', () => {
  const source = read('frontend', 'src', 'components', 'Footer.js');
  const entry = read('frontend', 'src', 'index.js');
  const policy = read('frontend', 'src', 'utils', 'obsRoutePolicy.js');
  assert.match(source, /<x-r7-slot/);
  assert.match(source, /data-ui-slot="r7-4f1c"/);
  assert.match(source, /data-bilibili-uid=\{siteSettings\.bilibiliUid \|\| ''\}/);
  assert.doesNotMatch(source, /© 2026|Linus_Lieu|github\.com\/LinusLieu|annapiggy-logo\.png/);
  assert.doesNotMatch(source, /site-footer-fallback/);
  assert.match(entry, /requestIdleCallback/);
  assert.match(entry, /appendRuntimeAsset\(runtimeAssets\.continuity, 'r8', true\)/);
  assert.match(entry, /if \(isObsOutputPath\(window\.location\.pathname\)\) return/);
  assert.match(policy, /pathname === '\/obs' \|\| pathname\.startsWith\('\/obs\/'\)/);
  assert.doesNotMatch(entry, /© 2026|Linus_Lieu|github\.com\/LinusLieu|annapiggy-logo\.png/);
});

test('footer renders configured filing records without empty placeholders', () => {
  const source = read('frontend', 'src', 'components', 'Footer.js');
  const styles = read('frontend', 'src', 'styles', 'App.css');

  assert.match(source, /siteSettings\.icpText\?\.trim\(\)/);
  assert.match(source, /siteSettings\.publicSecurityText\?\.trim\(\)/);
  assert.match(source, /\{\(icpText \|\| publicSecurityText\) && \(/);
  assert.match(source, /https:\/\/beian\.miit\.gov\.cn\//);
  assert.match(source, /https:\/\/beian\.mps\.gov\.cn\//);
  assert.match(styles, /\.site-footer-records\s*\{/);
  assert.doesNotMatch(source, /未填写.*备案/);
});

test('QR binding isolates sessions and never returns or stores login secrets', () => {
  const source = read('backend', 'src', 'controllers', 'bilibiliBindingController.js');
  assert.match(source, /session\.userId !== req\.userId/);
  assert.match(source, /MAX_BINDINGS_PER_USER/);
  assert.doesNotMatch(source, /res\.(?:json|send)\([^)]*(?:cookie|refreshToken)/is);
  assert.doesNotMatch(source, /INSERT INTO[^;]*(?:cookie|refresh_token)/is);
});

test('point ingestion is idempotent, filtered and configuration driven', () => {
  const service = read('backend', 'src', 'services', 'pointsService.js');
  const schema = read('backend', 'src', 'config', 'schema.sql');
  const bridge = read('backend', 'src', 'services', 'botEventBridge.js');
  assert.match(schema, /source_event_id VARCHAR\(255\) NOT NULL UNIQUE/);
  assert.match(service, /POINTS_ROOM_ID/);
  assert.match(service, /POINTS_START_AT/);
  assert.match(service, /POINTS_COIN_PER_POINT/);
  assert.match(service, /INSERT IGNORE INTO bilibili_point_events/);
  assert.match(service, /ORDER BY event_at, id FOR UPDATE/);
  assert.match(service, /eventTimestamp = event\.timestamp \|\| event\.event_at/);
  assert.match(bridge, /MAX_EVENT_PAYLOAD_BYTES = 64 \* 1024/);
  assert.match(bridge, /type: 'resume'/);
  assert.match(bridge, /type: 'event_ack'/);
});

test('cart mutations do not charge and checkout is atomic', () => {
  const source = read('backend', 'src', 'controllers', 'prizeController.js');
  const addStart = source.indexOf('const addCartItem');
  const checkoutStart = source.indexOf('const checkoutCart');
  const addSection = source.slice(addStart, source.indexOf('const updateCartItem', addStart));
  const checkoutSection = source.slice(checkoutStart, source.indexOf('const getUserRedemptions', checkoutStart));
  assert.doesNotMatch(addSection, /recordRedemption|UPDATE point_wallets|stock = stock -/);
  assert.match(checkoutSection, /beginTransaction/);
  assert.match(checkoutSection, /createRedemptionLine/);
  assert.match(checkoutSection, /DELETE FROM prize_cart_items WHERE user_id = \?/);
  assert.ok(checkoutSection.indexOf('createRedemptionLine') < checkoutSection.indexOf('DELETE FROM prize_cart_items'));
  assert.match(checkoutSection, /commit/);
  assert.match(checkoutSection, /rollback/);
});

test('refunds are protected from repeated balance and stock restoration', () => {
  const prize = read('backend', 'src', 'controllers', 'prizeController.js');
  const points = read('backend', 'src', 'services', 'pointsService.js');
  assert.match(prize, /if \(order\.refunded_at\) return false/);
  assert.match(points, /if \(existing\.length\) return \{ duplicate: true \}/);
  assert.match(points, /unique_source_reference/);
});

test('public schema and routes exclude removed operational modules and currencies', () => {
  const schema = read('backend', 'src', 'config', 'schema.sql');
  const server = read('backend', 'src', 'server.js');
  const store = read('frontend', 'src', 'pages', 'PrizesWithCart.js');
  for (const forbidden of ['movie_ticket', 'blindbox', 'gift_screenshot', 'activation_codes', 'room_ai_credentials']) {
    assert.equal(schema.includes(forbidden), false, `schema contains ${forbidden}`);
  }
  for (const forbidden of ['/api/bot', '/api/blindbox', '/api/movie-tickets', '/api/gift-overlay']) {
    assert.equal(server.includes(forbidden), false, `server exposes ${forbidden}`);
  }
  assert.equal(/movie.?ticket/i.test(store), false);
});

test('public home restores user and administrator entry cards without private modules', () => {
  const home = read('frontend', 'src', 'pages', 'Home.js');
  for (const route of ['/admin/site-config', '/admin/points', '/admin/prizes', '/admin/prize-orders', '/admin/permissions']) {
    assert.equal(home.includes(route), true, `home is missing ${route}`);
  }
  assert.match(home, /isAuthenticated \? \[/);
  assert.match(home, /isAdmin \? \[/);
  for (const forbidden of ['/admin/bot', '/admin/blindbox', '/admin/gift-overlay', '/admin/movie-tickets']) {
    assert.equal(home.includes(forbidden), false, `home exposes ${forbidden}`);
  }
});

test('restored public pages use the original style selectors and points-only model', () => {
  const profile = read('frontend', 'src', 'pages', 'Profile.js');
  const store = read('frontend', 'src', 'pages', 'PrizesWithCart.js');
  const profileCss = read('frontend', 'src', 'pages', 'Profile.css');
  const appCss = read('frontend', 'src', 'styles', 'App.css');
  const adminPrizes = read('frontend', 'src', 'pages', 'AdminPrizes.js');
  const adminPrizeEditor = read('frontend', 'src', 'pages', 'AdminPrizeEditorModal.js');
  const prizeAdminForm = read('frontend', 'src', 'pages', 'PrizeAdminForm.js');
  const adminOrders = read('frontend', 'src', 'pages', 'AdminPrizeOrders.js');
  const permissions = read('frontend', 'src', 'pages', 'PermissionManagement', 'PermissionManagement.js');
  const adminPrizeCss = read('frontend', 'src', 'pages', 'AdminPrizes.css');
  const adminOrderCss = read('frontend', 'src', 'pages', 'AdminPrizeOrders.css');
  const permissionCss = read('frontend', 'src', 'pages', 'PermissionManagement', 'PermissionManagement.css');

  for (const selector of ['profile-points-panel', 'profile-point-ledger', 'profile-order-list']) {
    assert.equal(profile.includes(selector), true, `profile is missing ${selector}`);
    assert.equal(profileCss.includes(`.${selector}`), true, `profile CSS is missing ${selector}`);
  }
  for (const selector of ['prize-image-gallery', 'prize-cart-panel', 'prize-address-card', 'prize-checkout-modal']) {
    assert.equal(store.includes(selector), true, `store is missing ${selector}`);
    assert.equal(appCss.includes(`.${selector}`), true, `app CSS is missing ${selector}`);
  }
  for (const [source, css, selectors] of [
    [adminPrizes, adminPrizeCss, ['admin-prizes-layout', 'prize-admin-list', 'prize-side-panel']],
    [adminPrizeEditor, adminPrizeCss, ['prize-editor-modal', 'prize-full-editor-form', 'image-admin-grid']],
    [prizeAdminForm, adminPrizeCss, ['delivery-type-toggle', 'prize-options-editor', 'prize-option-compact-grid']],
    [adminOrders, adminOrderCss, ['admin-order-filters', 'admin-order-list', 'admin-order-modal']],
    [permissions, permissionCss, ['users-table', 'permission-modal', 'role-selector', 'permissions-grid']]
  ]) {
    for (const selector of selectors) {
      assert.equal(source.includes(selector), true, `component is missing ${selector}`);
      assert.equal(css.includes(`.${selector}`), true, `component CSS is missing ${selector}`);
    }
  }
  for (const source of [profile, store, adminPrizes, adminPrizeEditor, prizeAdminForm, adminOrders, permissions]) {
    assert.equal(/movie.?ticket|botService|BotActivation|blindbox/i.test(source), false);
  }
});

test('demo seed requires an explicit strong password', () => {
  const seed = read('backend', 'scripts', 'seed_demo.js');
  assert.match(seed, /DEMO_ADMIN_PASSWORD is required/);
  assert.match(seed, /example\.invalid/);
  assert.doesNotMatch(seed, /password123|admin@anna/);
});

test('single-site song catalog replaces the legacy first-playlist workflow', () => {
  const routes = read('backend', 'src', 'routes', 'playlists.js');
  const controller = read('backend', 'src', 'controllers', 'playlistController.js');
  const sitePlaylist = read('backend', 'src', 'services', 'sitePlaylistService.js');
  const schema = read('backend', 'src', 'config', 'schema.sql');
  const seed = read('backend', 'scripts', 'seed_demo.js');
  const page = read('frontend', 'src', 'pages', 'Playlists.js');
  const services = read('frontend', 'src', 'services', 'index.js');

  assert.match(routes, /router\.get\('\/songs', asyncHandler\(playlistController\.getAllSongs\)\)/);
  assert.match(routes, /router\.post\('\/songs', authMiddleware, requirePermission\(PERMISSIONS\.PLAYLIST_MANAGE\)/);
  assert.match(routes, /router\.post\('\/songs\/batch', authMiddleware, requirePermission\(PERMISSIONS\.PLAYLIST_MANAGE\)/);
  assert.doesNotMatch(routes, /:playlistId\/songs|playlistController\.createPlaylist/);

  assert.match(sitePlaylist, /site_playlist_id/);
  assert.match(sitePlaylist, /FOR UPDATE/);
  assert.match(controller, /beginTransaction/);
  assert.match(controller, /rollback/);
  assert.match(controller, /SPONSOR_TAG_NAME = '冠名'/);
  assert.doesNotMatch(controller, /song_tags[^\n]*\[.*(?:,\s*6|6\s*,)/);
  assert.match(schema, /'site_playlist_id', CAST\(LAST_INSERT_ID\(\) AS CHAR\)/);
  assert.match(seed, /ensureSitePlaylist\(connection, userId\)/);

  assert.match(page, /songRequestService\.getCatalog\(/);
  assert.match(page, /permissionService\.PERMISSIONS\.PLAYLIST_MANAGE/);
  assert.match(page, /submittingRef\.current/);
  assert.doesNotMatch(page, /没有可添加歌曲的歌单|playlist\.edit\.(?:single|batch)|defaultPlaylistId/);
  assert.match(services, /api\.post\('\/playlists\/songs', songData\)/);
  assert.match(services, /api\.post\('\/playlists\/songs\/batch', \{ songs \}\)/);
});

test('song catalog helpers aggregate old containers and derive the sponsor tag by name', async () => {
  const playlist = require('../src/controllers/playlistController').__test__;
  assert.deepEqual(
    playlist.normalizeTagNames([{ name: '流行' }, '流行', { name: '冠名' }], '支持者'),
    ['流行', '冠名']
  );
  assert.deepEqual(playlist.normalizeTagNames([{ name: '冠名' }], ''), []);

  const rows = [
    { id: 1, playlist_id: 10, title: 'A', artist: 'Singer', duration: null, note: null, song_order: 0, created_at: null, playlist_title: '旧歌单', tag_id: 2, tag_name: '流行', tag_color: '#123456' },
    { id: 1, playlist_id: 10, title: 'A', artist: 'Singer', duration: null, note: null, song_order: 0, created_at: null, playlist_title: '旧歌单', tag_id: 3, tag_name: '慢歌', tag_color: '#654321' },
    { id: 2, playlist_id: 11, title: 'B', artist: 'Singer', duration: null, note: null, song_order: 0, created_at: null, playlist_title: '另一旧歌单', tag_id: null, tag_name: null, tag_color: null }
  ];
  const songs = await playlist.loadSongs({ query: async () => [rows] });
  assert.equal(songs.length, 2);
  assert.deepEqual(songs[0].tags.map((tag) => tag.name), ['流行', '慢歌']);
  assert.equal(songs[1].playlistTitle, '另一旧歌单');
});

test('site playlist resolver creates once and reuses the locked setting', async () => {
  const { ensureSitePlaylist } = require('../src/services/sitePlaylistService');
  let settingValue = '';
  let playlistId = null;
  let playlistInsertCount = 0;
  const connection = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT IGNORE INTO settings')) return [{ affectedRows: 0 }];
      if (normalized.includes('FROM settings WHERE setting_key = ? FOR UPDATE')) return [[{ setting_value: settingValue }]];
      if (normalized.startsWith('SELECT id FROM playlists WHERE id = ?')) {
        return [playlistId === params[0] ? [{ id: playlistId }] : []];
      }
      if (normalized.startsWith('SELECT id FROM playlists ORDER BY')) return [playlistId ? [{ id: playlistId }] : []];
      if (normalized.startsWith('SELECT setting_value FROM settings')) return [[{ setting_value: '自定义歌曲列表' }]];
      if (normalized.startsWith('INSERT INTO playlists')) {
        playlistInsertCount += 1;
        playlistId = 42;
        return [{ insertId: playlistId }];
      }
      if (normalized.startsWith('UPDATE settings SET setting_value')) {
        settingValue = params[0];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${normalized}`);
    }
  };

  assert.equal(await ensureSitePlaylist(connection, 7), 42);
  assert.equal(await ensureSitePlaylist(connection, 7), 42);
  assert.equal(playlistInsertCount, 1);
  assert.equal(settingValue, '42');
});

test('captcha and email verification require complete optional configuration', () => {
  const optional = require('../src/utils/optionalFeatures');
  const configured = {
    ALIYUN_ACCESS_KEY_ID: 'id',
    ALIYUN_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_CAPTCHA_SCENE_ID: 'scene',
    ALIYUN_CAPTCHA_PREFIX: 'prefix',
    TENCENT_SECRET_ID: 'id',
    TENCENT_SECRET_KEY: 'secret',
    SES_FROM_EMAIL: 'sender@example.test',
    SES_TEMPLATE_ID: '123',
    SES_REDEMPTION_TEMPLATE_ID: '456',
    SES_REDEMPTION_TO_EMAIL: 'owner@example.test',
    SES_MARSHMALLOW_TEMPLATE_ID: '789',
    SES_MARSHMALLOW_TO_EMAIL: 'owner@example.test'
  };

  assert.equal(optional.isCaptchaEnabled(configured), true);
  for (const key of optional.CAPTCHA_KEYS) {
    assert.equal(optional.isCaptchaEnabled({ ...configured, [key]: '' }), false, `${key} should disable captcha`);
  }

  assert.equal(optional.isEmailVerificationEnabled(configured), true);
  for (const key of [...optional.SES_BASE_KEYS, 'SES_TEMPLATE_ID']) {
    assert.equal(optional.isEmailVerificationEnabled({ ...configured, [key]: '' }), false, `${key} should disable email verification`);
  }
  assert.equal(optional.isEmailVerificationEnabled({ ...configured, SES_TEMPLATE_ID: 'not-a-number' }), false);
  assert.equal(optional.isRedemptionEmailEnabled({ ...configured, SES_REDEMPTION_TO_EMAIL: '' }), false);
  assert.equal(optional.isMarshmallowEmailEnabled({ ...configured, SES_MARSHMALLOW_TEMPLATE_ID: '' }), false);
});

test('optional verification state is shared by backend and registration UI', () => {
  const auth = read('backend', 'src', 'controllers', 'authController.js');
  const captcha = read('backend', 'src', 'utils', 'aliyunCaptcha.js');
  const email = read('backend', 'src', 'utils', 'emailService.js');
  const settingsController = read('backend', 'src', 'controllers', 'settingsController.js');
  const register = read('frontend', 'src', 'pages', 'Register.js');
  const services = read('frontend', 'src', 'services', 'index.js');

  assert.match(captcha, /if \(!isCaptchaEnabled\(\)\)/);
  assert.match(settingsController, /enabled: isCaptchaEnabled\(\)/);
  assert.match(settingsController, /emailVerificationEnabled: isEmailVerificationEnabled\(\)/);
  assert.match(auth, /if \(!isEmailVerificationEnabled\(\)\)/);
  assert.match(auth, /emailVerificationEnabled && !verificationCode/);
  assert.match(auth, /if \(!emailVerificationEnabled\) \{[\s\S]*verifyCaptcha\(captchaVerifyParam/);
  assert.match(email, /if \(!isEmailVerificationEnabled\(\)\)/);
  assert.match(email, /skipped: true/);

  assert.match(register, /setEmailVerificationEnabled\(data\.emailVerificationEnabled !== false\)/);
  assert.match(register, /\{emailVerificationEnabled && \(/);
  assert.match(register, /emailVerificationEnabled \? \(/);
  assert.match(register, /onSuccess=\{submitRegistration\}/);
  assert.match(services, /verificationCode,[\s\S]*captchaVerifyParam/);
});

test('production runtime configuration rejects unsafe secrets and open CORS defaults', () => {
  const runtime = require('../src/config/runtimeConfig');
  const unsafe = runtime.validateRuntimeConfig({ NODE_ENV: 'production', JWT_SECRET: 'replace_me', CORS_ORIGIN: '', TRUST_PROXY: '1' });
  assert.ok(unsafe.some((message) => message.includes('JWT_SECRET')));
  assert.ok(unsafe.some((message) => message.includes('CORS_ORIGIN')));

  const safeEnv = {
    NODE_ENV: 'production',
    JWT_SECRET: 'a-secure-random-value-that-is-longer-than-32-characters',
    CORS_ORIGIN: 'https://annapiggy.live',
    TRUST_PROXY: '1'
  };
  assert.deepEqual(runtime.validateRuntimeConfig(safeEnv), []);
  assert.deepEqual(runtime.parseCorsOrigins({ NODE_ENV: 'development' }), runtime.LOCAL_CORS_ORIGINS);
  assert.equal(runtime.resolveTrustProxy({ TRUST_PROXY: '0' }), false);
});

test('async route wrapper forwards rejected promises to the error middleware', async () => {
  const asyncHandler = require('../src/utils/asyncHandler');
  const expected = new Error('boom');
  await new Promise((resolve, reject) => {
    asyncHandler(async () => { throw expected; })({}, {}, (error) => {
      try {
        assert.equal(error, expected);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test('public input limits reject oversized content and spreadsheet formulas are neutralized', () => {
  const validation = require('../src/utils/validation');
  const points = require('../src/services/pointsService').__test__;
  assert.throws(() => validation.positiveInt(100, { field: 'Quantity', max: 99 }), /1 to 99/);
  assert.throws(() => validation.stringValue('x'.repeat(201), { field: 'Title', max: 200 }), /200/);
  assert.equal(points.escapeCsv('=HYPERLINK("https://example.test")'), `"'=HYPERLINK(""https://example.test"")"`);
  assert.equal(points.escapeCsv('normal'), 'normal');
});

test('delegated management permissions are enforced consistently by API and frontend routes', () => {
  const pointsRoutes = read('backend', 'src', 'routes', 'points.js');
  const prizeRoutes = read('backend', 'src', 'routes', 'prizes.js');
  const settingsRoutes = read('backend', 'src', 'routes', 'settings.js');
  const marshmallow = read('backend', 'src', 'controllers', 'marshmallowController.js');
  const app = read('frontend', 'src', 'App.js');
  assert.match(pointsRoutes, /router\.use\('\/admin', requirePermission\(PERMISSIONS\.POINTS_MANAGE\)\)/);
  assert.match(prizeRoutes, /router\.use\('\/admin', authMiddleware, requirePermission\(PERMISSIONS\.PRIZE_MANAGE\)\)/);
  assert.match(settingsRoutes, /requirePermission\(PERMISSIONS\.SITE_CONFIG_MANAGE\)/);
  assert.doesNotMatch(marshmallow, /req\.userRole !== 'admin'/);
  for (const permission of ['points.manage', 'prize.manage', 'site_config.manage']) {
    assert.equal(app.includes(`permission="${permission}"`), true, `frontend route is missing ${permission}`);
  }
});

test('prize images are validated and persisted outside the database', async () => {
  const prize = require('../src/controllers/prizeController').__test__;
  const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const url = await prize.persistPrizeImage(`data:image/png;base64,${pngBytes.toString('base64')}`);
  assert.match(url, /^\/uploads\/prizes\/[0-9]+-[0-9a-f-]+\.png$/);
  const storedPath = path.join(root, 'backend', 'uploads', 'prizes', path.basename(url));
  try {
    assert.deepEqual(fs.readFileSync(storedPath), pngBytes);
  } finally {
    fs.rmSync(storedPath, { force: true });
  }
});
