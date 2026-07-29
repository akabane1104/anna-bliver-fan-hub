const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MysqlSessionLock,
  createLockName
} = require('../src/mysqlSessionLock');

test('MySQL advisory lock is held by one dedicated connection and released once', async () => {
  const calls = [];
  let ended = 0;
  const connection = {
    async query(sql) {
      calls.push(sql);
      return [[{ connection_id: 42 }]];
    },
    async execute(sql) {
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('IS_USED_LOCK')) return [[{ owner_id: 42 }]];
      return [[{ released: 1 }]];
    },
    async end() {
      ended += 1;
    }
  };
  const lock = new MysqlSessionLock({
    connectionFactory: async () => connection,
    connectionOptions: {},
    siteId: 'synthetic-site'
  });
  assert.equal(await lock.acquire(), true);
  assert.equal(await lock.acquire(), true);
  assert.equal(await lock.isHeld(), true);
  await lock.release();
  assert.equal(await lock.isHeld(), false);
  assert.equal(ended, 1);
  assert.equal(calls.filter((sql) => sql.includes('GET_LOCK')).length, 1);
  assert.match(createLockName('synthetic-site'), /^anna-bliver:official-live:/);
});

test('lock contention never claims session ownership', async () => {
  const lock = new MysqlSessionLock({
    connectionFactory: async () => ({
      async query() {
        return [[{ connection_id: 7 }]];
      },
      async execute() {
        return [[{ acquired: 0 }]];
      },
      async end() {}
    }),
    connectionOptions: {},
    siteId: 'synthetic-site'
  });
  assert.equal(await lock.acquire(), false);
  assert.equal(await lock.isHeld(), false);
  await lock.release();
});
