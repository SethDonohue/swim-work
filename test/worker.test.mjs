import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  clampRating,
  rowToEntry,
  toNum,
  normalizeGoodFor,
  sanitizeUserSpot,
} from '../src/index.mjs';

// The Worker keeps NOTE_MAX internal (only function exports are allowed on the
// entry module), so mirror the cap here for behavior assertions.
const NOTE_MAX = 250;

// Minimal in-memory stand-in for the D1 binding used by the Worker. Table-aware:
// `entries` and `user_spots` are stored separately and routed by the SQL text.
function makeMockDB(initialRows = [], initialUserSpots = []) {
  let rows = initialRows.map((r) => ({ ...r }));
  let userSpots = initialUserSpots.map((r) => ({ ...r }));
  return {
    rows: () => rows,
    userSpots: () => userSpots,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...a) {
          this.args = a;
          return this;
        },
        async first() {
          if (/FROM user_spots WHERE id = \?/.test(sql)) {
            return userSpots.find((r) => r.id === this.args[0]) || null;
          }
          return null;
        },
        async all() {
          if (/FROM user_spots/.test(sql)) {
            if (/author_id = \?/.test(sql)) {
              const authorId = this.args[0];
              return { results: userSpots.filter((r) => r.is_public || r.author_id === authorId) };
            }
            return { results: userSpots.filter((r) => r.is_public) };
          }
          if (/WHERE spot_id = \?/.test(sql)) {
            const spotId = this.args[0];
            return { results: rows.filter((r) => r.spot_id === spotId) };
          }
          return { results: rows };
        },
        async run() {
          if (/^\s*INSERT INTO entries/.test(sql)) {
            const [spot_id, author_id, author_name, visited, rating, comment, swam_here, updated_at] =
              this.args;
            const existing = rows.find((r) => r.spot_id === spot_id && r.author_id === author_id);
            if (existing) {
              Object.assign(existing, { author_name, visited, rating, comment, swam_here, updated_at });
            } else {
              rows.push({ spot_id, author_id, author_name, visited, rating, comment, swam_here, updated_at });
            }
          } else if (/^\s*DELETE FROM entries/.test(sql)) {
            const [spot_id, author_id] = this.args;
            rows = rows.filter((r) => !(r.spot_id === spot_id && r.author_id === author_id));
          } else if (/^\s*INSERT INTO user_spots/.test(sql)) {
            const cols = [
              'id', 'name', 'area', 'address', 'lat', 'lng', 'swim_type', 'water',
              'good_for', 'description', 'author_id', 'author_name', 'is_public',
              'created_at', 'updated_at',
            ];
            const row = {};
            cols.forEach((c, i) => (row[c] = this.args[i]));
            userSpots.push(row);
          } else if (/^\s*UPDATE user_spots/.test(sql)) {
            const [name, area, address, lat, lng, swim_type, water, good_for, description, is_public, updated_at, id] = this.args;
            const existing = userSpots.find((r) => r.id === id);
            if (existing) {
              Object.assign(existing, { name, area, address, lat, lng, swim_type, water, good_for, description, is_public, updated_at });
            }
          } else if (/^\s*DELETE FROM user_spots/.test(sql)) {
            userSpots = userSpots.filter((r) => r.id !== this.args[0]);
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
    swamHere: false,
    updatedAt: '2026-06-01',
  });
});

test('PUT /api/entries persists and returns the swamHere flag', async () => {
  const DB = makeMockDB();
  const res = await worker.fetch(
    req('/api/entries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spotId: 's1', authorId: 'a', swamHere: true }),
    }),
    { DB, ASSETS: assets }
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).entry.swamHere, true);
  assert.equal(DB.rows()[0].swam_here, 1, 'stored as 0/1');

  // Round-trips back out through GET as a boolean.
  const get = await worker.fetch(req('/api/entries'), { DB, ASSETS: assets });
  assert.equal((await get.json()).entries[0].swamHere, true);
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

