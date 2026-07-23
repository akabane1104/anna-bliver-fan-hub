const zlib = require('node:zlib');
const { listenerError } = require('./errors');

const HEADER_LENGTH = 16;
const PROTOCOL_VERSIONS = Object.freeze({
  PLAIN: 0,
  ZLIB: 2
});
const OPERATIONS = Object.freeze({
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
});
const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  maxDecompressedBytes: 4 * 1024 * 1024,
  maxPacketBytes: 1024 * 1024,
  maxPackets: 128,
  maxDepth: 4,
  maxJsonBytes: 512 * 1024,
  maxJsonDepth: 12,
  maxJsonNodes: 2048,
  maxArrayLength: 512,
  maxObjectKeys: 256
});

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw listenerError('invalid_official_proto_frame');
}

function encodePacket({
  operation,
  body = Buffer.alloc(0),
  version = PROTOCOL_VERSIONS.PLAIN,
  sequence = 1
}) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (
    !Number.isInteger(operation) ||
    !Number.isInteger(version) ||
    !Number.isInteger(sequence) ||
    sequence < 0
  ) {
    throw listenerError('invalid_official_proto_packet');
  }
  const packet = Buffer.allocUnsafe(HEADER_LENGTH + bodyBuffer.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(HEADER_LENGTH, 4);
  packet.writeUInt16BE(version, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(sequence, 12);
  bodyBuffer.copy(packet, HEADER_LENGTH);
  return packet;
}

function createAuthPacket(authBody) {
  if (
    typeof authBody !== 'string' ||
    Buffer.byteLength(authBody, 'utf8') < 2 ||
    Buffer.byteLength(authBody, 'utf8') > 16 * 1024
  ) {
    throw listenerError('invalid_official_auth_body');
  }
  return encodePacket({
    operation: OPERATIONS.AUTH,
    body: Buffer.from(authBody, 'utf8')
  });
}

function createHeartbeatPacket() {
  return encodePacket({
    operation: OPERATIONS.HEARTBEAT,
    body: Buffer.alloc(0)
  });
}

function parseJsonBody(body, limits = DEFAULT_LIMITS) {
  if (!Buffer.isBuffer(body) || body.length > limits.maxJsonBytes) {
    throw listenerError('official_proto_json_too_large');
  }
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    let nodes = 0;
    const visit = (item, depth) => {
      nodes += 1;
      if (nodes > limits.maxJsonNodes || depth > limits.maxJsonDepth) {
        throw new Error();
      }
      if (Array.isArray(item)) {
        if (item.length > limits.maxArrayLength) throw new Error();
        for (const child of item) visit(child, depth + 1);
        return;
      }
      if (item && typeof item === 'object') {
        const entries = Object.values(item);
        if (entries.length > limits.maxObjectKeys) throw new Error();
        for (const child of entries) visit(child, depth + 1);
      }
    };
    visit(value, 0);
    return value;
  } catch {
    throw listenerError('invalid_official_proto_json');
  }
}

function parsePackets(input, {
  limits = DEFAULT_LIMITS,
  depth = 0,
  counter = { value: 0 }
} = {}) {
  const frame = toBuffer(input);
  if (
    depth > limits.maxDepth ||
    frame.length < HEADER_LENGTH ||
    (depth === 0 && frame.length > limits.maxFrameBytes) ||
    frame.length > limits.maxDecompressedBytes
  ) {
    throw listenerError('invalid_official_proto_frame');
  }

  const packets = [];
  let offset = 0;
  while (offset < frame.length) {
    if (frame.length - offset < HEADER_LENGTH) {
      throw listenerError('invalid_official_proto_packet');
    }
    const packetLength = frame.readUInt32BE(offset);
    const headerLength = frame.readUInt16BE(offset + 4);
    const version = frame.readUInt16BE(offset + 6);
    const operation = frame.readUInt32BE(offset + 8);
    const sequence = frame.readUInt32BE(offset + 12);
    if (
      headerLength !== HEADER_LENGTH ||
      packetLength < HEADER_LENGTH ||
      packetLength > limits.maxPacketBytes ||
      offset + packetLength > frame.length
    ) {
      throw listenerError('invalid_official_proto_packet');
    }
    counter.value += 1;
    if (counter.value > limits.maxPackets) {
      throw listenerError('official_proto_packet_limit');
    }
    const body = frame.subarray(offset + headerLength, offset + packetLength);
    if (version === PROTOCOL_VERSIONS.PLAIN) {
      packets.push(Object.freeze({
        operation,
        version,
        sequence,
        body: Buffer.from(body)
      }));
    } else if (version === PROTOCOL_VERSIONS.ZLIB) {
      let decompressed;
      try {
        decompressed = zlib.inflateSync(body, {
          maxOutputLength: limits.maxDecompressedBytes
        });
      } catch {
        throw listenerError('invalid_official_proto_compression');
      }
      packets.push(...parsePackets(decompressed, {
        limits,
        depth: depth + 1,
        counter
      }));
    } else {
      throw listenerError('unsupported_official_proto_version');
    }
    offset += packetLength;
  }
  return packets;
}

module.exports = {
  DEFAULT_LIMITS,
  HEADER_LENGTH,
  OPERATIONS,
  PROTOCOL_VERSIONS,
  createAuthPacket,
  createHeartbeatPacket,
  encodePacket,
  parseJsonBody,
  parsePackets,
  toBuffer
};
