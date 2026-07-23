const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createCanonicalHeaderString,
  serializeOfficialBody,
  signOfficialRequest
} = require('../src/officialApiSigner');

test('official documented canonical vector has exact order and HMAC', () => {
  const canonical = createCanonicalHeaderString({
    'x-bili-accesskeyid': 'xxxx',
    'x-bili-content-md5': 'fa6837e35b2f591865b288dfd859ce9d',
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': 'ad184c09-095f-91c3-0849-230dd3744045',
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': '1624594467'
  });
  assert.equal(canonical, [
    'x-bili-accesskeyid:xxxx',
    'x-bili-content-md5:fa6837e35b2f591865b288dfd859ce9d',
    'x-bili-signature-method:HMAC-SHA256',
    'x-bili-signature-nonce:ad184c09-095f-91c3-0849-230dd3744045',
    'x-bili-signature-version:1.0',
    'x-bili-timestamp:1624594467'
  ].join('\n'));
  assert.equal(
    crypto.createHmac('sha256', 'JzOzZfSHeYYnAMZ')
      .update(canonical)
      .digest('hex'),
    'a81c50234b6bbf15bc56e387ee4f19c6f871af2f70b837dc56db16517d4a341f'
  );
});

test('signer uses the exact serialized Unicode body bytes', () => {
  const rawBody = serializeOfficialBody({
    code: 'synthetic-code-\u6d4b\u8bd5',
    app_id: 1000000000001
  });
  const signed = signOfficialRequest({
    accessKeyId: 'synthetic-access-key',
    accessKeySecret: 'synthetic-access-secret-32-bytes!!',
    rawBody,
    timestamp: 1624594467,
    nonce: 'ad184c09-095f-91c3-0849-230dd3744045'
  });
  assert.equal(
    signed.headers['x-bili-content-md5'],
    crypto.createHash('md5').update(rawBody).digest('hex')
  );
  const changed = Buffer.from(rawBody);
  changed[changed.length - 2] ^= 1;
  const changedSignature = signOfficialRequest({
    accessKeyId: 'synthetic-access-key',
    accessKeySecret: 'synthetic-access-secret-32-bytes!!',
    rawBody: changed,
    timestamp: 1624594467,
    nonce: 'ad184c09-095f-91c3-0849-230dd3744045'
  });
  assert.notEqual(changedSignature.authorization, signed.authorization);
  assert.match(signed.authorization, /^[a-f0-9]{64}$/);
});

test('deterministic synthetic signature stays fixed', () => {
  const signed = signOfficialRequest({
    accessKeyId: 'synthetic-access-key',
    accessKeySecret: 'synthetic-access-secret-32-bytes!!',
    rawBody: serializeOfficialBody({
      code: 'synthetic-code',
      app_id: 1000000000001
    }),
    timestamp: 1624594467,
    nonce: 'ad184c09-095f-91c3-0849-230dd3744045'
  });
  assert.equal(signed.contentMd5, '4abdcc54924f2f74912fec585672447f');
  assert.equal(
    signed.authorization,
    '8fa2c9ee4deefd123b54a48f53db7ba3641629efdeef2429b7a7bf71c6174e60'
  );
});
