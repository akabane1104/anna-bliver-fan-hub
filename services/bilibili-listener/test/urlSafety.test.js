const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertLoopbackBaseUrl
} = require('../src/urlSafety');
const {
  assertLoopbackBaseUrl: phase4dValidator
} = require('../../../tools/live-event-simulator/src/httpClient');

test('URL policy accepts only explicit loopback HTTP literals with Phase 4D parity', () => {
  for (const value of [
    'http://127.0.0.1',
    'http://127.0.0.1:5000',
    'http://localhost',
    'http://localhost:5000',
    'http://[::1]:5000'
  ]) {
    assert.doesNotThrow(() => assertLoopbackBaseUrl(value), value);
    assert.doesNotThrow(() => phase4dValidator(value), value);
  }
});

test('URL policy rejects remote, LAN, credentials, paths, HTTPS, and parser aliases', () => {
  const credentialTarget = new URL('http://localhost:5000');
  credentialTarget.username = 'synthetic-user';
  credentialTarget.password = 'synthetic-password';
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
    'http://localhost:5000?redirect=true',
    'http://localhost:5000#fragment'
  ]) {
    assert.throws(
      () => assertLoopbackBaseUrl(value),
      { code: 'remote_backend_rejected' },
      value
    );
    assert.throws(() => phase4dValidator(value), undefined, value);
  }
});

test('Listener additionally rejects an unusable explicit port zero', () => {
  for (const value of ['http://localhost:0', 'http://localhost:00000']) {
    assert.throws(
      () => assertLoopbackBaseUrl(value),
      { code: 'remote_backend_rejected' },
      value
    );
  }
});
