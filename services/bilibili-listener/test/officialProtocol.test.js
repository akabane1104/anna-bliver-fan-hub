const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  DEFAULT_LIMITS,
  HEADER_LENGTH,
  OPERATIONS,
  PROTOCOL_VERSIONS,
  createAuthPacket,
  createHeartbeatPacket,
  encodePacket,
  parseJsonBody,
  parsePackets
} = require('../src/officialProtocol');

test('official packet header is 16-byte big-endian and auth bytes are exact', () => {
  const authBody = '{"key":"synthetic-auth"}';
  const packet = createAuthPacket(authBody);
  assert.equal(packet.readUInt32BE(0), packet.length);
  assert.equal(packet.readUInt16BE(4), HEADER_LENGTH);
  assert.equal(packet.readUInt16BE(6), PROTOCOL_VERSIONS.PLAIN);
  assert.equal(packet.readUInt32BE(8), OPERATIONS.AUTH);
  assert.equal(packet.readUInt32BE(12), 1);
  assert.equal(packet.subarray(HEADER_LENGTH).toString('utf8'), authBody);
});

test('official heartbeat packet has an empty body', () => {
  const heartbeat = createHeartbeatPacket();
  assert.equal(heartbeat.length, HEADER_LENGTH);
  const [decoded] = parsePackets(heartbeat);
  assert.equal(decoded.operation, OPERATIONS.HEARTBEAT);
  assert.equal(decoded.body.length, 0);
});

test('plain concatenated packets retain operation, sequence, and JSON', () => {
  const first = encodePacket({
    operation: OPERATIONS.AUTH_REPLY,
    sequence: 5,
    body: Buffer.from('{"code":0}')
  });
  const second = encodePacket({
    operation: OPERATIONS.MESSAGE,
    sequence: 6,
    body: Buffer.from('{"cmd":"SYNTHETIC"}')
  });
  const decoded = parsePackets(Buffer.concat([first, second]));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].sequence, 5);
  assert.deepEqual(parseJsonBody(decoded[0].body), { code: 0 });
  assert.deepEqual(parseJsonBody(decoded[1].body), { cmd: 'SYNTHETIC' });
});

test('Version 2 zlib recursively decodes multiple nested packets', () => {
  const nested = Buffer.concat([
    encodePacket({
      operation: OPERATIONS.MESSAGE,
      body: Buffer.from('{"cmd":"ONE"}')
    }),
    encodePacket({
      operation: OPERATIONS.MESSAGE,
      body: Buffer.from('{"cmd":"TWO"}')
    })
  ]);
  const compressed = encodePacket({
    operation: OPERATIONS.MESSAGE,
    version: PROTOCOL_VERSIONS.ZLIB,
    body: zlib.deflateSync(nested)
  });
  const decoded = parsePackets(compressed);
  assert.deepEqual(decoded.map((item) => parseJsonBody(item.body).cmd), [
    'ONE',
    'TWO'
  ]);
});

test('malformed lengths, unsupported versions, and trailing bytes fail closed', () => {
  const invalidLength = createHeartbeatPacket();
  invalidLength.writeUInt32BE(15, 0);
  assert.throws(() => parsePackets(invalidLength), {
    code: 'invalid_official_proto_packet'
  });

  const unsupported = encodePacket({
    operation: OPERATIONS.MESSAGE,
    version: 1,
    body: Buffer.from('{}')
  });
  assert.throws(() => parsePackets(unsupported), {
    code: 'unsupported_official_proto_version'
  });

  assert.throws(
    () => parsePackets(Buffer.concat([createHeartbeatPacket(), Buffer.from([1])])),
    { code: 'invalid_official_proto_packet' }
  );
});

test('packet, decompression, recursion, count, and JSON limits are bounded', () => {
  const oversizedJson = Buffer.alloc(DEFAULT_LIMITS.maxJsonBytes + 1, 0x61);
  assert.throws(() => parseJsonBody(oversizedJson), {
    code: 'official_proto_json_too_large'
  });

  const packets = Buffer.concat(Array.from({ length: 3 }, () => createHeartbeatPacket()));
  assert.throws(
    () => parsePackets(packets, {
      limits: { ...DEFAULT_LIMITS, maxPackets: 2 }
    }),
    { code: 'official_proto_packet_limit' }
  );

  const bomb = encodePacket({
    operation: OPERATIONS.MESSAGE,
    version: PROTOCOL_VERSIONS.ZLIB,
    body: zlib.deflateSync(Buffer.alloc(2048))
  });
  assert.throws(
    () => parsePackets(bomb, {
      limits: {
        ...DEFAULT_LIMITS,
        maxDecompressedBytes: 1024
      }
    }),
    { code: 'invalid_official_proto_compression' }
  );

  const deep = {};
  let cursor = deep;
  for (let index = 0; index < DEFAULT_LIMITS.maxJsonDepth + 2; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(
    () => parseJsonBody(Buffer.from(JSON.stringify(deep))),
    { code: 'invalid_official_proto_json' }
  );
});
