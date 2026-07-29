const crypto = require('node:crypto');
const { listenerError } = require('./errors');

function createLockName(siteId) {
  const digest = crypto
    .createHash('sha256')
    .update(String(siteId), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `anna-bliver:official-live:${digest}`;
}

class MysqlSessionLock {
  constructor({
    connectionFactory,
    connectionOptions,
    siteId
  }) {
    if (typeof connectionFactory !== 'function') {
      throw listenerError('invalid_mysql_lock_factory');
    }
    this.connectionFactory = connectionFactory;
    this.connectionOptions = connectionOptions;
    this.lockName = createLockName(siteId);
    this.connection = null;
    this.connectionId = null;
    this.held = false;
  }

  async acquire() {
    if (this.held) return true;
    if (!this.connection) {
      this.connection = await this.connectionFactory(this.connectionOptions);
    }
    try {
      const [connectionRows] = await this.connection.query(
        'SELECT CONNECTION_ID() AS connection_id'
      );
      const connectionId = Number(connectionRows?.[0]?.connection_id);
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        throw listenerError('invalid_mysql_lock_connection');
      }
      const [rows] = await this.connection.execute(
        'SELECT GET_LOCK(?, 0) AS acquired',
        [this.lockName]
      );
      this.connectionId = connectionId;
      this.held = Number(rows?.[0]?.acquired) === 1;
      return this.held;
    } catch (error) {
      await this._close();
      throw error;
    }
  }

  async isHeld() {
    if (!this.connection || !this.held || !this.connectionId) return false;
    try {
      const [rows] = await this.connection.execute(
        'SELECT IS_USED_LOCK(?) AS owner_id',
        [this.lockName]
      );
      const ownerId = Number(rows?.[0]?.owner_id);
      this.held = Number.isSafeInteger(ownerId) && ownerId === this.connectionId;
      return this.held;
    } catch {
      this.held = false;
      return false;
    }
  }

  async release() {
    if (this.connection && this.held) {
      try {
        await this.connection.execute(
          'SELECT RELEASE_LOCK(?) AS released',
          [this.lockName]
        );
      } catch {
        // Closing the dedicated connection releases the advisory lock.
      }
    }
    await this._close();
  }

  async _close() {
    const connection = this.connection;
    this.connection = null;
    this.connectionId = null;
    this.held = false;
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}

module.exports = {
  MysqlSessionLock,
  createLockName
};
