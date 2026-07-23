const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, safeFailure } = require('../src/redaction');

test('redaction removes credentials, platform identifiers, headers, and raw bodies', () => {
  const sensitive = {
    secret: 'phase4d-secret-must-not-appear',
    signature: 'phase4d-signature-must-not-appear',
    authorization: 'Bearer phase4d-token-must-not-appear',
    cookie: 'phase4d-cookie-must-not-appear',
    actor: {
      open_id: 'phase4d-open-id-must-not-appear',
      display_name: 'Synthetic Viewer'
    },
    raw_body: 'phase4d-body-must-not-appear',
    headers: {
      token: 'phase4d-nested-token-must-not-appear'
    }
  };
  const serialized = JSON.stringify(redact(sensitive));

  assert.doesNotMatch(serialized, /must-not-appear/);
  assert.match(serialized, /Synthetic Viewer/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('safe failures expose only stable error metadata', () => {
  const error = new Error('secret phase4d-secret-must-not-appear');
  error.code = 'synthetic_failure';
  error.headers = { authorization: 'must-not-appear' };
  assert.deepEqual(safeFailure(error, 'synthetic-scenario'), {
    status: 'failed',
    scenario: 'synthetic-scenario',
    error_code: 'synthetic_failure'
  });
});
