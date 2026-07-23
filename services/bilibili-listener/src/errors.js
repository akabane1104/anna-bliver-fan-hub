const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

function listenerError(code) {
  const normalized = ERROR_CODE_PATTERN.test(String(code || ''))
    ? String(code)
    : 'listener_error';
  const error = new Error('Listener operation failed');
  error.code = normalized;
  return error;
}

function safeErrorCode(error, fallback = 'listener_error') {
  const code = String(error?.code || '');
  return ERROR_CODE_PATTERN.test(code) ? code : fallback;
}

module.exports = {
  ERROR_CODE_PATTERN,
  listenerError,
  safeErrorCode
};
