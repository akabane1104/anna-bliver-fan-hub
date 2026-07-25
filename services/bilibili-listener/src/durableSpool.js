const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateLiveEvent
} = require('../../../backend/src/schemas/liveEventSchema');
const { listenerError } = require('./errors');

const SPOOL_VERSION = 1;
const ENTRY_PATTERN = /^[a-f0-9]{64}\.json$/;
const QUARANTINE_REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

function eventKey(eventId) {
  return crypto.createHash('sha256').update(eventId, 'utf8').digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows ACLs and mounted Docker volumes may not expose POSIX modes.
  }
}

function writeAtomicJson(targetPath, value, temporaryDirectory) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const temporaryPath = path.join(
    temporaryDirectory,
    `${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (descriptor !== null && descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original write error remains authoritative.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
  return body.length;
}

class DurableEventSpool {
  constructor({
    dataDir,
    maxEntries,
    maxBytes,
    maxEntryBytes,
    clock = Date.now
  }) {
    if (!dataDir || !path.isAbsolute(dataDir)) {
      throw listenerError('invalid_listener_data_dir');
    }
    this.dataDir = dataDir;
    this.pendingDir = path.join(dataDir, 'pending');
    this.quarantineDir = path.join(dataDir, 'quarantine');
    this.temporaryDir = path.join(dataDir, 'tmp');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.clock = clock;
    this.pendingCount = 0;
    this.pendingBytes = 0;
    this.quarantineCount = 0;
  }

  initialize(prepare) {
    ensurePrivateDirectory(this.dataDir);
    ensurePrivateDirectory(this.pendingDir);
    ensurePrivateDirectory(this.quarantineDir);
    ensurePrivateDirectory(this.temporaryDir);
    this._quarantineAbandonedTemporaryFiles();

    const items = [];
    for (const name of fs.readdirSync(this.pendingDir).sort()) {
      const item = this._readPendingEntry(name, prepare);
      if (item) items.push(item);
    }
    this._refreshSnapshot();
    return Object.freeze(items);
  }

  persist(event, prepare) {
    const validation = validateLiveEvent(event);
    if (!validation.success) throw listenerError('invalid_event_schema');
    const prepared = prepare(validation.data);
    const key = eventKey(prepared.eventId);
    const targetPath = path.join(this.pendingDir, `${key}.json`);
    if (fs.existsSync(targetPath)) {
      const existing = this._readPendingEntry(path.basename(targetPath), prepare);
      if (!existing) throw listenerError('spool_pending_corrupt');
      if (existing.prepared.bodyHash !== prepared.bodyHash) {
        throw listenerError('pending_event_id_conflict');
      }
      return Object.freeze({
        status: 'already_pending',
        item: existing
      });
    }

    const entry = Object.freeze({
      version: SPOOL_VERSION,
      created_at: new Date(this.clock()).toISOString(),
      event: validation.data
    });
    const body = Buffer.from(JSON.stringify(entry), 'utf8');
    this._refreshSnapshot();
    if (
      body.length > this.maxEntryBytes ||
      this.pendingCount >= this.maxEntries ||
      this.pendingBytes + body.length > this.maxBytes
    ) {
      throw listenerError('spool_full');
    }
    try {
      writeAtomicJson(targetPath, entry, this.temporaryDir);
    } catch (error) {
      if (error?.code === 'ENOSPC') throw listenerError('spool_disk_full');
      throw listenerError('spool_write_failed');
    }
    this._refreshSnapshot();
    return Object.freeze({
      status: 'stored',
      item: this._itemFromEntry(key, targetPath, entry, prepared)
    });
  }

  acknowledge(item) {
    this._assertItem(item);
    try {
      fs.unlinkSync(item.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw listenerError('spool_ack_failed');
    }
    this._refreshSnapshot();
  }

  quarantine(item, reason) {
    this._assertItem(item);
    const safeReason = QUARANTINE_REASON_PATTERN.test(String(reason || ''))
      ? String(reason)
      : 'delivery_rejected';
    const target = path.join(
      this.quarantineDir,
      `${item.key}.${this.clock()}.${safeReason}.json`
    );
    try {
      fs.renameSync(item.path, target);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw listenerError('spool_quarantine_failed');
      }
    }
    this._refreshSnapshot();
  }

  snapshot() {
    this._refreshSnapshot();
    return Object.freeze({
      pending_count: this.pendingCount,
      pending_bytes: this.pendingBytes,
      quarantine_count: this.quarantineCount,
      capacity_entries: this.maxEntries,
      capacity_bytes: this.maxBytes
    });
  }

  _itemFromEntry(key, entryPath, entry, prepared) {
    return Object.freeze({
      key,
      path: entryPath,
      event: entry.event,
      prepared,
      eventFingerprint: key.slice(0, 16)
    });
  }

  _readPendingEntry(name, prepare) {
    const entryPath = path.join(this.pendingDir, name);
    if (!ENTRY_PATTERN.test(name)) {
      this._quarantinePath(entryPath, 'invalid_filename');
      return null;
    }
    try {
      const stats = fs.statSync(entryPath);
      if (!stats.isFile() || stats.size < 2 || stats.size > this.maxEntryBytes) {
        throw listenerError('invalid_spool_entry');
      }
      const raw = fs.readFileSync(entryPath, 'utf8');
      const entry = JSON.parse(raw);
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        entry.version !== SPOOL_VERSION ||
        typeof entry.created_at !== 'string' ||
        !Number.isFinite(Date.parse(entry.created_at)) ||
        Object.keys(entry).sort().join(',') !== 'created_at,event,version'
      ) {
        throw listenerError('invalid_spool_entry');
      }
      const validation = validateLiveEvent(entry.event);
      if (!validation.success) throw listenerError('invalid_spool_entry');
      const prepared = prepare(validation.data);
      const key = name.slice(0, -5);
      if (eventKey(prepared.eventId) !== key) {
        throw listenerError('invalid_spool_entry');
      }
      return this._itemFromEntry(
        key,
        entryPath,
        { ...entry, event: validation.data },
        prepared
      );
    } catch {
      this._quarantinePath(entryPath, 'corrupt');
      return null;
    }
  }

  _quarantinePath(source, reason) {
    if (!fs.existsSync(source)) return;
    const safeName = path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_');
    const target = path.join(
      this.quarantineDir,
      `${safeName}.${this.clock()}.${reason}`
    );
    try {
      fs.renameSync(source, target);
    } catch {
      throw listenerError('spool_quarantine_failed');
    }
  }

  _quarantineAbandonedTemporaryFiles() {
    for (const name of fs.readdirSync(this.temporaryDir)) {
      this._quarantinePath(path.join(this.temporaryDir, name), 'abandoned_tmp');
    }
  }

  _assertItem(item) {
    if (
      !item ||
      typeof item !== 'object' ||
      !ENTRY_PATTERN.test(`${item.key}.json`) ||
      path.dirname(item.path) !== this.pendingDir
    ) {
      throw listenerError('invalid_spool_item');
    }
  }

  _refreshSnapshot() {
    const pending = fs.existsSync(this.pendingDir)
      ? fs.readdirSync(this.pendingDir)
      : [];
    this.pendingCount = 0;
    this.pendingBytes = 0;
    for (const name of pending) {
      const entryPath = path.join(this.pendingDir, name);
      try {
        const stats = fs.statSync(entryPath);
        if (!stats.isFile()) continue;
        this.pendingCount += 1;
        this.pendingBytes += stats.size;
      } catch {
        // A concurrent rename is reflected on the next snapshot.
      }
    }
    this.quarantineCount = fs.existsSync(this.quarantineDir)
      ? fs.readdirSync(this.quarantineDir).length
      : 0;
  }
}

module.exports = {
  ENTRY_PATTERN,
  SPOOL_VERSION,
  DurableEventSpool,
  ensurePrivateDirectory,
  eventKey,
  writeAtomicJson
};
