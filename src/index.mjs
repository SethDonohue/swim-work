/*
 * Cloudflare Worker — Swim + Work Seattle
 *
 * Serves the static front-end (via the `ASSETS` binding) and a small JSON API at
 * /api/entries backed by D1 (bound as `DB`). This replaces the former Pages
 * Functions setup after Cloudflare removed dashboard creation of Pages projects;
 * the routing + storage behavior is identical.
 *
 * GET    /api/entries            -> { entries: [...] }   (all authors, all spots)
 * GET    /api/entries?spotId=ID  -> { entries: [...] }   (single spot)
 * PUT    /api/entries            -> upsert one entry (JSON body; note capped 250)
 * DELETE /api/entries?spotId=&authorId=  -> delete one entry
 * GET    /api/geocode?q=<place>  -> { result: { lat, lng, label } | null }
 * GET    /api/water              -> latest King County freshwater quality per beach
 * GET    /api/spots?authorId=ID  -> { spots: [...] } (public + caller's private)
 * POST   /api/spots              -> create a user spot (JSON body)
 * PATCH  /api/spots/<id>         -> edit own spot (public is one-way permanent)
 * DELETE /api/spots/<id>?authorId=ID -> delete own *private* spot only
 *
 * NOTE: there is no authentication yet — the author identity comes from the
 * client's local profile, so anyone could write as anyone. This is the
 * documented "keep it simple first" trade-off; gate it behind Cloudflare Access
 * (and verify identity server-side) before treating it as trusted.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// A note/comment is capped at 250 chars (one per user per spot; freely editable).
// Not exported: the Workers runtime only allows function/handler named exports on
// the entry module. Tests assert the cap via behavior.
const NOTE_MAX = 250;

// Categories a user-created spot can be "good for".
const CATEGORIES = ['swim', 'play', 'work'];
const SWIM_TYPES = [
  'Lifeguarded beach',
  'Heated pool',
  'Saltwater beach',
  'Beach (no lifeguard)',
  'Shoreline access',
  'Tide pools',
  'No swimming',
];

// Identifies this app to Nominatim per their usage policy (a real UA is required).
const GEOCODER_UA =
  'swim-work/1.0 (Seattle swim+work map; https://swim-work.donohue-seth.workers.dev)';

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function rowToEntry(row) {
  return {
    spotId: row.spot_id,
    authorId: row.author_id,
    authorName: row.author_name,
    visited: !!row.visited,
    rating: row.rating == null ? 0 : Number(row.rating),
    comment: row.comment || '',
    swamHere: !!row.swam_here,
    updatedAt: row.updated_at,
  };
}

export function clampRating(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 5 ? 5 : n;
}

/** Coerce a Socrata string field to a finite number, or null when absent. */
export function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a goodFor value (array or CSV string) to a clean subset of CATEGORIES. */
export function normalizeGoodFor(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  for (const raw of arr) {
    const g = String(raw).trim().toLowerCase();
    if (CATEGORIES.indexOf(g) !== -1 && out.indexOf(g) === -1) out.push(g);
  }
  return out.length ? out : ['play'];
}

/** Map a DB user_spots row to the client spot shape (merges with curated spots). */
export function rowToUserSpot(row) {
  const goodFor = normalizeGoodFor(row.good_for);
  return {
    id: row.id,
    name: row.name,
    area: row.area || 'Community spots',
    address: row.address || '',
    lat: Number(row.lat),
    lng: Number(row.lng),
    swimType: row.swim_type || 'Shoreline access',
    water: row.water || 'Fresh',
    swim: row.description || '',
    cafe: '',
    shade: '',
    goodFor,
    tags: ['user-submitted'],
    userSubmitted: true,
    authorId: row.author_id,
    authorName: row.author_name,
    isPublic: !!row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validate + normalize an incoming user-spot payload. Returns { spot } on success
 * or { error } with a message. `partial` allows a subset of fields (for PATCH).
 */
export function sanitizeUserSpot(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'name is required' };
    out.name = name.slice(0, 120);
  }
  if (!partial || has('lat') || has('lng')) {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: 'valid lat/lng are required' };
    }
    if (lat < 47.05 || lat > 47.95 || lng < -122.75 || lng > -121.3) {
      return { error: 'lat/lng outside the coverage area' };
    }
    out.lat = lat;
    out.lng = lng;
  }
  if (has('goodFor') || has('good_for')) {
    out.good_for = normalizeGoodFor(body.goodFor !== undefined ? body.goodFor : body.good_for).join(',');
  }
  if (has('swimType') || has('swim_type')) {
    const st = String(body.swimType || body.swim_type);
    out.swim_type = SWIM_TYPES.indexOf(st) !== -1 ? st : 'Shoreline access';
  }
  if (has('water')) out.water = body.water === 'Salt' ? 'Salt' : 'Fresh';
  if (!partial || has('description')) {
    out.description = String(body.description || '').slice(0, 400);
  }
  if (!partial || has('area')) out.area = String(body.area || 'Community spots').slice(0, 60) || 'Community spots';
  if (has('address')) out.address = String(body.address || '').slice(0, 160);

  // Keep swimType consistent with the chosen categories.
  const goodFor = out.good_for ? out.good_for.split(',') : null;
  if (goodFor) {
    if (goodFor.indexOf('swim') === -1) {
      out.swim_type = 'No swimming';
    } else if (out.swim_type === 'No swimming' || (!out.swim_type && !partial)) {
      out.swim_type = 'Shoreline access';
    }
  }
  return { spot: out };
}

