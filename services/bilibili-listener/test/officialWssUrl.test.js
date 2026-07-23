const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFICIAL_WSS_ALLOWLIST,
  OFFICIAL_WSS_ALLOWLIST_VERIFIED,
  OFFICIAL_WSS_ERROR_CODE,
  OFFICIAL_WSS_EVIDENCE_VERIFIED,
  assertOfficialWssEvidenceVerified,
  assertOfficialWssUrl,
  validateOfficialWssLinks
} = require('../src/officialWssUrl');

const UNVERIFIED_CANDIDATES = Object.freeze([
  'wss://broadcastlv.chat.bilibili.com/sub',
  'wss://cluster-1.chat.bilibili.com:443/sub',
  'WSS://BROADCASTLV.CHAT.BILIBILI.COM/sub',
  'wss://broadcastlv.chat.bilibili.com/SUB',
  'wss://chat.bilibili.com/sub',
  'wss://broadcastlv.chat.bilibili.com./sub',
  'wss://broadcastlv.chat.bilibili.com:444/sub',
  'wss://broadcastlv.chat.bilibili.com/sub?token=sensitive-query',
  'wss://broadcastlv.chat.bilibili.com/sub#fragment',
  'wss://user:password@broadcastlv.chat.bilibili.com/sub',
  'wss://broadcastlv.chat.bilibili.com/%73ub',
  'wss://broadcastlv.chat.bilibili.com//sub',
  'wss://sub.broadcastlv.chat.bilibili.com/sub',
  'wss://broadcastlv.chat.bilibili.com.evil.example/sub',
  'wss://127.0.0.1/sub',
  'wss://10.0.0.1/sub',
  'wss://172.16.0.1/sub',
  'wss://192.168.1.1/sub',
  'wss://[::1]/sub',
  'wss://[fd00::1]/sub',
  'ws://broadcastlv.chat.bilibili.com/sub',
  'https://broadcastlv.chat.bilibili.com/sub',
  'not-a-url',
  '',
  null,
  undefined
]);

function assertUnverified(work, sensitiveValue = '') {
  assert.throws(work, (error) => {
    assert.equal(error.code, OFFICIAL_WSS_ERROR_CODE);
    assert.equal(error.fatal, true);
    assert.equal(error.message, 'Listener operation failed');
    if (sensitiveValue) {
      assert.equal(error.message.includes(sensitiveValue), false);
      assert.equal(error.code.includes(sensitiveValue), false);
    }
    return true;
  });
}

test('official WSS evidence and allowlist remain explicitly empty', () => {
  assert.equal(OFFICIAL_WSS_EVIDENCE_VERIFIED, false);
  assert.equal(OFFICIAL_WSS_ALLOWLIST_VERIFIED, false);
  assert.deepEqual(OFFICIAL_WSS_ALLOWLIST, []);
  assert.equal(Object.isFrozen(OFFICIAL_WSS_ALLOWLIST), true);
  assertUnverified(() => assertOfficialWssEvidenceVerified());
});

test('every candidate URL fails closed before any endpoint can be accepted', () => {
  for (const value of UNVERIFIED_CANDIDATES) {
    assertUnverified(() => assertOfficialWssUrl(value), String(value || ''));
  }
});

test('link collections cannot create an implicit allowlist', () => {
  for (const values of [
    [],
    UNVERIFIED_CANDIDATES.slice(0, 1),
    UNVERIFIED_CANDIDATES.slice(0, 5),
    ['wss://synthetic-unverified.invalid/unverified'],
    null,
    undefined
  ]) {
    assertUnverified(() => validateOfficialWssLinks(values));
  }
});
