const crypto = require('node:crypto');
const { listenerError } = require('./errors');

const SIGNED_HEADER_NAMES = Object.freeze([
  'x-bili-accesskeyid',
  'x-bili-content-md5',
  'x-bili-signature-method',
  'x-bili-signature-nonce',
  'x-bili-signature-version',
  'x-bili-timestamp'
]);

function assertRawBody(rawBody) {
  if (!Buffer.isBuffer(rawBody)) throw listenerError('invalid_official_request_body');
  return rawBody;
}

function createCanonicalHeaderString(headers) {
  return SIGNED_HEADER_NAMES
    .map((name) => {
      const value = headers?.[name];
      if (typeof value !== 'string' || !value) {
        throw listenerError('invalid_official_signing_header');
      }
      return `${name}:${value}`;
    })
    .join('\n');
}

function signOfficialRequest({
  accessKeyId,
  accessKeySecret,
  rawBody,
  timestamp,
  nonce
}) {
  assertRawBody(rawBody);
  const normalizedTimestamp = String(timestamp);
  const normalizedNonce = String(nonce);
  if (
    typeof accessKeyId !== 'string' ||
    !accessKeyId ||
    typeof accessKeySecret !== 'string' ||
    !accessKeySecret ||
    !/^[0-9]{1,12}$/.test(normalizedTimestamp) ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(normalizedNonce)
  ) {
    throw listenerError('invalid_official_signing_input');
  }

  const signingHeaders = {
    'x-bili-accesskeyid': accessKeyId,
    'x-bili-content-md5': crypto.createHash('md5').update(rawBody).digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': normalizedNonce,
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': normalizedTimestamp
  };
  const canonical = createCanonicalHeaderString(signingHeaders);
  const authorization = crypto
    .createHmac('sha256', accessKeySecret)
    .update(canonical, 'utf8')
    .digest('hex');

  return Object.freeze({
    headers: Object.freeze({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...signingHeaders,
      Authorization: authorization
    }),
    contentMd5: signingHeaders['x-bili-content-md5'],
    authorization
  });
}

function serializeOfficialBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw listenerError('invalid_official_request_body');
  }
  return Buffer.from(JSON.stringify(body), 'utf8');
}

module.exports = {
  SIGNED_HEADER_NAMES,
  createCanonicalHeaderString,
  serializeOfficialBody,
  signOfficialRequest
};
