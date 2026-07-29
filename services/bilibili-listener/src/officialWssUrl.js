const dns = require('node:dns').promises;
const net = require('node:net');
const { listenerError } = require('./errors');

const MAX_WSS_LINKS = 5;
const OFFICIAL_WSS_ERROR_CODE = 'official_wss_allowlist_unverified';
const OFFICIAL_WSS_EVIDENCE_VERIFIED = false;
const OFFICIAL_WSS_ALLOWLIST = Object.freeze([]);
const OFFICIAL_WSS_ALLOWLIST_VERIFIED = false;
const OFFICIAL_WSS_DYNAMIC_TRUST_ENABLED = true;
const sessionTrustStore = new WeakMap();
const trustedLinkStore = new WeakMap();

function officialWssBoundaryError(
  code = 'invalid_official_wss_link',
  { fatal = true } = {}
) {
  const error = listenerError(code);
  error.fatal = fatal;
  return error;
}

function assertOfficialWssEvidenceVerified() {
  throw officialWssBoundaryError(OFFICIAL_WSS_ERROR_CODE);
}

function assertOfficialWssUrl(value) {
  void value;
  throw officialWssBoundaryError('official_wss_manual_source_rejected');
}

function parseIpv4(value) {
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))
  ) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return null;
  return octets;
}

function isUnsafeIpv4(value) {
  const octets = parseIpv4(value);
  if (!octets) return true;
  const address = octets.reduce(
    (result, octet) => ((result << 8) | octet) >>> 0,
    0
  );
  const ranges = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];
  return ranges.some(([base, bits]) => {
    const baseValue = parseIpv4(base).reduce(
      (result, octet) => ((result << 8) | octet) >>> 0,
      0
    );
    const mask = bits === 0
      ? 0
      : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) === (baseValue & mask);
  });
}

