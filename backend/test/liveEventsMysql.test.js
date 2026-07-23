const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const {
  createLiveEventService,
  createMysqlLiveEventRepository
} = require('../src/services/liveEventService');
const { validateLiveEvent } = require('../src/schemas/liveEventSchema');

const CONFIRMATION = 'phase4b-isolated-live-events';
const integrationEnabled = process.env.PHASE4B_TEST_DB_CONFIRM === CONFIRMATION;

function integrationEvent(eventId, text) {
  const parsed = validateLiveEvent({
    schema_version: '1.0',
    event_id: eventId,
    event_type: 'danmaku',
    site_id: 'phase4b-test',
    room_id: '900719925474099312345',
    mode: 'simulation',
    source: {
      platform: 'bilibili_live_open',
      cmd: 'LIVE_OPEN_PLATFORM_DM',
      message_id: `${eventId}:message`,
      session_id: 'phase4b-isolated-session'
    },
    actor: {
      open_id: 'phase4b_synthetic_open_id',
      display_name: 'Synthetic Actor'
    },
    occurred_at: '2026-07-23T00:00:00.000Z',
    received_at: '2026-07-23T00:00:01.000Z',
    payload: { text, dm_type: 'text' },
    delivery: { attempt: 1, replay: false }
  });
  assert.equal(parsed.success, true);
  return parsed.data;
}

test('isolated MySQL validates live event idempotency and leaves legacy tables untouched', {
  skip: !integrationEnabled
}, async () => {
  const host = process.env.PHASE4B_TEST_DB_HOST;
  const port = Number(process.env.PHASE4B_TEST_DB_PORT);
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port <= 0 || port === 3306) {
    throw new Error('Refusing integration test without an isolated loopback port other than 3306');
  }

  const pool = mysql.createPool({
    host,
    port,
    user: 'root',
    password: '',
    database: 'anna_bliver_fan_hub',
    connectionLimit: 4,
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  try {
    const legacyTables = [
      'point_wallets',
      'point_accounts',
      'point_account_transactions',
      'bilibili_point_events'
    ];
    const before = new Map();
    for (const table of legacyTables) {
      const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      before.set(table, Number(rows[0].count));
    }

    const service = createLiveEventService({
      repository: createMysqlLiveEventRepository(pool)
    });
    const prefix = `phase4b:${Date.now()}`;
    const event = integrationEvent(`${prefix}:same`, 'Synthetic database event');
    assert.equal((await service.record(event)).status, 'accepted');
    assert.equal((await service.record(event)).status, 'duplicate');

    const conflict = integrationEvent(`${prefix}:same`, 'Changed synthetic database event');
    const conflictResult = await service.record(conflict);
    assert.equal(conflictResult.status, 'rejected');
    assert.equal(conflictResult.reason, 'event_id_conflict');
    assert.match(conflictResult.contentHash, /^[a-f0-9]{64}$/);

    const concurrent = integrationEvent(`${prefix}:concurrent`, 'Concurrent synthetic event');
    const results = await Promise.all([
      service.record(concurrent),
      service.record(concurrent)
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['accepted', 'duplicate']);

    const [sameRows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM live_events WHERE event_id IN (?, ?)',
      [event.event_id, concurrent.event_id]
    );
    assert.equal(Number(sameRows[0].count), 2);

    for (const table of legacyTables) {
      const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
      assert.equal(Number(rows[0].count), before.get(table), table);
    }
  } finally {
    await pool.end();
  }
});
