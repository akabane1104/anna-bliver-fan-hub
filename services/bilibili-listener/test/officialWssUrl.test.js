const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFICIAL_WSS_ALLOWLIST,
  OFFICIAL_WSS_ALLOWLIST_VERIFIED,
  OFFICIAL_WSS_DYNAMIC_TRUST_ENABLED,
  OFFICIAL_WSS_EVIDENCE_VERIFIED,
  assertOfficialWssEvidenceVerified,
  assertOfficialWssUrl,
  createOfficialWssSessionTrust,
  getOfficialWssAuthBody,
  isUnsafeIpv4,
  isUnsafeIpv6,
  parseOfficialWssUrl,
  revalidateOfficialWssLink,
  validateOfficialWssLinks
} = require('../src/officialWssUrl');

const publicLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
];

function session({
  authBody = '{"synthetic":"auth"}',
  links = ['wss://session-gateway.example.net/sub']
} = {}) {
  return createOfficialWssSessionTrust({ authBody, wssLinks: links });
}

test('static evidence stays false while same-response dynamic trust is enabled', () => {
  assert.equal(OFFICIAL_WSS_EVIDENCE_VERIFIED, false);
  assert.equal(OFFICIAL_WSS_ALLOWLIST_VERIFIED, false);
  assert.deepEqual(OFFICIAL_WSS_ALLOWLIST, []);
  assert.equal(OFFICIAL_WSS_DYNAMIC_TRUST_ENABLED, true);
  assert.throws(
    () => assertOfficialWssEvidenceVerified(),
    { code: 'official_wss_allowlist_unverified' }
  );
});

test('manual WSS values are always rejected regardless of URL shape', () => {
  for (const value of [
    'wss://session-gateway.example.net/sub',
    'wss://broadcastlv.chat.bilibili.com/sub',
    process.env.BILIBILI_WSS_URL,
    null
  ]) {
    assert.throws(
      () => assertOfficialWssUrl(value),
      { code: 'official_wss_manual_source_rejected' }
    );
  }
});

test('same app/start response yields session-bound links and auth body', async () => {
  const trust = session({
    links: [
      'wss://session-a.example.net/sub?session=synthetic',
      'wss://session-b.example.net:443/sub'
    ]
  });
  const links = await validateOfficialWssLinks(trust, {
    lookup: publicLookup
  });
  assert.equal(links.length, 2);
  const revalidated = await revalidateOfficialWssLink(
    trust,
    links[0],
    { lookup: publicLookup }
  );
  assert.equal(
    getOfficialWssAuthBody(trust, revalidated),
    '{"synthetic":"auth"}'
  );
  assert.equal(JSON.stringify(trust), '{}');
});

test('duplicate links from one official start response are safely deduplicated', async () => {
  const trust = session({
    links: [
      'wss://session-a.example.net/sub',
      'wss://session-a.example.net:443/sub',
      'wss://session-b.example.net/sub',
      'wss://session-a.example.net/sub'
    ]
  });
  const links = await validateOfficialWssLinks(trust, {
    lookup: publicLookup
  });
  assert.deepEqual(
    links.map((link) => link.href),
    [
      'wss://session-a.example.net/sub',
      'wss://session-b.example.net/sub'
    ]
  );
});

test('links and auth cannot cross app/start session boundaries', async () => {
  const first = session({ authBody: '{"session":1}' });
  const second = session({ authBody: '{"session":2}' });
  const [firstLink] = await validateOfficialWssLinks(first, {
    lookup: publicLookup
  });
  assert.throws(
    () => getOfficialWssAuthBody(second, firstLink),
    { code: 'official_wss_cross_session_rejected' }
  );
  await assert.rejects(
    () => revalidateOfficialWssLink(second, firstLink, {
      lookup: publicLookup
    }),
    { code: 'official_wss_cross_session_rejected' }
  );
});

test('malformed, downgraded, credentialed, internal, and IP URLs fail closed', () => {
  for (const value of [
    'ws://session.example.net/sub',
    'https://session.example.net/sub',
    'wss://user:password@session.example.net/sub',
    'wss://session.example.net/sub#fragment',
    'wss://session.example.net:444/sub',
    'wss://localhost/sub',
    'wss://service.internal/sub',
    'wss://service.local/sub',
    'wss://singlelabel/sub',
    'wss://127.0.0.1/sub',
    'wss://[::1]/sub',
    'not-a-url'
  ]) {
    assert.throws(
      () => parseOfficialWssUrl(value),
      { code: 'invalid_official_wss_link' }
    );
  }
});

test('DNS answers are checked initially and immediately before connect', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.1.1',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1'
  ]) {
    const trust = session();
    await assert.rejects(
      () => validateOfficialWssLinks(trust, {
        lookup: async () => [{
          address,
          family: address.includes(':') ? 6 : 4
        }]
      }),
      { code: 'official_wss_non_public_address' }
    );
  }

  const trust = session();
  const [link] = await validateOfficialWssLinks(trust, {
    lookup: publicLookup
  });
  await assert.rejects(
    () => revalidateOfficialWssLink(trust, link, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }]
    }),
    { code: 'official_wss_non_public_address' }
  );
});

test('public and unsafe address classifiers cover IPv4 and IPv6 boundaries', () => {
  assert.equal(isUnsafeIpv4('93.184.216.34'), false);
  assert.equal(isUnsafeIpv4('172.16.0.1'), true);
  assert.equal(
    isUnsafeIpv6('2606:2800:220:1:248:1893:25c8:1946'),
    false
  );
  assert.equal(isUnsafeIpv6('::ffff:127.0.0.1'), true);
  assert.equal(isUnsafeIpv6('fc00::1'), true);
});
