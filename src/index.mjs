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
 * PUT    /api/entries            -> upsert one entry (JSON body)
 * DELETE /api/entries?spotId=&authorId=  -> delete one entry
 *
 * NOTE: there is no authentication yet — the author identity comes from the
 * client's local profile, so anyone could write as anyone. This is the
 * documented "keep it simple first" trade-off; gate it behind Cloudflare Access
 * (and verify identity server-side) before treating it as trusted.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

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
    updatedAt: row.updated_at,
  };
}

export function clampRating(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 5 ? 5 : n;
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
    comment: String(body.comment || '').slice(0, 2000),
    updated_at: new Date().toISOString(),
  };

  await env.DB.prepare(
    `INSERT INTO entries (spot_id, author_id, author_name, visited, rating, comment, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(spot_id, author_id) DO UPDATE SET
       author_name = excluded.author_name,
       visited     = excluded.visited,
       rating      = excluded.rating,
       comment     = excluded.comment,
       updated_at  = excluded.updated_at`
  )
    .bind(
      entry.spot_id,
      entry.author_id,
      entry.author_name,
      entry.visited,
      entry.rating,
      entry.comment,
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

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === '/api/geocode') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return geocode(request, env, ctx);
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
