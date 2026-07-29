const crypto = require('node:crypto');
const { listenerError } = require('./errors');
const { parseAiCommand } = require('./portkeyAiAssistant');

const EVENT_COMMANDS = Object.freeze([
  'LIVE_OPEN_PLATFORM_DM',
  'LIVE_OPEN_PLATFORM_LIKE',
  'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER',
  'LIVE_OPEN_PLATFORM_SEND_GIFT',
  'LIVE_OPEN_PLATFORM_SUPER_CHAT',
  'LIVE_OPEN_PLATFORM_GUARD',
  'LIVE_OPEN_PLATFORM_LIVE_START',
  'LIVE_OPEN_PLATFORM_LIVE_END',
  'LIVE_OPEN_PLATFORM_INTERACTION_END'
]);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function eventMaterial(message) {
  const command = String(message?.cmd || 'unknown');
  const messageId = message?.data?.msg_id ?? message?.msg_id;
  if (
    typeof messageId === 'string' &&
    messageId.length > 0 &&
    messageId.length <= 512
  ) {
    return `${command}\u0000${messageId}`;
  }
  return `${command}\u0000${stableStringify(message?.data || {})}`;
}

class OfficialEventProcessor {
  constructor({
    config,
    repository,
    aiAssistant = null,
    logger,
    clock = Date.now
  }) {
    this.config = config;
    this.repository = repository;
    this.aiAssistant = aiAssistant;
    this.logger = logger || { write() {} };
    this.clock = clock;
    this.counters = Object.fromEntries([
      ...EVENT_COMMANDS.map((command) => [command, 0]),
      ['unknown', 0],
      ['duplicates', 0],
      ['invalid', 0],
      ['business_effects', 0]
    ]);
  }

  snapshot() {
    return Object.freeze({
      ...this.counters,
      ai: this.aiAssistant?.snapshot?.() || null
    });
  }

  async process(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.counters.invalid += 1;
      return Object.freeze({ status: 'invalid' });
    }
    const command = typeof message.cmd === 'string'
      ? message.cmd
      : 'unknown';
    const digest = crypto
      .createHmac('sha256', this.config.eventHmacKey)
      .update(eventMaterial(message), 'utf8')
      .digest('hex');
    const inserted = await this.repository.recordEventDigest({
      digest,
      eventType: EVENT_COMMANDS.includes(command) ? command : 'unknown',
      expiresAt: new Date(
        this.clock() + this.config.eventDedupeTtlHours * 60 * 60 * 1000
      )
    });
    if (!inserted) {
      this.counters.duplicates += 1;
      return Object.freeze({ status: 'duplicate' });
    }

    const counter = EVENT_COMMANDS.includes(command) ? command : 'unknown';
    this.counters[counter] += 1;
    this.logger.write('info', 'official_event_received', {
      event_type: counter,
      result: 'received'
    });

    if (command === 'LIVE_OPEN_PLATFORM_DM' && this.aiAssistant) {
      const text = message.data?.msg;
      const openId = message.data?.open_id;
      if (
        typeof text === 'string' &&
        parseAiCommand(text) &&
        typeof openId === 'string' &&
        openId
      ) {
        await this.aiAssistant.handleCommand({ text, openId });
      }
    }
    return Object.freeze({ status: 'processed', eventType: counter });
  }
}

module.exports = {
  EVENT_COMMANDS,
  OfficialEventProcessor,
  eventMaterial,
  stableStringify
};
