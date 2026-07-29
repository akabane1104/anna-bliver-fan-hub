const db = require('../config/database');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isCaptchaEnabled, isEmailVerificationEnabled } = require('../utils/optionalFeatures');
const { isAdminRole } = require('../config/accessControl');

const BRANDING_UPLOAD_DIRECTORY = path.join(__dirname, '..', '..', 'uploads', 'branding');
const MAX_BRANDING_IMAGE_BYTES = 2 * 1024 * 1024;
const BRANDING_IMAGE_TYPES = {
  'image/png': {
    extension: 'png',
    matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  },
  'image/jpeg': {
    extension: 'jpg',
    matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  },
  'image/webp': {
    extension: 'webp',
    matches: (buffer) => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  }
};

const SITE_FIELDS = {
  siteTitle: ['site_title', 'SITE_TITLE', '小猪anna的秘密基地'],
  navbarBrandMode: ['navbar_brand_mode', 'SITE_BRAND_MODE', 'image'],
  navbarBrandText: ['navbar_brand_text', 'SITE_BRAND_TEXT', '小猪anna的秘密基地'],
  navbarLogoUrl: ['navbar_logo_url', 'SITE_LOGO_URL', '/annapiggy-logo.png'],
  faviconUrl: ['favicon_url', 'SITE_FAVICON_URL', '/favicon.ico'],
  creatorDisplayName: ['creator_display_name', 'CREATOR_DISPLAY_NAME', '小猪anna'],
  bilibiliUid: ['bilibili_uid', 'BILIBILI_UID', ''],
  homeTitle: ['home_title', 'SITE_HOME_TITLE', '欢迎来到小猪anna的秘密基地'],
  homeSubtitle: ['home_subtitle', 'SITE_HOME_SUBTITLE', '音乐、心意与每一份支持，都值得被认真收藏。'],
  playlistCardTitle: ['playlist_card_title', 'SITE_PLAYLIST_CARD_TITLE', '网页歌单'],
  playlistCardDescription: ['playlist_card_description', 'SITE_PLAYLIST_CARD_DESCRIPTION', '浏览曲目、标签与演唱信息。'],
  marshmallowCardTitle: ['marshmallow_card_title', 'SITE_MARSHMALLOW_CARD_TITLE', '棉花糖'],
  marshmallowCardDescription: ['marshmallow_card_description', 'SITE_MARSHMALLOW_CARD_DESCRIPTION', '匿名送达想说的话，登录后还能查看回复。'],
  prizeCardTitle: ['prize_card_title', 'SITE_PRIZE_CARD_TITLE', '积分商城'],
  prizeCardDescription: ['prize_card_description', 'SITE_PRIZE_CARD_DESCRIPTION', '使用社区积分兑换限定奖品。'],
  playlistTitle: ['playlist_title', 'SITE_PLAYLIST_TITLE', '小猪anna的歌单'],
  playlistSubtitle: ['playlist_subtitle', 'SITE_PLAYLIST_SUBTITLE', '想听什么，就从这里开始。'],
  marshmallowTitle: ['marshmallow_title', 'SITE_MARSHMALLOW_TITLE', '棉花糖'],
  marshmallowSubtitle: ['marshmallow_subtitle', 'SITE_MARSHMALLOW_SUBTITLE', '写下一封匿名来信。'],
  icpText: ['icp_text', 'SITE_ICP_TEXT', ''],
  publicSecurityText: ['public_security_text', 'SITE_PUBLIC_SECURITY_TEXT', ''],
  primaryColor: ['theme_primary_color', 'SITE_PRIMARY_COLOR', '#9b59b6'],
  lightColor: ['theme_light_color', 'SITE_LIGHT_COLOR', '#b19cd9'],
  darkColor: ['theme_dark_color', 'SITE_DARK_COLOR', '#7d3c98'],
  backgroundColor: ['theme_background_color', 'SITE_BACKGROUND_COLOR', '#f5f7fa'],
  backgroundAccentColor: ['theme_background_accent_color', 'SITE_BACKGROUND_ACCENT_COLOR', '#f0e6f6'],
  textDarkColor: ['theme_text_dark_color', 'SITE_TEXT_DARK_COLOR', '#2c3e50'],
  textLightColor: ['theme_text_light_color', 'SITE_TEXT_LIGHT_COLOR', '#7f8c8d'],
  borderSoftColor: ['theme_border_soft_color', 'SITE_BORDER_COLOR', '#e2d7ea'],
  surfaceSubtleColor: ['theme_surface_subtle_color', 'SITE_SURFACE_COLOR', '#ffffff'],
  surfaceMutedColor: ['theme_surface_muted_color', 'SITE_SURFACE_MUTED_COLOR', '#faf7fd'],
  successColor: ['theme_success_color', 'SITE_SUCCESS_COLOR', '#27845b'],
  warningColor: ['theme_warning_color', 'SITE_WARNING_COLOR', '#a7681f'],
  dangerColor: ['theme_danger_color', 'SITE_DANGER_COLOR', '#c84646']
};

