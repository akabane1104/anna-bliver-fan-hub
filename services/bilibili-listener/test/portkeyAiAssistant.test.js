const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_OUTPUT_CHARACTERS,
  PortkeyAiAssistant,
  createViewerKey,
  parseAiCommand,
  truncateUnicode,
  unicodeLength
} = require('../src/portkeyAiAssistant');
const {
  createOpenAiClient
} = require('../src/officialLiveRuntime');

function config(overrides = {}) {
  return {
    aiEnabled: true,
    aiViewerHmacKey: 'synthetic-viewer-hmac-key-that-is-long-enough',
    aiModel: '@siliconflow/minimax-m3',
    aiMaxTokens: 96,
    aiMemoryHours: 72,
    aiContextMaxMessages: 12,
    aiViewerCooldownMs: 15000,
    aiGlobalConcurrency: 2,
    aiQueueMax: 2,
    aiBaseUrl: 'https://api.portkey.ai/v1',
    aiApiKey: 'synthetic-api-key',
    aiTimeoutMs: 10000,
    aiMaxRetries: 1,
    ...overrides
  };
}

function repository() {
  const rows = new Map();
  return {
    rows,
    async listMemory(key) {
      return rows.get(key) || [];
    },
    async appendExchange({ viewerKey, input, output }) {
      const current = rows.get(viewerKey) || [];
      current.push({ role: 'user', content: input });
      current.push({ role: 'assistant', content: output });
      rows.set(viewerKey, current);
    },
    async deleteViewerMemory(key) {
      const count = rows.get(key)?.length || 0;
      rows.delete(key);
      return count;
    }
  };
}

function client(outputs, calls = []) {
  return {
    chat: {
      completions: {
        async create(request) {
          calls.push(request);
          const output = outputs.shift();
          if (output instanceof Error) throw output;
          return output && typeof output === 'object'
            ? output
            : { choices: [{ message: { content: output } }] };
        }
      }
    }
  };
}

test('only non-empty AI command prefixes are accepted', () => {
  assert.equal(parseAiCommand('普通聊天'), null);
  assert.equal(parseAiCommand('!ai'), null);
  assert.equal(parseAiCommand('!ai '), null);
  assert.deepEqual(parseAiCommand('!ai 你好'), {
    status: 'accepted',
    body: '你好'
  });
  assert.deepEqual(parseAiCommand('!ai测试 你好'), {
    status: 'accepted',
    body: '你好'
  });
  assert.equal(
    parseAiCommand(`!ai ${'长'.repeat(201)}`).status,
    'too_long'
  );
});

test('OpenAI-compatible client pins Portkey base URL, timeout and one retry', () => {
  let options = null;
  class FakeOpenAI {
    constructor(value) {
      options = value;
    }
  }
  createOpenAiClient(config(), FakeOpenAI);
  assert.deepEqual(options, {
    baseURL: 'https://api.portkey.ai/v1',
    apiKey: 'synthetic-api-key',
    timeout: 10000,
    maxRetries: 1
  });
});

