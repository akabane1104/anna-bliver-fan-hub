class SongRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SongRequestError';
    this.status = status;
    this.code = code;
  }
}

function assertExpectedVersion(actual, expected) {
  if (Number(actual) !== Number(expected)) {
    throw new SongRequestError(409, 'version_conflict', '资源版本已过期，请刷新后重试');
  }
}

module.exports = { SongRequestError, assertExpectedVersion };
