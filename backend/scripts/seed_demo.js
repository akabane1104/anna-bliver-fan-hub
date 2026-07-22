require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/config/database');
const pointsService = require('../src/services/pointsService');
const { ensureSitePlaylist } = require('../src/services/sitePlaylistService');

async function run() {
  const password = String(process.env.DEMO_ADMIN_PASSWORD || '');
  if (password.length < 12) throw new Error('DEMO_ADMIN_PASSWORD is required and must contain at least 12 characters');
  await pointsService.ensurePointsSchema();
  const hash = await bcrypt.hash(password, 12);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [userResult] = await connection.query(
      `INSERT INTO users (username, email, password, role) VALUES ('demo_admin', 'demo-admin@example.invalid', ?, 'admin')
       ON DUPLICATE KEY UPDATE password = VALUES(password), role = 'admin'`, [hash]
    );
    const [users] = await connection.query(`SELECT id FROM users WHERE email = 'demo-admin@example.invalid'`);
    const userId = users[0].id || userResult.insertId;
    const playlistId = await ensureSitePlaylist(connection, userId);
    await connection.query(
      `INSERT INTO songs (playlist_id, title, artist, duration, song_order) VALUES
       (?, '星光练习曲', 'Demo Singer', '03:18', 1), (?, '晚风留言', 'Demo Band', '04:02', 2)`,
      [playlistId, playlistId]
    );
    await connection.query(
      `INSERT INTO prizes (name, description, cost, image_url, stock, delivery_type) VALUES
       ('演示贴纸包', '虚构周边，仅供本地功能演示。', 120, '/branding/chengzhi-sweety-logo.png', 30, 'physical'),
       ('演示语音感谢', '虚构的数字奖品。', 80, '/branding/chengzhi-sweety-logo.png', 100, 'virtual')`
    );
    await connection.commit();
    console.log('Demo data created for demo-admin@example.invalid');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await db.end();
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