test('Chat Completions uses the exact configured model and no identity fields', async () => {
  const calls = [];
  const logs = [];
  const repo = repository();
  const assistant = new PortkeyAiAssistant({
    config: config(),
    repository: repo,
    client: client(['简短回答'], calls),
    logger: {
      write(level, code, fields) {
        logs.push({ level, code, fields });
      }
    }
  });
  const result = await assistant.handleCommand({
    text: '!ai 测试问题',
    openId: 'synthetic-open-id'
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, '@siliconflow/minimax-m3');
  assert.equal(calls[0].max_tokens, 96);
  const serialized = JSON.stringify(calls[0]);
  for (const forbidden of [
    'open_id',
    'union_id',
    'room_id',
    'uid',
    'nickname',
    'synthetic-open-id'
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(logs[0].code, 'ai_local_output');
  assert.equal(logs[0].fields.output, '简短回答');
});

test('overlong response is shortened once and then Unicode-truncated safely', async () => {
  const calls = [];
  const assistant = new PortkeyAiAssistant({
    config: config(),
    repository: repository(),
    client: client([
      `${'中'.repeat(45)}🙂`,
      `${'答'.repeat(45)}🙂`
    ], calls)
  });
  const result = await assistant.handleCommand({
    text: '!ai 测试',
    openId: 'viewer-one'
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, 'success');
  assert.equal(result.outputLength, MAX_OUTPUT_CHARACTERS);
  assert.equal(unicodeLength(result.output), 40);
  assert.equal(truncateUnicode('中文，🙂。', 4), '中文，🙂');
});

test('missing Chat Completions content fails closed', async () => {
  const assistant = new PortkeyAiAssistant({
    config: config(),
    repository: repository(),
    client: client([{ choices: [] }])
  });
  const result = await assistant.handleCommand({
    text: '!ai 测试',
    openId: 'viewer-two'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'INVALID_AI_RESPONSE');
});

test('72-hour memory remains isolated by HMAC viewer key and deletes precisely', async () => {
  const repo = repository();
  const assistant = new PortkeyAiAssistant({
    config: config({ aiViewerCooldownMs: 0 }),
    repository: repo,
    client: client(['甲回复', '乙回复'])
  });
  await assistant.handleCommand({
    text: '!ai 甲问题',
    openId: 'viewer-a'
  });
  await assistant.handleCommand({
    text: '!ai 乙问题',
    openId: 'viewer-b'
  });
  const firstKey = createViewerKey(config().aiViewerHmacKey, 'viewer-a');
  const secondKey = createViewerKey(config().aiViewerHmacKey, 'viewer-b');
  assert.notEqual(firstKey, secondKey);
  assert.equal(repo.rows.get(firstKey).length, 2);
  assert.equal(repo.rows.get(secondKey).length, 2);
  assert.equal(await assistant.deleteSyntheticMemory('viewer-a'), 2);
  assert.equal(repo.rows.has(firstKey), false);
  assert.equal(repo.rows.has(secondKey), true);
});

test('per-viewer throttle rejects without calling the gateway', async () => {
  const calls = [];
  let now = 1000;
  const assistant = new PortkeyAiAssistant({
    config: config(),
    repository: repository(),
    client: client(['第一条'], calls),
    clock: () => now
  });
  assert.equal((await assistant.handleCommand({
    text: '!ai 第一条',
    openId: 'viewer'
  })).status, 'success');
  now += 1000;
  assert.equal((await assistant.handleCommand({
    text: '!ai 第二条',
    openId: 'viewer'
  })).status, 'throttled');
  assert.equal(calls.length, 1);
});

test('401 is classified without exposing provider response content', async () => {
  const error = new Error('sensitive upstream body');
  error.status = 401;
  const assistant = new PortkeyAiAssistant({
    config: config(),
    repository: repository(),
    client: client([error])
  });
  const result = await assistant.handleCommand({
    text: '!ai 测试',
    openId: 'viewer'
  });
  assert.deepEqual(result, { status: 'failed', errorCode: 'AUTH_401' });
});

test('global concurrency and bounded queue reject excess work before gateway calls', async () => {
  const resolvers = [];
  const calls = [];
  const deferredClient = {
    chat: {
      completions: {
        create(request) {
          calls.push(request);
          return new Promise((resolve) => resolvers.push(resolve));
        }
      }
    }
  };
  const assistant = new PortkeyAiAssistant({
    config: config({
      aiGlobalConcurrency: 1,
      aiQueueMax: 1
    }),
    repository: repository(),
    client: deferredClient
  });
  const first = assistant.handleCommand({
    text: '!ai 第一条',
    openId: 'viewer-1'
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = assistant.handleCommand({
    text: '!ai 第二条',
    openId: 'viewer-2'
  });
  const third = await assistant.handleCommand({
    text: '!ai 第三条',
    openId: 'viewer-3'
  });
  assert.equal(third.status, 'queue_full');
  assert.equal(calls.length, 1);
  resolvers.shift()({ choices: [{ message: { content: '一' } }] });
  assert.equal((await first).status, 'success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  resolvers.shift()({ choices: [{ message: { content: '二' } }] });
  assert.equal((await second).status, 'success');
});