function expandIpv6(value) {
  let source = value.toLowerCase();
  const zoneIndex = source.indexOf('%');
  if (zoneIndex !== -1) source = source.slice(0, zoneIndex);
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    const ipv4 = parseIpv4(source.slice(lastColon + 1));
    if (!ipv4) return null;
    source = `${source.slice(0, lastColon)}:${(
      (ipv4[0] << 8) | ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1]
    ? halves[1].split(':')
    : [];
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length > 7)
  ) {
    return null;
  }
  const zeros = new Array(8 - left.length - right.length).fill('0');
  const parts = [...left, ...zeros, ...right];
  if (parts.length !== 8) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function isUnsafeIpv6(value) {
  const parts = expandIpv6(value);
  if (!parts) return true;
  const asBigInt = parts.reduce(
    (result, part) => (result << 16n) | BigInt(part),
    0n
  );
  if (asBigInt === 0n || asBigInt === 1n) return true;

  const mappedPrefix = 0xffffn;
  if ((asBigInt >> 32n) === mappedPrefix) {
    const embedded = [
      Number((asBigInt >> 24n) & 0xffn),
      Number((asBigInt >> 16n) & 0xffn),
      Number((asBigInt >> 8n) & 0xffn),
      Number(asBigInt & 0xffn)
    ].join('.');
    return isUnsafeIpv4(embedded);
  }

  if (
    parts[0] < 0x0100 ||
    (
      parts[0] === 0x0100 &&
      parts.slice(1, 4).every((part) => part === 0)
    ) ||
    (parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 1) ||
    (parts[0] === 0x2001 && parts[1] === 0) ||
    (parts[0] === 0x2001 && parts[1] === 2 && parts[2] === 0) ||
    (parts[0] === 0x2001 && parts[1] === 0x0db8) ||
    (
      parts[0] === 0x2001 &&
      (parts[1] & 0xfff0) === 0x0010
    ) ||
    (
      parts[0] === 0x2001 &&
      (parts[1] & 0xfff0) === 0x0020
    ) ||
    (parts[0] & 0xfe00) === 0xfc00 ||
    (parts[0] & 0xffc0) === 0xfe80 ||
    (parts[0] & 0xff00) === 0xff00 ||
    (parts[0] & 0xfff0) === 0x3ff0
  ) {
    return true;
  }

  if (parts[0] === 0x2002) {
    const embedded = [
      parts[1] >> 8,
      parts[1] & 0xff,
      parts[2] >> 8,
      parts[2] & 0xff
    ].join('.');
    return isUnsafeIpv4(embedded);
  }
  return false;
}

function assertPublicAddress(address) {
  const version = net.isIP(address);
  if (
    version === 0 ||
    (version === 4 && isUnsafeIpv4(address)) ||
    (version === 6 && isUnsafeIpv6(address))
  ) {
    throw officialWssBoundaryError('official_wss_non_public_address');
  }
}

function parseOfficialWssUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw officialWssBoundaryError('invalid_official_wss_link');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw officialWssBoundaryError('invalid_official_wss_link');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.port && parsed.port !== '443') ||
    !hostname ||
    hostname.endsWith('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    !hostname.includes('.') ||
    net.isIP(hostname) !== 0
  ) {
    throw officialWssBoundaryError('invalid_official_wss_link');
  }
  return parsed;
}

async function resolveAndValidateHostname(hostname, {
  lookup = dns.lookup
} = {}) {
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw officialWssBoundaryError(
      'official_wss_dns_failed',
      { fatal: false }
    );
  }
  const normalized = Array.isArray(records) ? records : [records];
  if (!normalized.length) {
    throw officialWssBoundaryError(
      'official_wss_dns_failed',
      { fatal: false }
    );
  }
  for (const record of normalized) {
    const address = String(record?.address || '');
    assertPublicAddress(address);
    if (Number(record?.family) !== net.isIP(address)) {
      throw officialWssBoundaryError('official_wss_dns_failed');
    }
  }
  return Object.freeze(normalized.map((record) => Object.freeze({
    address: String(record.address),
    family: Number(record.family)
  })));
}

function createOfficialWssSessionTrust({ authBody, wssLinks }) {
  if (
    typeof authBody !== 'string' ||
    Buffer.byteLength(authBody, 'utf8') < 2 ||
    Buffer.byteLength(authBody, 'utf8') > 16 * 1024 ||
    !Array.isArray(wssLinks) ||
    wssLinks.length < 1 ||
    wssLinks.length > MAX_WSS_LINKS
  ) {
    throw officialWssBoundaryError('invalid_official_start_response');
  }
  // Official docs return session-specific links without a stable host contract.
  // WeakMaps bind those links and auth bytes to this one validated start response.
  const token = Object.freeze({});
  const context = Object.freeze({});
  sessionTrustStore.set(context, Object.freeze({
    token,
    authBody,
    wssLinks: Object.freeze([...wssLinks])
  }));
  return context;
}

function assertSessionTrust(context) {
  const value = context && typeof context === 'object'
    ? sessionTrustStore.get(context)
    : null;
  if (!value) {
    throw officialWssBoundaryError('official_wss_untrusted_source');
  }
  return value;
}

async function validateOfficialWssLinks(context, options = {}) {
  const trust = assertSessionTrust(context);
  const seen = new Set();
  const validated = [];
  for (const value of trust.wssLinks) {
    const parsed = parseOfficialWssUrl(value);
    if (seen.has(parsed.href)) {
      continue;
    }
    seen.add(parsed.href);
    const addresses = await resolveAndValidateHostname(parsed.hostname, options);
    const link = Object.freeze({
      href: parsed.href,
      hostname: parsed.hostname,
      addresses
    });
    trustedLinkStore.set(link, trust.token);
    validated.push(link);
  }
  return Object.freeze(validated);
}

async function revalidateOfficialWssLink(context, link, options = {}) {
  const trust = assertSessionTrust(context);
  if (
    !link ||
    typeof link !== 'object' ||
    trustedLinkStore.get(link) !== trust.token ||
    typeof link.href !== 'string'
  ) {
    throw officialWssBoundaryError('official_wss_cross_session_rejected');
  }
  const parsed = parseOfficialWssUrl(link.href);
  const addresses = await resolveAndValidateHostname(parsed.hostname, options);
  const revalidated = Object.freeze({
    href: parsed.href,
    hostname: parsed.hostname,
    addresses
  });
  trustedLinkStore.set(revalidated, trust.token);
  return revalidated;
}

function getOfficialWssAuthBody(context, link) {
  const trust = assertSessionTrust(context);
  if (!link || trustedLinkStore.get(link) !== trust.token) {
    throw officialWssBoundaryError('official_wss_cross_session_rejected');
  }
  return trust.authBody;
}

module.exports = {
  MAX_WSS_LINKS,
  OFFICIAL_WSS_ALLOWLIST,
  OFFICIAL_WSS_ALLOWLIST_VERIFIED,
  OFFICIAL_WSS_DYNAMIC_TRUST_ENABLED,
  OFFICIAL_WSS_ERROR_CODE,
  OFFICIAL_WSS_EVIDENCE_VERIFIED,
  assertOfficialWssEvidenceVerified,
  assertOfficialWssUrl,
  assertPublicAddress,
  createOfficialWssSessionTrust,
  getOfficialWssAuthBody,
  isUnsafeIpv4,
  isUnsafeIpv6,
  officialWssBoundaryError,
  parseOfficialWssUrl,
  resolveAndValidateHostname,
  revalidateOfficialWssLink,
  validateOfficialWssLinks
};
