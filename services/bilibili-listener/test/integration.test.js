const test = require('node:test');
const assert = require('node:assert/strict');
const { DryRunDelivery } = require('../src/dryRun');
const { ListenerSupervisor } = require('../src/listenerSupervisor');
const { createSyntheticAdapter } = require('../src/syntheticAdapter');
const {
  syntheticDanmaku,
  syntheticGift,
  syntheticInvalid,
  syntheticUnsupported
} = require('../src/syntheticFixtures');
const { testConfig } = require('./helpers/testConfig');

test('synthetic adapter, mapper, queue, and delivery form one offline pipeline', async () => {
  const adapter = createSyntheticAdapter();
  const delivery = new DryRunDelivery();
  const supervisor = new ListenerSupervisor({
    config: testConfig(),
    adapter,
    deliveryClient: delivery,
    logger: { write() {} }
  });
  await supervisor.start();
  const event = syntheticDanmaku('phase4e-integration-danmaku');
  await adapter.emitEvent(event);
  await adapter.emitEvent(syntheticGift('phase4e-integration-gift'));
  await adapter.emitEvent(syntheticUnsupported('phase4e-integration-unsupported'));
  await adapter.emitEvent(syntheticInvalid());
  await adapter.emitEvent(event);
  assert.equal((await supervisor.waitForIdle(500)).drained, true);
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.received, 5);
  assert.equal(snapshot.mapped, 3);
  assert.equal(snapshot.accepted, 2);
  assert.equal(snapshot.duplicate, 1);
  assert.equal(snapshot.ignored, 1);
  assert.equal(snapshot.invalid, 1);
  assert.equal(adapter.networkConnections, 0);
  await supervisor.stop();
});

test('listener MySQL access is isolated from points, orders, roles, and playlists', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '../src');
  const source = fs.readdirSync(root)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    source,
    /pointsService|point_wallets|point_accounts|point_transactions|orders|users\.role/
  );
  const repository = fs.readFileSync(
    path.join(root, 'officialLiveRepository.js'),
    'utf8'
  );
  assert.match(repository, /official_live_event_dedup/);
  assert.match(repository, /official_ai_memory/);
  assert.doesNotMatch(
    repository,
    /users|wallet|orders|products|song_requests|viewer_identity_audit/
  );
  assert.doesNotMatch(source, /点歌.*(?:parse|match)|song_requests|playlist/i);
});
