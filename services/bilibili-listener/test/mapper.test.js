const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mapSourceEvent } = require('../src/eventMapper');
const {
  syntheticDanmaku,
  syntheticGift,
  syntheticInvalid,
  syntheticUnsupported
} = require('../src/syntheticFixtures');
const { testConfig } = require('./helpers/testConfig');

test('synthetic danmaku maps through the existing Backend schema', () => {
  const result = mapSourceEvent(
    syntheticDanmaku('phase4e-mapper-danmaku', '点歌 年轮'),
    testConfig()
  );
  assert.equal(result.status, 'mapped');
  assert.equal(result.event.event_type, 'danmaku');
  assert.equal(result.event.payload.text, '点歌 年轮');
  assert.equal(result.event.event_id, 'synthetic:99000000000000000002:phase4e-mapper-danmaku');
  assert.match(result.eventFingerprint, /^[a-f0-9]{16}$/);
});

test('synthetic gift preserves source units and never adds points fields', () => {
  const result = mapSourceEvent(
    syntheticGift('phase4e-mapper-gift'),
    testConfig()
  );
  assert.equal(result.event.payload.price, '1000');
  assert.equal(result.event.payload.price_unit, 'bilibili_price');
  assert.equal('points' in result.event.payload, false);
  assert.equal('uid' in result.event.actor, false);
});

test('unsupported source events are explicitly ignored', () => {
  assert.deepEqual(
    mapSourceEvent(
      syntheticUnsupported('phase4e-mapper-unsupported'),
      testConfig()
    ),
    { status: 'ignored', reason: 'unsupported_source_event' }
  );
});

test('missing stable provider identity and malformed source data are rejected', () => {
  assert.throws(
    () => mapSourceEvent(syntheticInvalid(), testConfig()),
    { code: 'unstable_provider_event_id' }
  );
  const malformed = syntheticDanmaku('phase4e-mapper-malformed');
  malformed.data.text = '';
  assert.throws(
    () => mapSourceEvent(malformed, testConfig()),
    { code: 'invalid_source_event' }
  );
});

test('the same decoded source event produces stable event id and body content', () => {
  const source = syntheticDanmaku('phase4e-mapper-stable');
  const first = mapSourceEvent(source, testConfig());
  const second = mapSourceEvent(source, testConfig());
  assert.equal(first.event.event_id, second.event.event_id);
  assert.equal(JSON.stringify(first.event), JSON.stringify(second.event));
});

test('mapper imports the Backend validator instead of defining a second schema', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/eventMapper.js'),
    'utf8'
  );
  assert.match(source, /backend\/src\/schemas\/liveEventSchema/);
  assert.doesNotMatch(source, /require\(['"]zod['"]\)|z\.object|z\.union/);
});

test('raw text and platform identity never become the log fingerprint', () => {
  const source = syntheticDanmaku(
    'phase4e-mapper-private',
    'SYNTHETIC_TEXT_MUST_NOT_BECOME_FINGERPRINT'
  );
  const result = mapSourceEvent(source, testConfig());
  assert.doesNotMatch(result.eventFingerprint, /SYNTHETIC|phase4e\.synthetic/);
});
