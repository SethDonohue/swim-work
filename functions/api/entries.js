/*
 * Cloudflare Pages Function — /api/entries
 *
 * Backed by a D1 database bound as `DB` (see wrangler.toml + schema.sql).
 * One row per (spot_id, author_id): the author's visited flag, rating, and note.
 *
 * GET    /api/entries            -> { entries: [...] }   (all authors, all spots)
 * GET    /api/entries?spotId=ID  -> { entries: [...] }   (single spot)
 * PUT    /api/entries            -> upsert one entry (JSON body)
 * DELETE /api/entries?spotId=&authorId=  -> delete one entry
 *
 * NOTE: there is no authentication yet — the author identity comes straight
 * from the client's local profile. Anyone could write as anyone. This is the
 * documented "keep it simple first" trade-off; gate it behind Cloudflare
 * Access (and/or verify identity server-side) before treating it as trusted.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: JSON_HEADERS,
  });
}

function rowToEntry(row) {
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

function clampRating(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 5 ? 5 : n;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'D1 binding "DB" is not configured' }, 500);

  const url = new URL(request.url);
  const spotId = url.searchParams.get('spotId');

  try {
    const stmt = spotId
      ? env.DB.prepare(
          'SELECT * FROM entries WHERE spot_id = ? ORDER BY updated_at DESC'
        ).bind(spotId)
      : env.DB.prepare('SELECT * FROM entries ORDER BY updated_at DESC');

    const { results } = await stmt.all();
    return json({ entries: (results || []).map(rowToEntry) });
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

export async function onRequestPut(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'D1 binding "DB" is not configured' }, 500);

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

  try {
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
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

export async function onRequestDelete(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'D1 binding "DB" is not configured' }, 500);

  const url = new URL(request.url);
  const spotId = url.searchParams.get('spotId');
  const authorId = url.searchParams.get('authorId');
  if (!spotId || !authorId) {
    return json({ error: 'spotId and authorId query params are required' }, 400);
  }

  try {
    await env.DB.prepare('DELETE FROM entries WHERE spot_id = ? AND author_id = ?')
      .bind(spotId, authorId)
      .run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}
