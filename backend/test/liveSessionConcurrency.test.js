const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLiveSessionService
} = require('../src/services/liveSessionService');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function syntheticSession(overrides = {}) {
  return {
    id: 1,
    public_id: '14770010-286b-4324-bff5-3908af212b47',
    site_id: 'synthetic-site',
    room_id: '10001',
    playlist_id: 1,
    title: 'Synthetic Session',
    status: 'draft',
    created_by_user_id: 42,
    started_at: null,
    paused_at: null,
    ended_at: null,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
    version: 0,
    ...overrides
  };
}

function transactionConnection(query) {
  return {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
    query
  };
}

test('same-tick duplicate draft creation crosses one controlled barrier once', async () => {
  const entryBarrier = deferred();
  const counts = { connections: 0, inserts: 0, commits: 0 };
  const pool = {
    async getConnection() {
      counts.connections += 1;
      await entryBarrier.promise;
      let publicId;
      const connection = transactionConnection(async (sql, params) => {
        if (sql.includes('FROM playlists')) return [[{ id: 1 }]];
        if (sql.includes('WHERE site_id = ?')) return [[]];
        if (sql.includes('INSERT INTO live_sessions')) {
          counts.inserts += 1;
          publicId = params[0];
          return [{ insertId: counts.inserts }];
        }
        if (sql.includes('WHERE public_id = ?')) {
          return [[syntheticSession({ public_id: publicId || params[0] })]];
        }
        throw new Error('unexpected synthetic query');
      });
      connection.commit = async () => {
        counts.commits += 1;
      };
      return connection;
    }
  };
  const service = createLiveSessionService({ pool });
  const input = {
    site_id: 'synthetic-site',
    room_id: '10001',
    playlist_id: 1,
    title: 'Synthetic Session'
  };

  const first = service.createDraft(input, 42);
  const second = service.createDraft(input, 42);
  await Promise.resolve();
  await Promise.resolve();
  const entriesBeforeRelease = counts.connections;
  entryBarrier.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(entriesBeforeRelease, 1);
  assert.equal(counts.connections, 1);
  assert.equal(counts.inserts, 1);
  assert.equal(counts.commits, 1);
  assert.equal(firstResult.public_id, secondResult.public_id);
});

test('same-tick duplicate destructive transition mutates once', async () => {
  const entryBarrier = deferred();
  const counts = { connections: 0, updates: 0, commits: 0 };
  let row = syntheticSession({ status: 'open', version: 4 });
  const pool = {
    async getConnection() {
      counts.connections += 1;
      await entryBarrier.promise;
      const connection = transactionConnection(async (sql) => {
        if (sql.includes('UPDATE live_sessions')) {
          counts.updates += 1;
          row = { ...row, status: 'closed', version: 5 };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('WHERE public_id = ?')) return [[row]];
        throw new Error('unexpected synthetic query');
      });
      connection.commit = async () => {
        counts.commits += 1;
      };
      return connection;
    }
  };
  const service = createLiveSessionService({ pool });
  const first = service.transition(row.public_id, 'closed', 4);
  const second = service.transition(row.public_id, 'closed', 4);
  await Promise.resolve();
  await Promise.resolve();
  const entriesBeforeRelease = counts.connections;
  entryBarrier.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(entriesBeforeRelease, 1);
  assert.equal(counts.connections, 1);
  assert.equal(counts.updates, 1);
  assert.equal(counts.commits, 1);
  assert.equal(firstResult.status, 'closed');
  assert.equal(secondResult.status, 'closed');
});

test('recoverable session query prefers active, restores one draft, and rejects ambiguity', async () => {
  const active = syntheticSession({ public_id: 'active-session', status: 'open' });
  const draft = syntheticSession({ public_id: 'draft-session' });
  let rows = [draft];
  const service = createLiveSessionService({
    pool: {
      async query() {
        return [rows];
      }
    }
  });

  assert.deepEqual(
    (await service.listRecoverable()).map(({ public_id }) => public_id),
    ['draft-session']
  );
  rows = [draft, active];
  assert.deepEqual(
    (await service.listRecoverable()).map(({ public_id }) => public_id),
    ['active-session']
  );
  rows = [
    draft,
    syntheticSession({ public_id: 'second-draft', id: 2 })
  ];
  await assert.rejects(
    () => service.listRecoverable(),
    { code: 'ambiguous_draft_sessions', status: 409 }
  );
  rows = [syntheticSession({ status: 'closed', ended_at: '2026-07-24T01:00:00.000Z' })];
  assert.deepEqual(await service.listRecoverable(), []);
});