const COLOR_FIELDS = new Set(Object.keys(SITE_FIELDS).filter((key) => key.endsWith('Color')));
const MAX_VALUE_LENGTH = 500;

function resolveConfig(storedRows = [], env = process.env) {
  const stored = new Map(storedRows.map((row) => [row.setting_key, row.setting_value]));
  return Object.fromEntries(Object.entries(SITE_FIELDS).map(([field, [key, envName, fallback]]) => [
    field,
    stored.has(key) ? stored.get(key) : (env[envName] ?? fallback)
  ]));
}

async function getSiteConfig() {
  const keys = Object.values(SITE_FIELDS).map(([key]) => key);
  const [rows] = await db.query(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`, keys);
  return resolveConfig(rows);
}

function normalizeValue(field, value) {
  const text = String(value ?? '').trim();
  if (text.length > MAX_VALUE_LENGTH) throw new Error(`${field} is too long`);
  if (field === 'navbarBrandMode' && !['image', 'text', 'icon-text'].includes(text)) throw new Error('navbarBrandMode is invalid');
  if (field === 'navbarBrandText' && text.length > 60) throw new Error('navbarBrandText is too long');
  if (field === 'bilibiliUid' && text && !/^\d{1,20}$/.test(text)) throw new Error('bilibiliUid must be numeric');
  if (COLOR_FIELDS.has(field) && !/^#[0-9a-f]{6}$/i.test(text)) throw new Error(`${field} must be a six-digit hex color`);
  if (['navbarLogoUrl', 'faviconUrl'].includes(field) && text && !/^(?:\/(?!\/)|https:\/\/)/i.test(text)) throw new Error(`${field} must use HTTPS or a site-relative path`);
  return text;
}

function decodeBrandingImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('Logo must be a PNG, JPG or WebP image');

  const imageType = BRANDING_IMAGE_TYPES[match[1].toLowerCase()];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('Logo image is empty');
  if (buffer.length > MAX_BRANDING_IMAGE_BYTES) throw new Error('Logo image must not exceed 2 MB');
  if (!imageType.matches(buffer)) throw new Error('Logo image content does not match its file type');

  return { buffer, extension: imageType.extension };
}

exports.getCaptchaConfig = (req, res) => res.json({
  enabled: isCaptchaEnabled(),
  sceneId: process.env.ALIYUN_CAPTCHA_SCENE_ID || '', prefix: process.env.ALIYUN_CAPTCHA_PREFIX || '', region: 'cn'
});
exports.getRegistrationStatus = async (req, res) => {
  const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ?', ['registration_open']);
  res.json({
    registrationOpen: rows.length ? rows[0].setting_value === 'true' : true,
    emailVerificationEnabled: isEmailVerificationEnabled()
  });
};
exports.updateRegistrationStatus = async (req, res) => {
  if (typeof req.body.isOpen !== 'boolean') return res.status(400).json({ message: 'isOpen must be a boolean' });
  const value = String(req.body.isOpen);
  await db.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['registration_open', value]);
  return res.json({ registrationOpen: value === 'true' });
};
exports.getSiteConfig = async (req, res) => res.json(await getSiteConfig());
exports.uploadNavbarLogo = async (req, res) => {
  let image;
  try {
    image = decodeBrandingImage(req.body?.dataUrl);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  try {
    await fs.mkdir(BRANDING_UPLOAD_DIRECTORY, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomUUID()}.${image.extension}`;
    await fs.writeFile(path.join(BRANDING_UPLOAD_DIRECTORY, filename), image.buffer, { flag: 'wx' });
    return res.status(201).json({ url: `/uploads/branding/${filename}` });
  } catch (error) {
    console.error('Failed to save navbar logo:', error);
    return res.status(500).json({ message: 'Failed to store logo image' });
  }
};
exports.updateSiteConfig = async (req, res) => {
  let connection;
  try {
    const entries = Object.entries(req.body || {}).filter(([field]) => SITE_FIELDS[field]);
    if (!entries.length) return res.status(400).json({ message: 'No site configuration provided' });
    if (entries.some(([field]) => field === 'bilibiliUid') && !isAdminRole(req.userRole)) {
      return res.status(403).json({ message: '仅管理员可以修改目标主播 UID' });
    }
    const normalizedEntries = entries.map(([field, value]) => [SITE_FIELDS[field][0], normalizeValue(field, value)]);
    connection = await db.getConnection();
    await connection.beginTransaction();
    for (const [settingKey, settingValue] of normalizedEntries) {
      await connection.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [settingKey, settingValue]);
    }
    await connection.commit();
    return res.json({ message: 'Site configuration updated', config: await getSiteConfig() });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return res.status(error.status || 400).json({ message: error.message });
  } finally {
    connection?.release();
  }
};

exports.resolveSiteConfig = getSiteConfig;
exports.__test__ = { SITE_FIELDS, normalizeValue, resolveConfig, decodeBrandingImage, MAX_BRANDING_IMAGE_BYTES };
