const { listenerError } = require('./errors');

const MAX_WSS_LINKS = 5;
const OFFICIAL_WSS_ERROR_CODE = 'official_wss_allowlist_unverified';
const OFFICIAL_WSS_EVIDENCE_VERIFIED = false;
const OFFICIAL_WSS_ALLOWLIST = Object.freeze([]);
const OFFICIAL_WSS_ALLOWLIST_VERIFIED = false;

function officialWssBoundaryError() {
  const error = listenerError(OFFICIAL_WSS_ERROR_CODE);
  error.fatal = true;
  return error;
}

function assertOfficialWssEvidenceVerified() {
  throw officialWssBoundaryError();
}

function assertOfficialWssUrl(value) {
  void value;
  return assertOfficialWssEvidenceVerified();
}

function validateOfficialWssLinks(values) {
  void values;
  return assertOfficialWssEvidenceVerified();
}

module.exports = {
  MAX_WSS_LINKS,
  OFFICIAL_WSS_ALLOWLIST,
  OFFICIAL_WSS_ALLOWLIST_VERIFIED,
  OFFICIAL_WSS_ERROR_CODE,
  OFFICIAL_WSS_EVIDENCE_VERIFIED,
  assertOfficialWssEvidenceVerified,
  assertOfficialWssUrl,
  officialWssBoundaryError,
  validateOfficialWssLinks
};
