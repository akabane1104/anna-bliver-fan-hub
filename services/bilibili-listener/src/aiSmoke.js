const mysql = require('mysql2/promise');
const { loadOfficialLiveConfig } = require('./config');
const {
  createOpenAiClient,
  requiredDatabaseConfig
} = require('./officialLiveRuntime');
const { createSafeLogger } = require('./logger');
const { OfficialLiveRepository } = require('./officialLiveRepository');
const { PortkeyAiAssistant } = require('./portkeyAiAssistant');

async function runAiSmoke({
  env = process.env,
  stdout = process.stdout
} = {}) {
  const config = loadOfficialLiveConfig(env);
  if (!config.aiEnabled) {
    stdout.write('status=disabled\n');
    return 1;
  }
  const pool = mysql.createPool({
    ...requiredDatabaseConfig(env),
    connectionLimit: 2,
    queueLimit: 2
  });
  const repository = new OfficialLiveRepository({ pool });
  const assistant = new PortkeyAiAssistant({
    config,
    repository,
    logger: createSafeLogger(),
    client: createOpenAiClient(config)
  });
  const syntheticIdentity = `synthetic-${process.pid}-${Date.now()}`;
  let result = null;
  let cleanupCount = 0;
  try {
    result = await assistant.handleCommand({
      text: '!ai测试 用一句简短的话问候直播间',
      openId: syntheticIdentity,
      synthetic: true
    });
  } finally {
    cleanupCount = await assistant
      .deleteSyntheticMemory(syntheticIdentity)
      .catch(() => -1);
    await pool.end().catch(() => {});
  }
  stdout.write(`${JSON.stringify({
    status: result?.status || 'failed',
    output_length: Number(result?.outputLength || 0),
    duration_ms: Number(result?.durationMs || 0),
    error_code: result?.errorCode || null,
    synthetic_memory_deleted: cleanupCount === 2
  })}\n`);
  return result?.status === 'success' && cleanupCount === 2 ? 0 : 1;
}

if (require.main === module) {
  runAiSmoke().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  runAiSmoke
};
