const crypto = require('node:crypto');
const { listenerError, safeErrorCode } = require('./errors');
const { DEFAULT_AI_PERSONA } = require('./aiPersona');

const AI_COMMAND_PREFIXES = Object.freeze(['!ai测试 ', '!ai ']);
const MAX_INPUT_CHARACTERS = 200;
const MAX_OUTPUT_CHARACTERS = 40;

function unicodeLength(value) {
  return Array.from(String(value)).length;
}

function truncateUnicode(value, limit) {
  return Array.from(String(value)).slice(0, limit).join('');
}

function parseAiCommand(value) {
  if (typeof value !== 'string') return null;
  const prefix = AI_COMMAND_PREFIXES.find((item) => value.startsWith(item));
  if (!prefix) return null;
  const body = value.slice(prefix.length).trim();
  if (!body) return null;
  if (unicodeLength(body) > MAX_INPUT_CHARACTERS) {
    return Object.freeze({ status: 'too_long', body: null });
  }
  return Object.freeze({ status: 'accepted', body });
}

function createViewerKey(secret, openId) {
  if (typeof openId !== 'string' || !openId) {
    throw listenerError('invalid_ai_viewer_identity');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(openId, 'utf8')
    .digest('hex');
}

function classifyAiError(error) {
  const status = Number(error?.status);
  if (status === 401) return 'AUTH_401';
  if (status === 403) return 'AUTH_403';
  if (status === 429) return 'RATE_LIMIT_429';
  if (status >= 500 && status <= 599) return 'UPSTREAM_5XX';
  if (
    error?.name === 'AbortError' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'APIConnectionTimeoutError'
  ) {
    return 'TIMEOUT';
  }
  if (
    error?.code === 'ECONNRESET' ||
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'ENOTFOUND' ||
    error?.name === 'APIConnectionError'
  ) {
    return 'NETWORK';
  }
  return safeErrorCode(error, 'INVALID_RESPONSE').toUpperCase();
}

class PortkeyAiAssistant {
  constructor({
    config,
    repository,
    logger,
    client,
    persona = DEFAULT_AI_PERSONA,
    clock = Date.now
  }) {
    this.config = config;
    this.repository = repository;
    this.logger = logger || { write() {} };
    this.client = client;
    this.persona = persona;
    this.clock = clock;
    this.active = 0;
    this.queue = [];
    this.viewerLastRequestAt = new Map();
    this.counters = {
      requests: 0,
      successes: 0,
      failures: 0,
      throttled: 0,
      queue_rejected: 0,
      shortened: 0
    };
  }

  snapshot() {
    return Object.freeze({
      enabled: Boolean(this.config.aiEnabled),
      active: this.active,
      queue_depth: this.queue.length,
      ...this.counters
    });
  }

  async handleCommand({
    text,
    openId,
    synthetic = false
  }) {
    if (!this.config.aiEnabled) return Object.freeze({ status: 'disabled' });
    const command = parseAiCommand(text);
    if (!command) return Object.freeze({ status: 'ignored' });
    if (command.status !== 'accepted') return command;

    const viewerKey = createViewerKey(this.config.aiViewerHmacKey, openId);
    const now = this.clock();
    const lastRequestAt = this.viewerLastRequestAt.get(viewerKey);
    if (
      lastRequestAt !== undefined &&
      now - lastRequestAt < this.config.aiViewerCooldownMs
    ) {
      this.counters.throttled += 1;
      return Object.freeze({ status: 'throttled' });
    }
    if (
      this.active >= this.config.aiGlobalConcurrency &&
      this.queue.length >= this.config.aiQueueMax
    ) {
      this.counters.queue_rejected += 1;
      return Object.freeze({ status: 'queue_full' });
    }
    this.viewerLastRequestAt.set(viewerKey, now);
    return this._enqueue(() => this._execute({
      viewerKey,
      body: command.body,
      synthetic
    }));
  }

  async deleteSyntheticMemory(openId) {
    const viewerKey = createViewerKey(this.config.aiViewerHmacKey, openId);
    return this.repository.deleteViewerMemory(viewerKey);
  }

  _enqueue(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this._drain();
    });
  }

  _drain() {
    while (
      this.active < this.config.aiGlobalConcurrency &&
      this.queue.length > 0
    ) {
      const item = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve)
        .catch((error) => item.resolve(Object.freeze({
          status: 'failed',
          errorCode: classifyAiError(error)
        })))
        .finally(() => {
          this.active -= 1;
          this._drain();
        });
    }
  }

  async _execute({ viewerKey, body, synthetic }) {
    const startedAt = this.clock();
    this.counters.requests += 1;
    try {
      const history = await this.repository.listMemory(viewerKey, {
        now: new Date(this.clock()),
        limit: this.config.aiContextMaxMessages
      });
      const messages = [
        { role: 'system', content: this.persona },
        ...history.map((item) => ({
          role: item.role,
          content: item.content
        })),
        { role: 'user', content: body }
      ];
      let output = await this._request(messages);
      if (unicodeLength(output) > MAX_OUTPUT_CHARACTERS) {
        this.counters.shortened += 1;
        output = await this._request([
          { role: 'system', content: this.persona },
          {
            role: 'user',
            content: `将下面回复缩短到40个Unicode字符以内，只输出缩短结果：\n${output}`
          }
        ]);
      }
      output = truncateUnicode(output.trim(), MAX_OUTPUT_CHARACTERS);
      if (!output) throw listenerError('invalid_ai_response');

      const expiresAt = new Date(
        this.clock() + this.config.aiMemoryHours * 60 * 60 * 1000
      );
      await this.repository.appendExchange({
        viewerKey,
        input: body,
        output,
        expiresAt
      });
      this.counters.successes += 1;
      this.logger.write('info', 'ai_local_output', {
        output,
        duration_ms: Math.max(0, this.clock() - startedAt),
        result: synthetic ? 'synthetic' : 'live'
      });
      return Object.freeze({
        status: 'success',
        output,
        outputLength: unicodeLength(output),
        durationMs: Math.max(0, this.clock() - startedAt)
      });
    } catch (error) {
      this.counters.failures += 1;
      const errorCode = classifyAiError(error);
      this.logger.write('warn', 'ai_request_failed', {
        error_code: errorCode,
        duration_ms: Math.max(0, this.clock() - startedAt)
      });
      return Object.freeze({ status: 'failed', errorCode });
    }
  }

  async _request(messages) {
    const response = await this.client.chat.completions.create({
      model: this.config.aiModel,
      messages,
      max_tokens: this.config.aiMaxTokens
    });
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw listenerError('invalid_ai_response');
    }
    return content;
  }
}

module.exports = {
  AI_COMMAND_PREFIXES,
  MAX_INPUT_CHARACTERS,
  MAX_OUTPUT_CHARACTERS,
  PortkeyAiAssistant,
  classifyAiError,
  createViewerKey,
  parseAiCommand,
  truncateUnicode,
  unicodeLength
};
