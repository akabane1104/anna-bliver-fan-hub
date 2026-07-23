#!/usr/bin/env node

const crypto = require('node:crypto');
const path = require('node:path');
const { assertLoopbackBaseUrl } = require('./httpClient');
const { safeFailure } = require('./redaction');
const { runScenarios } = require('./runner');
const { selectScenarios } = require('./scenarios');

const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:5000',
  fixture: 'phase4d-synthetic-session',
  roomId: '99000000000000000001',
  scenario: 'all',
  siteId: 'phase4d-synthetic'
});

function argumentError(code) {
  const error = new Error('Invalid simulator arguments');
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!['dry-run', 'run'].includes(mode)) throw argumentError('invalid_mode');
  const values = {
    mode,
    baseUrl: DEFAULTS.baseUrl,
    fixture: DEFAULTS.fixture,
    json: false,
    roomId: DEFAULTS.roomId,
    runId: `run-${crypto.randomBytes(6).toString('hex')}`,
    scenario: DEFAULTS.scenario,
    siteId: DEFAULTS.siteId
  };
  const supported = new Map([
    ['--base-url', 'baseUrl'],
    ['--fixture', 'fixture'],
    ['--room-id', 'roomId'],
    ['--run-id', 'runId'],
    ['--scenario', 'scenario'],
    ['--site-id', 'siteId'],
    ['--target', 'siteId']
  ]);

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--json') {
      values.json = true;
      continue;
    }
    if (token === '--secret' || token.startsWith('--secret=')) {
      throw argumentError('secret_argument_forbidden');
    }
    const key = supported.get(token);
    if (!key || index + 1 >= rest.length || rest[index + 1].startsWith('--')) {
      throw argumentError('invalid_argument');
    }
    values[key] = rest[index + 1];
    index += 1;
  }
  return values;
}

function backendValidator() {
  const validatorPath = path.resolve(
    __dirname,
    '../../../backend/src/schemas/liveEventSchema.js'
  );
  return require(validatorPath).validateLiveEvent;
}

function validateScenarios(scenarios) {
  const validate = backendValidator();
  let eventCount = 0;
  for (const currentScenario of scenarios) {
    for (const currentStep of currentScenario.steps) {
      eventCount += 1;
      if (!validate(currentStep.event).success) {
        const error = new Error('Synthetic event failed the backend schema');
        error.code = 'invalid_synthetic_fixture';
        throw error;
      }
    }
  }
  return eventCount;
}

function printResult(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    process.stdout.write(`${key}=${Array.isArray(item) ? item.join(',') : item}\n`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  const wantsJson = argv.includes('--json');
  try {
    options = parseArguments(argv);
    assertLoopbackBaseUrl(options.baseUrl);
    const now = new Date().toISOString();
    const config = {
      fixture: options.fixture,
      now,
      roomId: options.roomId,
      runId: options.runId,
      siteId: options.siteId
    };
    const scenarios = selectScenarios(config, options.scenario);
    const eventCount = validateScenarios(scenarios);

    if (options.mode === 'dry-run') {
      printResult({
        mode: 'dry-run',
        scenarios: scenarios.map((entry) => entry.name),
        scenario_count: scenarios.length,
        event_count: eventCount,
        http_requests: 0
      }, options.json);
      return 0;
    }

    const secret = String(env.LIVE_EVENT_INGEST_SECRET || '');
    const summary = await runScenarios({
      baseUrl: options.baseUrl,
      secret,
      scenarios
    });
    printResult(summary, options.json);
    return 0;
  } catch (error) {
    printResult(safeFailure(error, error?.scenario || null), wantsJson);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  DEFAULTS,
  backendValidator,
  main,
  parseArguments,
  validateScenarios
};
