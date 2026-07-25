const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { listenerError } = require('./errors');
const { ensurePrivateDirectory } = require('./durableSpool');

function unlinkIfPresent(target) {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function probeUnixSocket(socketPath, netImpl = net) {
  return new Promise((resolve) => {
    const socket = netImpl.createConnection(socketPath);
    const finish = (active) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(active);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function acquireUnixSocketLock(dataDir, { netImpl = net } = {}) {
  const socketPath = path.join(dataDir, 'listener-instance.sock');
  if (fs.existsSync(socketPath)) {
    if (await probeUnixSocket(socketPath, netImpl)) {
      throw listenerError('listener_instance_already_running');
    }
    unlinkIfPresent(socketPath);
  }

  const server = netImpl.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  }).catch((error) => {
    if (error?.code === 'EADDRINUSE') {
      throw listenerError('listener_instance_already_running');
    }
    throw listenerError('listener_instance_lock_failed');
  });
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    // Docker's Linux runtime enforces this; other filesystems may not expose it.
  }

  let released = false;
  return Object.freeze({
    path: socketPath,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolve) => server.close(resolve));
      unlinkIfPresent(socketPath);
    }
  });
}

function acquireWindowsFileLock(dataDir) {
  const lockPath = path.join(dataDir, 'listener-instance.lock');
  const token = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      token
    }));
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw listenerError('listener_instance_already_running');
    }
    throw listenerError('listener_instance_lock_failed');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  let released = false;
  return Object.freeze({
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (value.token === token) unlinkIfPresent(lockPath);
      } catch {
        // A changed lock is never removed by the former owner.
      }
    }
  });
}

async function acquireInstanceLock(dataDir, options = {}) {
  ensurePrivateDirectory(dataDir);
  if (options.platform === 'win32' || process.platform === 'win32') {
    return acquireWindowsFileLock(dataDir);
  }
  return acquireUnixSocketLock(dataDir, options);
}

module.exports = {
  acquireInstanceLock,
  acquireUnixSocketLock,
  acquireWindowsFileLock,
  probeUnixSocket,
  unlinkIfPresent
};
