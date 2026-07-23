const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeLogger } = require('../src/logger');

test('official credentials, protocol bodies, and platform identities cannot enter logs', () => {
  const records = [];
  const logger = createSafeLogger({
    clock: () => 1700000000000,
    sink: (record) => records.push(record)
  });
  logger.write('error', 'official_adapter_failed', {
    state: 'connected',
    room_id: 'synthetic-room',
    accessKeyId: 'sensitive-access-key',
    accessKeySecret: 'sensitive-secret',
    identityCode: 'sensitive-identity',
    Authorization: 'sensitive-authorization',
    contentMd5: 'sensitive-md5',
    authBody: 'sensitive-auth-body',
    gameId: 'sensitive-game-id',
    wssUrl: 'wss://sensitive.example/sub',
    openId: 'sensitive-open-id',
    uid: 'sensitive-uid',
    uname: 'sensitive-user',
    text: 'sensitive-danmaku',
    rawPayload: { nested: 'sensitive' }
  });
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(
    serialized,
    /sensitive-(?:access|secret|identity|authorization|md5|auth|game|open|uid|user|danmaku)|sensitive\.example/
  );
  assert.equal(records[0].state, 'connected');
});
