const { createDanmakuEvent, createGiftEvent } = require('./eventFactory');

const ACK = Object.freeze({
  accepted: Object.freeze({ httpStatus: 201, status: 'accepted' }),
  duplicate: Object.freeze({ httpStatus: 200, status: 'duplicate' }),
  conflict: Object.freeze({
    httpStatus: 409,
    status: 'rejected',
    reason: 'event_id_conflict'
  }),
  databaseError: Object.freeze({
    httpStatus: 500,
    status: 'rejected',
    reason: 'database_error'
  })
});

function step(event, expect) {
  return Object.freeze({ event, expect });
}

function scenario(name, expectedSongRequests, steps) {
  return Object.freeze({
    name,
    expected_song_requests: expectedSongRequests,
    steps: Object.freeze(steps)
  });
}

function buildCoreScenarios(config) {
  const duplicateEvent = createDanmakuEvent({
    config,
    scenario: 'duplicate',
    step: 1,
    actorKey: 'viewer-duplicate',
    text: '点歌 Simulator Duplicate'
  });
  const conflictOriginal = createDanmakuEvent({
    config,
    scenario: 'conflict',
    step: 1,
    actorKey: 'viewer-conflict',
    text: '点歌 Simulator Conflict'
  });
  const conflictChanged = createDanmakuEvent({
    config,
    scenario: 'conflict',
    step: 1,
    actorKey: 'viewer-conflict',
    text: '点歌 不同的合成冲突曲目'
  });

  return Object.freeze([
    scenario('simplified-request', 1, [
      step(createDanmakuEvent({
        config,
        scenario: 'simplified-request',
        step: 1,
        actorKey: 'viewer-simple',
        text: '点歌 年轮'
      }), ACK.accepted)
    ]),
    scenario('traditional-request', 0, [
      step(createDanmakuEvent({
        config,
        scenario: 'traditional-request',
        step: 1,
        actorKey: 'viewer-traditional',
        text: '點歌 年輪'
      }), ACK.accepted)
    ]),
    scenario('ordinary-chat', 0, [
      step(createDanmakuEvent({
        config,
        scenario: 'ordinary-chat',
        step: 1,
        actorKey: 'viewer-chat',
        text: '今天想唱什么'
      }), ACK.accepted)
    ]),
    scenario('playback-command-rejected', 0, [
      step(createDanmakuEvent({
        config,
        scenario: 'playback-command-rejected',
        step: 1,
        actorKey: 'viewer-playback',
        text: '播放 年轮'
      }), ACK.accepted)
    ]),
    scenario('missing-space', 0, [
      step(createDanmakuEvent({
        config,
        scenario: 'missing-space',
        step: 1,
        actorKey: 'viewer-spacing',
        text: '点歌年轮'
      }), ACK.accepted)
    ]),
    scenario('unmatched-song', 1, [
      step(createDanmakuEvent({
        config,
        scenario: 'unmatched-song',
        step: 1,
        actorKey: 'viewer-unmatched',
        text: '点歌 不存在的合成曲目'
      }), ACK.accepted)
    ]),
    scenario('case-variants', 3, [
      step(createDanmakuEvent({
        config,
        scenario: 'case-variants',
        step: 1,
        actorKey: 'viewer-lowercase',
        text: '点歌 fancy'
      }), ACK.accepted),
      step(createDanmakuEvent({
        config,
        scenario: 'case-variants',
        step: 2,
        actorKey: 'viewer-uppercase',
        text: '点歌 FANCY'
      }), ACK.accepted),
      step(createDanmakuEvent({
        config,
        scenario: 'case-variants',
        step: 3,
        actorKey: 'viewer-mixedcase',
        text: '点歌 Fancy'
      }), ACK.accepted)
    ]),
    scenario('duplicate', 1, [
      step(duplicateEvent, ACK.accepted),
      step(duplicateEvent, ACK.duplicate)
    ]),
    scenario('conflict', 1, [
      step(conflictOriginal, ACK.accepted),
      step(conflictChanged, ACK.conflict)
    ]),
    scenario('same-song-viewers', 1, [
      step(createDanmakuEvent({
        config,
        scenario: 'same-song-viewers',
        step: 1,
        actorKey: 'viewer-one',
        text: '点歌 Simulator Shared'
      }), ACK.accepted),
      step(createDanmakuEvent({
        config,
        scenario: 'same-song-viewers',
        step: 2,
        actorKey: 'viewer-two',
        text: '点歌 Simulator Shared'
      }), ACK.accepted)
    ]),
    scenario('gift-event', 0, [
      step(createGiftEvent({
        config,
        scenario: 'gift-event',
        step: 1,
        actorKey: 'viewer-gift'
      }), ACK.accepted)
    ])
  ]);
}

function buildRollbackScenario(config) {
  return scenario('transaction-rollback', 0, [
    step(createDanmakuEvent({
      config,
      scenario: 'transaction-rollback',
      step: 1,
      actorKey: 'viewer-rollback',
      text: '点歌 Simulator Rollback'
    }), ACK.databaseError)
  ]);
}

function selectScenarios(config, requestedName) {
  const core = buildCoreScenarios(config);
  if (requestedName === 'all') return core;
  if (requestedName === 'transaction-rollback') return [buildRollbackScenario(config)];
  const selected = core.find((entry) => entry.name === requestedName);
  if (!selected) {
    const error = new Error('Unknown simulator scenario');
    error.code = 'unknown_scenario';
    throw error;
  }
  return [selected];
}

module.exports = {
  ACK,
  buildCoreScenarios,
  buildRollbackScenario,
  selectScenarios
};
