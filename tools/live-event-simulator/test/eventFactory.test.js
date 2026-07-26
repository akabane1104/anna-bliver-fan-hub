const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildCoreScenarios, buildRollbackScenario } = require('../src/scenarios');

const { validateLiveEvent } = require(path.resolve(
  __dirname,
  '../../../backend/src/schemas/liveEventSchema.js'
));

function config() {
  return {
    fixture: 'phase4d-synthetic-session',
    now: '2026-07-23T08:00:00.000Z',
    roomId: '99000000000000000001',
    runId: 'unit-fixtures',
    siteId: 'phase4d-synthetic'
  };
}

test('all core fixtures pass the existing Phase 4B strict schema', () => {
  const scenarios = buildCoreScenarios(config());
  assert.equal(scenarios.length, 11);
  assert.equal(scenarios.reduce((count, item) => count + item.steps.length, 0), 16);
  assert.equal(
    scenarios.reduce((count, item) => count + item.expected_song_requests, 0),
    8
  );

  for (const currentScenario of scenarios) {
    for (const currentStep of currentScenario.steps) {
      const result = validateLiveEvent(currentStep.event);
      assert.equal(result.success, true, currentScenario.name);
      assert.match(currentStep.event.site_id, /^phase4d-/);
      assert.match(currentStep.event.room_id, /^99/);
      assert.match(currentStep.event.actor.open_id, /^phase4d\.synthetic\./);
      assert.equal(currentStep.event.mode, 'simulation');
    }
  }
});

test('duplicate reuses identical bytes while conflict changes only normalized content identity', () => {
  const scenarios = buildCoreScenarios(config());
  const duplicate = scenarios.find((item) => item.name === 'duplicate');
  const conflict = scenarios.find((item) => item.name === 'conflict');

  assert.equal(
    JSON.stringify(duplicate.steps[0].event),
    JSON.stringify(duplicate.steps[1].event)
  );
  assert.equal(conflict.steps[0].event.event_id, conflict.steps[1].event.event_id);
  assert.notEqual(
    JSON.stringify(conflict.steps[0].event),
    JSON.stringify(conflict.steps[1].event)
  );
});

test('rollback fixture is schema-valid and expects the stable database error ACK', () => {
  const rollback = buildRollbackScenario(config());
  assert.equal(validateLiveEvent(rollback.steps[0].event).success, true);
  assert.deepEqual(rollback.steps[0].expect, {
    httpStatus: 500,
    status: 'rejected',
    reason: 'database_error'
  });
});
