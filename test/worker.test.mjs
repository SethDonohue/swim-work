import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { clampRating, rowToEntry } from '../src/index.mjs';

// Minimal in-memory stand-in for the D1 binding used by the Worker.
function makeMockDB(initialRows = []) {
  let rows = initialRows.map((r) => ({ ...r }));
  return {
    rows: () => rows,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...a) {
          this.args = a;
          return this;
        },
        async all() {
          if (/WHERE spot_id = \?/.test(sql)) {
            const spotId = this.args[0];
            return { results: rows.filter((r) => r.spot_id === spotId) };
          }
          return { results: rows };
        },
        async run() {
          if (/^\s*INSERT INTO entries/.test(sql)) {
            const [spot_id, author_id, author_name, visited, rating, comment, updated_at] = this.args;
            const existing = rows.find((r) => r.spot_id === spot_id && r.author_id === author_id);
            if (existing) {
              Object.assign(existing, { author_name, visited, rating, comment, updated_at });
            } else {
              rows.push({ spot_id, author_id, author_name, visited, rating, comment, updated_at });
            }
          } else if (/^\s*DELETE FROM entries/.test(sql)) {
            const [spot_id, author_id] = this.args;
            rows = rows.filter((r) => !(r.spot_id === spot_id && r.author_id === author_id));
          }
          return { success: true };
        },
      };
    },
  };
}

const assets = { fetch: async () => new Response('static-asset', { status: 200 }) };

function req(path, init) {
  return new Request(`https://example.com${path}`, init);
}

test('GET /api/entries returns mapped entries', async () => {
  const DB = makeMockDB([
    { spot_id: 's1', author_id: 'a', author_name: 'A', visited: 1, rating: 5, comment: 'hi', updated_at: '2026-06-01' },
  ]);
  const res = await worker.fetch(req('/api/entries'), { DB, ASSETS: assets });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.entries[0], {
    spotId: 's1',
    authorId: 'a',
    authorName: 'A',
    visited: true,
    rating: 5,
    comment: 'hi',
    updatedAt: '2026-06-01',
  });
});

test('PUT /api/entries upserts (no duplicate) and clamps rating', async () => {
  const DB = makeMockDB();
  const first = await worker.fetch(
    req('/api/entries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spotId: 's1', authorId: 'a', authorName: 'A', visited: true, rating: 99, comment: 'x' }),
    }),
    { DB, ASSETS: assets }
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).entry.rating, 5, 'rating clamps to 5');
  assert.equal(DB.rows().length, 1);

  await worker.fetch(
    req('/api/entries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spotId: 's1', authorId: 'a', authorName: 'A2', visited: false, rating: 2, comment: 'y' }),
    }),
    { DB, ASSETS: assets }
  );
  assert.equal(DB.rows().length, 1, 'second PUT updates, does not duplicate');
  assert.equal(DB.rows()[0].author_name, 'A2');
});

test('PUT /api/entries rejects missing ids', async () => {
  const DB = makeMockDB();
  const res = await worker.fetch(
    req('/api/entries', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }),
    { DB, ASSETS: assets }
  );
  assert.equal(res.status, 400);
});

test('DELETE /api/entries removes the matching row', async () => {
  const DB = makeMockDB([
    { spot_id: 's1', author_id: 'a', author_name: 'A', visited: 1, rating: 5, comment: 'hi', updated_at: '2026-06-01' },
  ]);
  const res = await worker.fetch(req('/api/entries?spotId=s1&authorId=a', { method: 'DELETE' }), {
    DB,
    ASSETS: assets,
  });
  assert.equal(res.status, 200);
  assert.equal(DB.rows().length, 0);
});

test('non-API requests fall through to static assets', async () => {
  const res = await worker.fetch(req('/index.html'), { ASSETS: assets });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'static-asset');
});

test('unknown /api/* path returns 404', async () => {
  const res = await worker.fetch(req('/api/nope'), { DB: makeMockDB(), ASSETS: assets });
  assert.equal(res.status, 404);
});

test('missing DB binding returns 500', async () => {
  const res = await worker.fetch(req('/api/entries'), { ASSETS: assets });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /DB/);
});

test('GET /api/geocode proxies Nominatim and shapes the result', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ lat: '47.61', lon: '-122.33', display_name: 'Test Park, Seattle' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const res = await worker.fetch(req('/api/geocode?q=test%20park'), { ASSETS: assets }, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).result, {
      lat: 47.61,
      lng: -122.33,
      label: 'Test Park, Seattle',
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GET /api/geocode returns null result when there is no match', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await worker.fetch(req('/api/geocode?q=zzz'), { ASSETS: assets }, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result, null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GET /api/geocode requires a q param', async () => {
  const res = await worker.fetch(req('/api/geocode'), { ASSETS: assets }, { waitUntil() {} });
  assert.equal(res.status, 400);
});

test('GET /api/geocode surfaces upstream failure as 502', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const res = await worker.fetch(req('/api/geocode?q=test'), { ASSETS: assets }, { waitUntil() {} });
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('clampRating + rowToEntry helpers behave', () => {
  assert.equal(clampRating(10), 5);
  assert.equal(clampRating(-1), 0);
  assert.equal(clampRating('3'), 3);
  assert.equal(
    rowToEntry({ spot_id: 's', author_id: 'a', author_name: 'N', visited: 0, rating: null, comment: null, updated_at: 't' })
      .rating,
    0
  );
  assert.equal(
    rowToEntry({ spot_id: 's', author_id: 'a', author_name: 'N', visited: 1, rating: 4, comment: 'c', updated_at: 't' })
      .visited,
    true
  );
});
