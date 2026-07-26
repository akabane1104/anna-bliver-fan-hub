const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { assertSafeRuntimeConfig, createCorsOptions, resolveTrustProxy } = require('./config/runtimeConfig');

const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlists');
const prizeRoutes = require('./routes/prizes');
const settingsRoutes = require('./routes/settings');
const marshmallowRoutes = require('./routes/marshmallows');
const bilibiliRoutes = require('./routes/bilibili');
const bilibiliBindingRoutes = require('./routes/bilibiliBinding');
const permissionRoutes = require('./routes/permissions');
const pointsRoutes = require('./routes/points');
const { createLiveEventRouter } = require('./routes/liveEvents');
const { createSongRequestRouter } = require('./routes/songRequests');
const { createLiveControlRouter } = require('./routes/liveControl');
const { createLiveHomeRouter } = require('./routes/liveHome');
const { createObsOverlayRouter } = require('./routes/obsOverlay');
const pointsService = require('./services/pointsService');
const { startBotEventBridge } = require('./services/botEventBridge');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '4mb';

app.set('trust proxy', resolveTrustProxy());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use('/api/internal/live-events/v1', createLiveEventRouter());
app.use(cors(createCorsOptions()));
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use('/uploads/prizes', express.static(path.join(__dirname, '..', 'uploads', 'prizes')));
app.use('/uploads/branding', express.static(path.join(__dirname, '..', 'uploads', 'branding')));

const rateLimitHandler = (req, res) => res.status(429).json({ message: '请求过于频繁，请稍后再试' });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const authLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const verificationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const publicWriteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/send-code', verificationLimiter);
app.use('/api/marshmallows', (req, res, next) => req.method === 'POST' && req.path === '/' ? publicWriteLimiter(req, res, next) : next());

app.use('/api/auth', authRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/prizes', prizeRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/marshmallows', marshmallowRoutes);
app.use('/api/bilibili', bilibiliRoutes);
app.use('/api/bilibili-binding', bilibiliBindingRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/points', pointsRoutes);
app.use('/api/song-requests', createSongRequestRouter());
app.use('/api/live-home', createLiveHomeRouter());
app.use('/api/public/obs-overlay', createObsOverlayRouter());
app.use('/api/live-control', createLiveControlRouter());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ message: 'Request body too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON request body' });
  const status = Number(err?.status);
  if (!(status >= 400 && status < 500)) console.error(err);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    message: status >= 400 && status < 500 ? err.message : 'Internal server error'
  });
});

async function bootstrap() {
  assertSafeRuntimeConfig();
  await pointsService.ensurePointsSchema();
  await pointsService.settleBilibiliPoints();
  pointsService.scheduleDailySettlement();
  startBotEventBridge();
  app.listen(PORT, '0.0.0.0', () => console.log(`anna-bliver-fan-hub listening on ${PORT}`));
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Startup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, bootstrap };
