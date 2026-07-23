const { postSignedEvent } = require('./httpClient');

function expectationMatches(actual, expected) {
  return (
    actual.httpStatus === expected.httpStatus &&
    actual.status === expected.status &&
    (expected.reason === undefined || actual.reason === expected.reason)
  );
}

async function runScenarios({
  baseUrl,
  secret,
  scenarios,
  postEvent = postSignedEvent
}) {
  const summary = {
    mode: 'run',
    scenario_count: scenarios.length,
    scenario_passed: 0,
    scenario_failed: 0,
    request_count: 0,
    accepted: 0,
    duplicate: 0,
    conflict: 0,
    database_error: 0,
    expected_song_requests: scenarios.reduce(
      (total, item) => total + item.expected_song_requests,
      0
    ),
    non_request_steps: 0
  };

  for (const currentScenario of scenarios) {
    let scenarioPassed = true;
    for (const currentStep of currentScenario.steps) {
      summary.request_count += 1;
      const actual = await postEvent({
        baseUrl,
        secret,
        event: currentStep.event
      });
      if (!expectationMatches(actual, currentStep.expect)) {
        const error = new Error('Scenario ACK assertion failed');
        error.code = 'ack_assertion_failed';
        error.scenario = currentScenario.name;
        throw error;
      }
      if (actual.status === 'accepted') summary.accepted += 1;
      if (actual.status === 'duplicate') summary.duplicate += 1;
      if (actual.reason === 'event_id_conflict') summary.conflict += 1;
      if (actual.reason === 'database_error') summary.database_error += 1;
    }

    if (scenarioPassed) {
      summary.scenario_passed += 1;
    } else {
      summary.scenario_failed += 1;
    }
  }

  summary.non_request_steps = summary.request_count - summary.expected_song_requests;
  return summary;
}

module.exports = {
  expectationMatches,
  runScenarios
};