test('failed transition releases its resource guard and allows a legal retry', async () => {
  const counts = { commits: 0, connections: 0, rollbacks: 0, updates: 0 };
  let failNextRead = true;
  let row = syntheticSession({ status: 'open', version: 4 });
  const pool = {
    async getConnection() {
      counts.connections += 1;
      const connection = transactionConnection(async (sql) => {
        if (sql.includes('WHERE public_id = ?') && failNextRead) {
          failNextRead = false;
          throw new Error('synthetic_transition_failure');
        }
        if (sql.includes('UPDATE live_sessions')) {
          counts.updates += 1;
          row = { ...row, status: 'closed', version: 5 };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('WHERE public_id = ?')) return [[row]];
        throw new Error('unexpected synthetic query');
      });
      connection.commit = async () => {
        counts.commits += 1;
      };
      connection.rollback = async () => {
        counts.rollbacks += 1;
      };
      return connection;
    }
  };
  const service = createLiveSessionService({ pool });

  const first = service.transition(row.public_id, 'closed', 4);
  const duplicate = service.transition(row.public_id, 'closed', 4);
  const failed = await Promise.allSettled([first, duplicate]);
  assert.deepEqual(failed.map(({ status }) => status), ['rejected', 'rejected']);
  assert.equal(counts.connections, 1);
  assert.equal(counts.rollbacks, 1);
  assert.equal(counts.updates, 0);

  const retried = await service.transition(row.public_id, 'closed', 4);
  assert.equal(retried.status, 'closed');
  assert.equal(counts.connections, 2);
  assert.equal(counts.commits, 1);
  assert.equal(counts.updates, 1);
});

test('different sessions enter independently while conflicting actions share one resource guard', async () => {
  const entryBarrier = deferred();
  const counts = { connections: 0, updates: 0 };
  const rows = new Map([
    ['14770010-286b-4324-bff5-3908af212b47', syntheticSession({
      public_id: '14770010-286b-4324-bff5-3908af212b47',
      status: 'open',
      version: 4
    })],
    ['8e3cb51c-f07a-4f75-a47d-80b4272ff964', syntheticSession({
      id: 2,
      public_id: '8e3cb51c-f07a-4f75-a47d-80b4272ff964',
      status: 'open',
      version: 7
    })]
  ]);
  const pool = {
    async getConnection() {
      counts.connections += 1;
      await entryBarrier.promise;
      let current;
      return transactionConnection(async (sql, params) => {
        if (sql.includes('WHERE public_id = ?')) {
          current = rows.get(params[0]) || current;
          return [[current]];
        }
        if (sql.includes('UPDATE live_sessions')) {
          counts.updates += 1;
          current = { ...current, status: 'closed', version: current.version + 1 };
          rows.set(current.public_id, current);
          return [{ affectedRows: 1 }];
        }
        throw new Error('unexpected synthetic query');
      });
    }
  };
  const service = createLiveSessionService({ pool });
  const first = service.transition('14770010-286b-4324-bff5-3908af212b47', 'closed', 4);
  const independent = service.transition('8e3cb51c-f07a-4f75-a47d-80b4272ff964', 'closed', 7);
  const conflicting = service.transition('14770010-286b-4324-bff5-3908af212b47', 'paused', 4);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(counts.connections, 2);
  await assert.rejects(conflicting, {
    code: 'session_operation_pending',
    status: 409
  });
  entryBarrier.resolve();
  const results = await Promise.all([first, independent]);
  assert.deepEqual(results.map(({ status }) => status), ['closed', 'closed']);
  assert.equal(counts.updates, 2);
});

test('existing draft is returned without creating a duplicate session', async () => {
  const existing = syntheticSession({ public_id: '14770010-286b-4324-bff5-3908af212b47' });
  let inserts = 0;
  const pool = {
    async getConnection() {
      return transactionConnection(async (sql) => {
        if (sql.includes('FROM playlists')) return [[{ id: 1 }]];
        if (sql.includes('WHERE site_id = ?')) return [[existing]];
        if (sql.includes('INSERT INTO live_sessions')) {
          inserts += 1;
          return [{ insertId: 2 }];
        }
        throw new Error('unexpected synthetic query');
      });
    }
  };
  const service = createLiveSessionService({ pool });
  const result = await service.createDraft({
    site_id: existing.site_id,
    room_id: existing.room_id,
    playlist_id: existing.playlist_id,
    title: existing.title
  }, existing.created_by_user_id);

  assert.equal(result.public_id, existing.public_id);
  assert.equal(inserts, 0);
});
