const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSignedHeaders, signRawBody } = require('../src/signer');

test('signer follows the Phase 4B timestamp-dot-raw-body contract', () => {
  const secret = crypto.randomBytes(48).toString('base64url');
  const timestamp = '1784764800';
  const rawBody = Buffer.from('{"schema_version":"1.0","text":"synthetic"}', 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');

  assert.equal(signRawBody({ secret, timestamp, rawBody }), expected);
  assert.deepEqual(createSignedHeaders({ secret, timestamp, rawBody }), {
    'Content-Type': 'application/json',
    'X-Live-Timestamp': timestamp,
    'X-Live-Signature': expected
  });
});

test('signer is sensitive to the exact raw JSON bytes', () => {
  const secret = crypto.randomBytes(48).toString('base64url');
  const timestamp = '1784764800';
  const compact = signRawBody({
    secret,
    timestamp,
    rawBody: '{"a":1,"b":2}'
  });
  const spaced = signRawBody({
    secret,
    timestamp,
    rawBody: '{"a": 1, "b": 2}'
  });
  assert.notEqual(compact, spaced);
});

test('signer rejects short secrets and malformed timestamps', () => {
  assert.throws(
    () => signRawBody({ secret: 'short', timestamp: '1784764800', rawBody: '{}' }),
    { code: 'invalid_simulator_secret' }
  );
  assert.throws(
    () => signRawBody({
      secret: crypto.randomBytes(48).toString('base64url'),
      timestamp: 'not-a-time',
      rawBody: '{}'
    }),
    { code: 'invalid_timestamp' }
  );
});