test('PUT /api/entries caps a note at NOTE_MAX (250) chars', async () => {
  const DB = makeMockDB();
  const long = 'x'.repeat(600);
  const res = await worker.fetch(
    req('/api/entries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spotId: 's1', authorId: 'a', comment: long }),
    }),
    { DB, ASSETS: assets }
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).entry.comment.length, NOTE_MAX);
  assert.equal(DB.rows()[0].comment.length, 250);
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

test('GET /api/water returns the latest reading per beach, numbers coerced', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        // Newest Madrona row first (matches the Worker's date DESC order).
        { beach: 'Madrona', date: '2026-06-16', geomean30d: '14.5', hightoday: false, nsampleshigh30d: '0', watertempf: '70.2' },
        { beach: 'Madrona', date: '2026-06-09', geomean30d: '99', hightoday: true, nsampleshigh30d: '2', watertempf: '68.0' },
        { beach: 'Seward Park', date: '2026-06-16', geomean30d: '200', hightoday: false, nsampleshigh30d: '4', watertempf: '' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  try {
    const res = await worker.fetch(req('/api/water'), { ASSETS: assets }, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'King County Swim Beach Monitoring');
    assert.deepEqual(body.beaches.Madrona, {
      date: '2026-06-16',
      geomean30d: 14.5,
      hightoday: false,
      nsampleshigh30d: 0,
      watertempf: 70.2,
    });
    assert.equal(body.beaches['Seward Park'].geomean30d, 200);
    assert.equal(body.beaches['Seward Park'].watertempf, null, 'empty temp -> null');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GET /api/water surfaces upstream failure as 502', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const res = await worker.fetch(req('/api/water'), { ASSETS: assets }, { waitUntil() {} });
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('non-GET /api/water is rejected', async () => {
  const res = await worker.fetch(req('/api/water', { method: 'POST' }), { ASSETS: assets }, { waitUntil() {} });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// /api/spots — user-created spots
// ---------------------------------------------------------------------------
function spotBody(overrides = {}) {
  return Object.assign(
    {
      authorId: 'a1',
      authorName: 'Ann',
      name: 'Secret Cove',
      lat: 47.61,
      lng: -122.33,
      goodFor: ['swim', 'play'],
      description: 'Quiet little cove',
      isPublic: false,
    },
    overrides
  );
}

async function postSpot(DB, body) {
  return worker.fetch(
    req('/api/spots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { DB, ASSETS: assets }
  );
}

test('POST /api/spots creates a spot and echoes the client shape', async () => {
  const DB = makeMockDB();
  const res = await postSpot(DB, spotBody({ isPublic: true }));
  assert.equal(res.status, 201);
  const { spot } = await res.json();
  assert.ok(spot.id.startsWith('user-'));
  assert.equal(spot.userSubmitted, true);
  assert.equal(spot.isPublic, true);
  assert.deepEqual(spot.goodFor, ['swim', 'play']);
  assert.equal(spot.swimType, 'Shoreline access');
  assert.equal(DB.userSpots().length, 1);
});

test('POST /api/spots requires name, coords, and authorId', async () => {
  const DB = makeMockDB();
  assert.equal((await postSpot(DB, spotBody({ name: '' }))).status, 400);
  assert.equal((await postSpot(DB, spotBody({ lat: 'nope' }))).status, 400);
  assert.equal((await postSpot(DB, spotBody({ lat: 10, lng: 10 }))).status, 400); // outside coverage
  assert.equal((await postSpot(DB, spotBody({ authorId: '' }))).status, 400);
});

test('POST /api/spots forces swimType to "No swimming" when not a swim spot', async () => {
  const DB = makeMockDB();
  const res = await postSpot(DB, spotBody({ goodFor: ['work'], swimType: 'Saltwater beach' }));
  const { spot } = await res.json();
  assert.equal(spot.swimType, 'No swimming');
  assert.deepEqual(spot.goodFor, ['work']);
});

test('GET /api/spots returns public spots + caller\'s private spots only', async () => {
  const DB = makeMockDB([], [
    { id: 'user-pub', name: 'Pub', area: 'X', address: '', lat: 47.6, lng: -122.3, swim_type: 'Shoreline access', water: 'Fresh', good_for: 'swim', description: '', author_id: 'a1', author_name: 'Ann', is_public: 1, created_at: 't', updated_at: 't' },
    { id: 'user-mine', name: 'Mine', area: 'X', address: '', lat: 47.6, lng: -122.3, swim_type: 'Shoreline access', water: 'Fresh', good_for: 'swim', description: '', author_id: 'a2', author_name: 'Bob', is_public: 0, created_at: 't', updated_at: 't' },
    { id: 'user-theirs', name: 'Theirs', area: 'X', address: '', lat: 47.6, lng: -122.3, swim_type: 'Shoreline access', water: 'Fresh', good_for: 'swim', description: '', author_id: 'a3', author_name: 'Cy', is_public: 0, created_at: 't', updated_at: 't' },
  ]);
  const res = await worker.fetch(req('/api/spots?authorId=a2'), { DB, ASSETS: assets });
  const ids = (await res.json()).spots.map((s) => s.id).sort();
  assert.deepEqual(ids, ['user-mine', 'user-pub'], 'sees public + own private, not others private');

  const anon = await worker.fetch(req('/api/spots'), { DB, ASSETS: assets });
  assert.deepEqual((await anon.json()).spots.map((s) => s.id), ['user-pub'], 'anon sees only public');
});

test('PATCH /api/spots edits own spot; public is one-way permanent', async () => {
  const DB = makeMockDB();
  const created = await (await postSpot(DB, spotBody({ isPublic: false }))).json();
  const id = created.spot.id;

  // Non-author cannot edit.
  const forbidden = await worker.fetch(
    req(`/api/spots/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: 'someone-else', name: 'Hacked' }) }),
    { DB, ASSETS: assets }
  );
  assert.equal(forbidden.status, 403);

  // Author publishes it.
  const pub = await worker.fetch(
    req(`/api/spots/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: 'a1', isPublic: true, name: 'Renamed' }) }),
    { DB, ASSETS: assets }
  );
  assert.equal((await pub.json()).spot.isPublic, true);

  // Trying to un-publish is ignored (public is permanent).
  const unpub = await worker.fetch(
    req(`/api/spots/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: 'a1', isPublic: false }) }),
    { DB, ASSETS: assets }
  );
  assert.equal((await unpub.json()).spot.isPublic, true, 'stays public');
});

test('DELETE /api/spots removes own private spot but not public or others\'', async () => {
  const DB = makeMockDB();
  const priv = await (await postSpot(DB, spotBody({ isPublic: false }))).json();
  const pub = await (await postSpot(DB, spotBody({ isPublic: true }))).json();

  // Not the author -> 403.
  const notMine = await worker.fetch(req(`/api/spots/${priv.spot.id}?authorId=other`, { method: 'DELETE' }), { DB, ASSETS: assets });
  assert.equal(notMine.status, 403);

  // Public -> 403 (permanent).
  const pubDel = await worker.fetch(req(`/api/spots/${pub.spot.id}?authorId=a1`, { method: 'DELETE' }), { DB, ASSETS: assets });
  assert.equal(pubDel.status, 403);

  // Own private -> deleted.
  const ok = await worker.fetch(req(`/api/spots/${priv.spot.id}?authorId=a1`, { method: 'DELETE' }), { DB, ASSETS: assets });
  assert.equal(ok.status, 200);
  assert.equal(DB.userSpots().length, 1, 'only the public spot remains');
});

test('normalizeGoodFor + sanitizeUserSpot helpers behave', () => {
  assert.deepEqual(normalizeGoodFor('swim,work,bogus'), ['swim', 'work']);
  assert.deepEqual(normalizeGoodFor([]), ['play']);
  const bad = sanitizeUserSpot({ name: '', lat: 47.6, lng: -122.3 });
  assert.ok(bad.error);
  const ok = sanitizeUserSpot({ name: 'X', lat: 47.6, lng: -122.3, goodFor: ['play'] });
  assert.equal(ok.spot.swim_type, 'No swimming', 'no swim category -> No swimming');
});

test('toNum coerces strings, blanks, and bad values', () => {
  assert.equal(toNum('14.5'), 14.5);
  assert.equal(toNum(''), null);
  assert.equal(toNum(null), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum('nope'), null);
  assert.equal(toNum(0), 0);
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
