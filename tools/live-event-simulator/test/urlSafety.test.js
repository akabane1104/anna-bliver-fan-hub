const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLoopbackBaseUrl } = require('../src/httpClient');

test('loopback policy accepts only explicit local HTTP targets', () => {
  for (const value of [
    'http://127.0.0.1',
    'http://127.0.0.1:5000',
    'http://localhost',
    'http://localhost:5000',
    'http://[::1]:5000'
  ]) {
    assert.doesNotThrow(() => assertLoopbackBaseUrl(value), value);
  }
});

test('loopback policy rejects remote, preview, LAN, wildcard, credential, and path targets', () => {
  const credentialTarget = new URL('http://localhost:5000');
  credentialTarget.username = 'synthetic-user';
  credentialTarget.password = 'synthetic-pass';
  for (const value of [
    'https://preview.chengzhisweety.com',
    'http://preview.chengzhisweety.com',
    'http://192.168.1.10:5000',
    'http://10.0.0.5:5000',
    'http://0.0.0.0:5000',
    'http://127.0.0.2:5000',
    'http://127.1:5000',
    'http://2130706433:5000',
    'http://0177.0.0.1:5000',
    'http://0x7f000001:5000',
    'http://localhost.example:5000',
    'https://localhost:5000',
    credentialTarget.href,
    'http://localhost:5000/api',
    'http://localhost:5000?remote=true'
  ]) {
    assert.throws(
      () => assertLoopbackBaseUrl(value),
      { code: 'remote_target_rejected' },
      value
    );
  }
});
