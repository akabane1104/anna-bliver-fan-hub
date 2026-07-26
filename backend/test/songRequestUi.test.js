const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { websiteSongRequestSchema } = require('../src/schemas/songRequestSchemas');
const {
  createSongCatalogService,
  matchesQuery
} = require('../src/services/songCatalogService');
const {
  createSongRequestService,
  requestForPublic,
  resolveWebsiteSessionForUpdate
} = require('../src/services/songRequestService');
const { createSongRequestController } = require('../src/controllers/songRequestController');
const { createSongRequestRouter } = require('../src/routes/songRequests');

async function createHarness(t, router) {
  const app = express();
  app.use(express.json());
  app.use('/api/song-requests', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${server.address().port}/api/song-requests`;
}

test('website request accepts song_id-only input and rejects targetless free text', () => {
  assert.equal(websiteSongRequestSchema.safeParse({ song_id: 12 }).success, true);
  assert.equal(websiteSongRequestSchema.safeParse({
    site_id: 'synthetic-site',
    room_id: '10001',
    query: '年轮'
  }).success, true);
  assert.equal(websiteSongRequestSchema.safeParse({ query: '年轮' }).success, false);
  assert.equal(websiteSongRequestSchema.safeParse({
    site_id: 'synthetic-site',
    song_id: 12
  }).success, false);
});

test('song-only website target resolves the one open session for that playlist', async () => {
  const calls = [];
  const connection = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM songs')) return [[{ id: 7, playlist_id: 3 }]];
      return [[{
        id: 9,
        public_id: '25b839ef-20e2-43ab-a83d-96da42a38c2b',
        site_id: 'synthetic-site',
        room_id: '10001',
        playlist_id: 3,
        status: 'open',
        version: 0
      }]];
    }
  };
  const session = await resolveWebsiteSessionForUpdate(connection, { song_id: 7 });
  assert.equal(session.playlist_id, 3);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, [7]);
  assert.deepEqual(calls[1].params, [3]);
});

test('song-only target fails closed when multiple sessions share the playlist', async () => {
  const connection = {
    async query(sql) {
      if (sql.includes('FROM songs')) return [[{ id: 7, playlist_id: 3 }]];
      return [[{ id: 1 }, { id: 2 }]];
    }
  };
  await assert.rejects(
    resolveWebsiteSessionForUpdate(connection, { song_id: 7 }),
    (error) => error.code === 'ambiguous_open_session'
  );
});

test('catalog search supports Simplified/Traditional, artist, aliases, and tag filters', async () => {
  let call = 0;
  const pool = {
    async query() {
      call += 1;
      if (call === 1) return [[{ setting_value: '4' }]];
      if (call === 2) return [[{ id: 4, title: 'Synthetic Playlist' }]];
      if (call === 3) {
        return [[
          { id: 1, title: '年轮', artist: '合成歌手', duration: null, note: null, tag_id: 1, tag_name: '流行', tag_color: '#123456' },
          { id: 2, title: '後來', artist: '测试歌手', duration: null, note: null, tag_id: 2, tag_name: '粤语', tag_color: '#654321' }
        ]];
      }
      return [[{
        song_id: 1,
        alias: '圈圈歌',
        normalized_alias: '圈圈歌',
        script_key: '圈圈歌',
        loose_candidate_key: '圈圈歌'
      }]];
    }
  };
  const service = createSongCatalogService({ pool });
  assert.deepEqual((await service.list({ query: '年輪', limit: 10 })).songs.map(({ id }) => id), [1]);
  call = 0;
  assert.deepEqual((await service.list({ query: '圈圈歌', limit: 10 })).songs.map(({ id }) => id), [1]);
  call = 0;
  assert.deepEqual((await service.list({ query: '测试歌手', tag: '粤语', limit: 10 })).songs.map(({ id }) => id), [2]);
});

test('catalog query is compared in memory and is not interpolated into SQL', async () => {
  const sqlStatements = [];
  let call = 0;
  const pool = {
    async query(sql) {
      sqlStatements.push(sql);
      call += 1;
      if (call === 1) return [[{ setting_value: '1' }]];
      if (call === 2) return [[{ id: 1, title: 'Synthetic' }]];
      return [[]];
    }
  };
  await createSongCatalogService({ pool }).list({
    query: "%' OR 1=1 --",
    limit: 20
  });
  assert.equal(sqlStatements.some((sql) => sql.includes("OR 1=1")), false);
  assert.equal(matchesQuery({
    searchKeys: new Set(['年轮'])
  }, '年輪'), true);
});

test('public request projection redacts identity, target, internal reason, and version', () => {
  const output = requestForPublic({
    public_id: 'dc8ea78c-ea8a-4564-aeb5-060776f4cb9f',
    requested_title: '年轮',
    requester_display_name: 'Synthetic Viewer',
    requester_open_id: 'private-open-id',
    requester_user_id: 44,
    site_id: 'private-site',
    room_id: '10001',
    reason: 'private-reason',
    version: 7,
    status: 'queued',
    fulfillment_type: 'undecided',
    queue_order: '1',
    requested_at: '2026-07-23T00:00:00.000Z'
  }, { id: 1, title: '年轮', artist: 'Synthetic Artist', duration: null });
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(
    serialized,
    /open_id|user_id|site_id|room_id|internal_note|version|private-/
  );
  assert.equal(output.reason_code, 'other');
  assert.equal(output.public_reason, '该点歌请求暂时无法处理');
  assert.equal(output.matched_song.title, '年轮');
});

test('public mutation response uses the safe DTO and server identity', async (t) => {
  const controller = createSongRequestController({
    service: {
      async createWebsiteRequest(input, identity) {
        assert.deepEqual(input, { song_id: 7 });
        assert.equal(identity.userId, 42);
        return { duplicate: false, request: { public_id: 'ignored' } };
      },
      async getPublicRequest() {
        return {
          public_id: '2354447a-8c67-4c39-a14d-fee99b6415db',
          requested_title: '年轮',
          status: 'queued',
          queue_order: '2'
        };
      }
    }
  });
  const baseUrl = await createHarness(t, createSongRequestRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    }
  }));
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'synthetic-ui-request'
    },
    body: JSON.stringify({ song_id: 7 })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.request.queue_order, '2');
  assert.doesNotMatch(JSON.stringify(body), /user_id|open_id|site_id|room_id/);
});

test('public point-song route applies its dedicated write rate limit', async (t) => {
  const controller = createSongRequestController({
    service: {
      async createWebsiteRequest() {
        return { duplicate: false, request: { public_id: 'safe' } };
      },
      async getPublicRequest() {
        return { public_id: 'safe', requested_title: '年轮', status: 'queued' };
      }
    }
  });
  const baseUrl = await createHarness(t, createSongRequestRouter({
    controller,
    authenticate: (req, res, next) => {
      req.userId = 42;
      next();
    }
  }));
  let finalResponse;
  for (let index = 0; index < 31; index += 1) {
    finalResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `synthetic-rate-limit-${index}`
      },
      body: JSON.stringify({ song_id: 7 })
    });
  }
  assert.equal(finalResponse.status, 429);
  assert.equal((await finalResponse.json()).code, 'rate_limited');
});

test('history search is paginated and all filters remain parameterized', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return [[{ count: 1 }]];
      return [[{
        public_id: '2354447a-8c67-4c39-a14d-fee99b6415db',
        requested_title: '年轮',
        requester_display_name: 'Synthetic Viewer',
        source: 'website',
        status: 'completed',
        fulfillment_type: 'sung',
        requested_at: '2026-07-23T00:00:00.000Z',
        song_title: '年轮',
        song_artist: 'Synthetic Artist',
        last_actor_display_name: 'Synthetic Admin'
      }]];
    }
  };
  const result = await createSongRequestService({ pool }).getHistory({
    query: "%' OR 1=1 --",
    status: 'completed',
    source: 'website',
    page: 2,
    limit: 20
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.pagination.page, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(({ sql }) => sql.includes("OR 1=1")), false);
  assert.equal(calls[1].params.at(-2), 20);
  assert.equal(calls[1].params.at(-1), 20);

  calls.length = 0;
  await createSongRequestService({ pool }).getHistory({
    status: 'pending_review',
    page: 1,
    limit: 20
  });
  assert.deepEqual(calls[0].params, ['observed', 'needs_match']);
  assert.match(calls[0].sql, /sr\.status IN \(\?,\?\)/);
});
