const pool = require('../src/config/database');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const run = async () => {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('请通过 ADMIN_EMAIL 提供已注册用户的有效邮箱。');
  }

  const [users] = await pool.execute(
    'SELECT id, username, role FROM users WHERE email = ? LIMIT 1',
    [email]
  );
  if (!users.length) {
    throw new Error(`找不到已注册用户：${email}`);
  }

  const user = users[0];
  if (user.role !== 'admin') {
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', ['admin', user.id]);
  }

  console.log(`管理员已就绪：${email}`);
};

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
