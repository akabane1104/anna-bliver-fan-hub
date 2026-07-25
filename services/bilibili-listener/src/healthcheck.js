#!/usr/bin/env node

const { readHealthSnapshot } = require('./healthStatus');

try {
  readHealthSnapshot(String(process.env.LISTENER_DATA_DIR || ''));
  process.exitCode = 0;
} catch {
  process.exitCode = 1;
}