async function getEntries(request, env) {
  const url = new URL(request.url);
  const spotId = url.searchParams.get('spotId');
  const stmt = spotId
    ? env.DB.prepare('SELECT * FROM entries WHERE spot_id = ? ORDER BY updated_at DESC').bind(spotId)
    : env.DB.prepare('SELECT * FROM entries ORDER BY updated_at DESC');
  const { results } = await stmt.all();
  return json({ entries: (results || []).map(rowToEntry) });
}

async function putEntry(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const spotId = String(body.spotId || '').trim();
  const authorId = String(body.authorId || '').trim();
  if (!spotId || !authorId) {
    return json({ error: 'spotId and authorId are required' }, 400);
  }

  const entry = {
    spot_id: spotId,
    author_id: authorId,
    author_name: String(body.authorName || 'Anonymous').slice(0, 60),
    visited: body.visited ? 1 : 0,
    rating: clampRating(body.rating),
    comment: String(body.comment || '').slice(0, NOTE_MAX),
    swam_here: body.swamHere ? 1 : 0,
    updated_at: new Date().toISOString(),
  };

  await env.DB.prepare(
    `INSERT INTO entries (spot_id, author_id, author_name, visited, rating, comment, swam_here, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(spot_id, author_id) DO UPDATE SET
       author_name = excluded.author_name,
       visited     = excluded.visited,
       rating      = excluded.rating,
       comment     = excluded.comment,
       swam_here   = excluded.swam_here,
       updated_at  = excluded.updated_at`
  )
    .bind(
      entry.spot_id,
      entry.author_id,
      entry.author_name,
      entry.visited,
      entry.rating,
      entry.comment,
      entry.swam_here,
      entry.updated_at
    )
    .run();

  return json({ entry: rowToEntry(entry) });
}

