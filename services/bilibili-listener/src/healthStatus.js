const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { listenerError } = require('./errors');
const { ensurePrivateDirectory } = require('./durableSpool');

const HEALTH_VERSION = 1;

function healthPath(dataDir) {
  return path.join(dataDir, 'health.json');
}

function writeHealthSnapshot(dataDir, snapshot) {
  ensurePrivateDirectory(dataDir);
  const target = healthPath(dataDir);
  const temporary = path.join(
    dataDir,
    `.health.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  const body = Buffer.from(JSON.stringify({
    version: HEALTH_VERSION,
    ...snapshot
  }), 'utf8');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch {
    throw listenerError('listener_health_write_failed');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original health write failure remains authoritative.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
}

function readHealthSnapshot(dataDir, {
  clock = Date.now,
  maxAgeMs = 60000
} = {}) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(healthPath(dataDir), 'utf8'));
  } catch {
    throw listenerError('listener_health_unavailable');
  }
  const updatedAt = Date.parse(value?.updated_at);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== HEALTH_VERSION ||
    value.healthy !== true ||
    !Number.isFinite(updatedAt) ||
    Math.abs(clock() - updatedAt) > maxAgeMs
  ) {
    throw listenerError('listener_unhealthy');
  }
  return Object.freeze(value);
}

module.exports = {
  HEALTH_VERSION,
  healthPath,
  readHealthSnapshot,
  writeHealthSnapshot
};