async function deleteEntry(request, env) {
  const url = new URL(request.url);
  const spotId = url.searchParams.get('spotId');
  const authorId = url.searchParams.get('authorId');
  if (!spotId || !authorId) {
    return json({ error: 'spotId and authorId query params are required' }, 400);
  }
  await env.DB.prepare('DELETE FROM entries WHERE spot_id = ? AND author_id = ?')
    .bind(spotId, authorId)
    .run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// User-created spots (/api/spots)
// ---------------------------------------------------------------------------

/** Public spots (everyone) + the caller's own private spots. */
async function getSpots(request, env) {
  const url = new URL(request.url);
  const authorId = (url.searchParams.get('authorId') || '').trim();
  const stmt = authorId
    ? env.DB.prepare(
        'SELECT * FROM user_spots WHERE is_public = 1 OR author_id = ? ORDER BY created_at DESC'
      ).bind(authorId)
    : env.DB.prepare('SELECT * FROM user_spots WHERE is_public = 1 ORDER BY created_at DESC');
  const { results } = await stmt.all();
  return json({ spots: (results || []).map(rowToUserSpot) });
}

async function postSpot(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const authorId = String(body.authorId || '').trim();
  if (!authorId) return json({ error: 'authorId is required' }, 400);

  const { spot, error } = sanitizeUserSpot(body, { partial: false });
  if (error) return json({ error }, 400);

  const now = new Date().toISOString();
  const row = {
    id: 'user-' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name: spot.name,
    area: spot.area || 'Community spots',
    address: spot.address || '',
    lat: spot.lat,
    lng: spot.lng,
    swim_type: spot.swim_type || 'Shoreline access',
    water: spot.water || 'Fresh',
    good_for: spot.good_for || 'play',
    description: spot.description || '',
    author_id: authorId,
    author_name: String(body.authorName || 'Anonymous').slice(0, 60),
    is_public: body.isPublic ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  await env.DB.prepare(
    `INSERT INTO user_spots
       (id, name, area, address, lat, lng, swim_type, water, good_for, description,
        author_id, author_name, is_public, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id, row.name, row.area, row.address, row.lat, row.lng, row.swim_type,
      row.water, row.good_for, row.description, row.author_id, row.author_name,
      row.is_public, row.created_at, row.updated_at
    )
    .run();

  return json({ spot: rowToUserSpot(row) }, 201);
}

async function patchSpot(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const authorId = String(body.authorId || '').trim();
  if (!authorId) return json({ error: 'authorId is required' }, 400);

  const existing = await env.DB.prepare('SELECT * FROM user_spots WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Spot not found' }, 404);
  if (existing.author_id !== authorId) {
    return json({ error: 'Only the author can edit this spot' }, 403);
  }

  const { spot, error } = sanitizeUserSpot(body, { partial: true });
  if (error) return json({ error }, 400);

  const next = {
    name: spot.name !== undefined ? spot.name : existing.name,
    area: spot.area !== undefined ? spot.area : existing.area,
    address: spot.address !== undefined ? spot.address : existing.address,
    lat: spot.lat !== undefined ? spot.lat : existing.lat,
    lng: spot.lng !== undefined ? spot.lng : existing.lng,
    swim_type: spot.swim_type !== undefined ? spot.swim_type : existing.swim_type,
    water: spot.water !== undefined ? spot.water : existing.water,
    good_for: spot.good_for !== undefined ? spot.good_for : existing.good_for,
    description: spot.description !== undefined ? spot.description : existing.description,
    // Public is permanent: once true it can't be turned back off, only on.
    is_public: existing.is_public ? 1 : body.isPublic ? 1 : 0,
    updated_at: new Date().toISOString(),
  };

  await env.DB.prepare(
    `UPDATE user_spots SET
       name = ?, area = ?, address = ?, lat = ?, lng = ?, swim_type = ?, water = ?,
       good_for = ?, description = ?, is_public = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      next.name, next.area, next.address, next.lat, next.lng, next.swim_type,
      next.water, next.good_for, next.description, next.is_public, next.updated_at, id
    )
    .run();

  return json({ spot: rowToUserSpot({ ...existing, ...next, id }) });
}

async function deleteSpot(request, env, id) {
  const url = new URL(request.url);
  const authorId = (url.searchParams.get('authorId') || '').trim();
  if (!authorId) return json({ error: 'authorId query param is required' }, 400);

  const existing = await env.DB.prepare('SELECT * FROM user_spots WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Spot not found' }, 404);
  if (existing.author_id !== authorId) {
    return json({ error: 'Only the author can delete this spot' }, 403);
  }
  if (existing.is_public) {
    return json({ error: 'Public spots are permanent and cannot be deleted' }, 403);
  }
  await env.DB.prepare('DELETE FROM user_spots WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function handleSpots(request, env) {
  if (!env.DB) return json({ error: 'D1 binding "DB" is not configured' }, 500);
  const url = new URL(request.url);
  // /api/spots  or  /api/spots/<id>
  const rest = url.pathname.slice('/api/spots'.length).replace(/^\/+/, '');
  const id = rest ? decodeURIComponent(rest) : '';

  if (!id) {
    if (request.method === 'GET') return getSpots(request, env);
    if (request.method === 'POST') return postSpot(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (request.method === 'PATCH') return patchSpot(request, env, id);
  if (request.method === 'DELETE') return deleteSpot(request, env, id);
  return json({ error: 'Method not allowed' }, 405);
}

/**
 * Geocode a free-text place/address to coordinates via OpenStreetMap Nominatim,
 * biased to the greater-Seattle area. Responses are cached for a day (Nominatim
 * asks consumers to cache + rate-limit), so repeated lookups don't re-hit them.
 */
async function geocode(request, env, ctx) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'q query param is required' }, 400);

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://geocode.internal/?q=' + encodeURIComponent(q.toLowerCase()));
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const upstream = new URL('https://nominatim.openstreetmap.org/search');
  upstream.searchParams.set('q', q);
  upstream.searchParams.set('format', 'jsonv2');
  upstream.searchParams.set('limit', '1');
  // Greater-Seattle viewbox (left,top,right,bottom) to bias results locally.
  upstream.searchParams.set('viewbox', '-122.55,47.80,-122.18,47.40');
  upstream.searchParams.set('bounded', '0');

  let res;
  try {
    res = await fetch(upstream.toString(), {
      headers: { 'User-Agent': GEOCODER_UA, Accept: 'application/json', 'Accept-Language': 'en' },
    });
  } catch (_) {
    return json({ error: 'Geocoding service unavailable' }, 502);
  }
  if (!res.ok) return json({ error: `Geocoding failed (${res.status})` }, 502);

  let data;
  try {
    data = await res.json();
  } catch (_) {
    return json({ error: 'Bad geocoding response' }, 502);
  }

  const top = Array.isArray(data) && data.length ? data[0] : null;
  const result = top
    ? { lat: Number(top.lat), lng: Number(top.lon), label: top.display_name || q }
    : null;

  const out = json({ result });
  out.headers.set('cache-control', 'public, max-age=86400');
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// King County publishes swim-beach bacteria + water temperature as Socrata
// open data (no key). https://data.kingcounty.gov/resource/mbzm-4r9y
const KC_WATER_URL = 'https://data.kingcounty.gov/resource/mbzm-4r9y.json';

/**
 * Latest King County swim-beach reading per (freshwater) beach. We pull the
 * current season's samples, reduce to the newest reading per beach, and cache
 * the result for 6 hours so the dashboard isn't re-queried on every page load.
 * Returns { source, updated, beaches: { name: {date, geomean30d, hightoday,
 * nsampleshigh30d, watertempf} } }; the client derives the status label/color.
 */
async function waterQuality(request, env, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://water.internal/kc');
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // Last ~150 days keeps us inside the (mid-May–mid-Sep) sampling season.
  const since = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const upstream = new URL(KC_WATER_URL);
  upstream.searchParams.set('$where', `date >= '${since}'`);
  upstream.searchParams.set('$order', 'date DESC');
  upstream.searchParams.set('$limit', '5000');

  let res;
  try {
    res = await fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
  } catch (_) {
    return json({ error: 'Water-quality service unavailable' }, 502);
  }
  if (!res.ok) return json({ error: `Water-quality fetch failed (${res.status})` }, 502);

  let rows;
  try {
    rows = await res.json();
  } catch (_) {
    return json({ error: 'Bad water-quality response' }, 502);
  }

  const beaches = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = row && row.beach;
    if (!name || beaches[name]) continue; // ordered date DESC -> first hit is latest
    beaches[name] = {
      date: row.date ? String(row.date).slice(0, 10) : null,
      geomean30d: toNum(row.geomean30d),
      hightoday: row.hightoday === true || row.hightoday === 'true',
      nsampleshigh30d: toNum(row.nsampleshigh30d),
      watertempf: toNum(row.watertempf),
    };
  }

  const out = json({
    source: 'King County Swim Beach Monitoring',
    updated: new Date().toISOString(),
    beaches,
  });
  out.headers.set('cache-control', 'public, max-age=21600');
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === '/api/geocode') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return geocode(request, env, ctx);
  }

  if (url.pathname === '/api/water') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return waterQuality(request, env, ctx);
  }

  if (url.pathname === '/api/spots' || url.pathname.startsWith('/api/spots/')) {
    try {
      return await handleSpots(request, env);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }

  if (url.pathname !== '/api/entries') {
    return json({ error: 'Not found' }, 404);
  }
  if (!env.DB) {
    return json({ error: 'D1 binding "DB" is not configured' }, 500);
  }
  try {
    switch (request.method) {
      case 'GET':
        return await getEntries(request, env);
      case 'PUT':
        return await putEntry(request, env);
      case 'DELETE':
        return await deleteEntry(request, env);
      default:
        return json({ error: 'Method not allowed' }, 405);
    }
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    // Everything else is a static asset (or a 404 from the assets handler).
    return env.ASSETS.fetch(request);
  },
};
