'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Logic = require('../public/logic.js');

test('isSwimmable distinguishes water access from view-only spots', () => {
  assert.equal(Logic.isSwimmable({ swimType: 'Lifeguarded beach' }), true);
  assert.equal(Logic.isSwimmable({ swimType: 'Heated pool' }), true);
  assert.equal(Logic.isSwimmable({ swimType: 'Saltwater beach' }), true);
  assert.equal(Logic.isSwimmable({ swimType: 'Beach (no lifeguard)' }), true);
  assert.equal(Logic.isSwimmable({ swimType: 'Shoreline access' }), true);
  assert.equal(Logic.isSwimmable({ swimType: 'No swimming' }), false);
  assert.equal(Logic.isSwimmable({ swimType: 'Tide pools' }), false);
});

test('user-submitted spot permission helpers', () => {
  const mine = { userSubmitted: true, authorId: 'a1', isPublic: false };
  const minePublic = { userSubmitted: true, authorId: 'a1', isPublic: true };
  const theirs = { userSubmitted: true, authorId: 'a2', isPublic: false };
  const curated = { swimType: 'Lifeguarded beach' };

  assert.equal(Logic.isUserSubmitted(mine), true);
  assert.equal(Logic.isUserSubmitted(curated), false);

  // Author can edit their own spots (public or private); nobody edits curated/others.
  assert.equal(Logic.canEditSpot(mine, 'a1'), true);
  assert.equal(Logic.canEditSpot(minePublic, 'a1'), true);
  assert.equal(Logic.canEditSpot(theirs, 'a1'), false);
  assert.equal(Logic.canEditSpot(curated, 'a1'), false);

  // Delete only own *private* spots — public spots are permanent.
  assert.equal(Logic.canDeleteSpot(mine, 'a1'), true);
  assert.equal(Logic.canDeleteSpot(minePublic, 'a1'), false);
  assert.equal(Logic.canDeleteSpot(theirs, 'a1'), false);
});

test('normalizeEntry caps a note at NOTE_MAX (250) chars', () => {
  const entry = Logic.normalizeEntry({ spotId: 's', authorId: 'a', comment: 'y'.repeat(600) });
  assert.equal(entry.comment.length, Logic.NOTE_MAX);
  assert.equal(Logic.NOTE_MAX, 250);
});

test('buildMapUrl encodes name + address', () => {
  const url = Logic.buildMapUrl({ name: 'Alki Beach', address: '1702 Alki Ave SW' });
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(url, /Alki%20Beach/);
});

test('swimTypeColor returns a hex color per type with a fallback', () => {
  assert.equal(Logic.swimTypeColor('Lifeguarded beach'), '#1f9d55');
  assert.equal(Logic.swimTypeColor('Heated pool'), '#0d7fb8');
  assert.equal(Logic.swimTypeColor('Shoreline access'), '#0e9aa7');
  assert.match(Logic.swimTypeColor('Tide pools'), /^#[0-9a-f]{6}$/i);
  assert.match(Logic.swimTypeColor('something unknown'), /^#[0-9a-f]{6}$/i);
});

test('hasCoords only accepts finite numeric lat/lng', () => {
  assert.equal(Logic.hasCoords({ lat: 47.6, lng: -122.3 }), true);
  assert.equal(Logic.hasCoords({ lat: '47.6', lng: -122.3 }), false);
  assert.equal(Logic.hasCoords({ lat: NaN, lng: -122.3 }), false);
  assert.equal(Logic.hasCoords({}), false);
  assert.equal(Logic.hasCoords(null), false);
});

test('haversineKm: 0 for same point, sane for close points, Infinity for bad input', () => {
  assert.equal(Logic.haversineKm({ lat: 47.6, lng: -122.3 }, { lat: 47.6, lng: -122.3 }), 0);
  const d = Logic.haversineKm({ lat: 47.61, lng: -122.33 }, { lat: 47.62, lng: -122.34 });
  assert.ok(d > 0 && d < 3, `expected a small distance, got ${d}`);
  assert.equal(Logic.haversineKm({ lat: 47.6, lng: -122.3 }, { lat: 'x' }), Infinity);
});

test('averageRating averages only non-zero ratings for the spot', () => {
  const entries = [
    { spotId: 'a', authorId: 'x', rating: 4 },
    { spotId: 'a', authorId: 'y', rating: 2 },
    { spotId: 'a', authorId: 'z', rating: 0 },
    { spotId: 'b', authorId: 'x', rating: 5 },
  ];
  assert.deepEqual(Logic.averageRating(entries, 'a'), { avg: 3, count: 2 });
  assert.deepEqual(Logic.averageRating(entries, 'none'), { avg: 0, count: 0 });
});

test('recommendSwimSpots ranks nearest swimmable spots and excludes non-swimmable', () => {
  const spots = [
    { id: 'near-pool', swimType: 'Heated pool', lat: 47.601, lng: -122.301 },
    { id: 'far-life', swimType: 'Lifeguarded beach', lat: 47.7, lng: -122.4 },
    { id: 'near-noswim', swimType: 'No swimming', lat: 47.6005, lng: -122.3005 },
  ];
  const recs = Logic.recommendSwimSpots(spots, { lat: 47.6, lng: -122.3 }, [], { limit: 3 });
  assert.ok(!recs.find((r) => r.spot.id === 'near-noswim'), 'no-swimming spot excluded');
  assert.equal(recs[0].spot.id, 'near-pool', 'nearest swimmable first');
  assert.ok(recs[0].distanceKm < recs[1].distanceKm);
});

test('recommendSwimSpots breaks near-ties with the higher-rated spot', () => {
  const spots = [
    { id: 'plain', swimType: 'Saltwater beach', lat: 47.602, lng: -122.3 },
    { id: 'loved', swimType: 'Saltwater beach', lat: 47.602, lng: -122.3 },
  ];
  const entries = [
    { spotId: 'loved', authorId: 'a', rating: 5 },
    { spotId: 'loved', authorId: 'b', rating: 5 },
  ];
  const recs = Logic.recommendSwimSpots(spots, { lat: 47.6, lng: -122.3 }, entries, { limit: 2 });
  assert.equal(recs[0].spot.id, 'loved');
});

test('recommendSwimSpots returns [] without a valid origin', () => {
  assert.deepEqual(Logic.recommendSwimSpots([{ id: 'a', swimType: 'Heated pool', lat: 47.6, lng: -122.3 }], null, []), []);
});

test('waterStatus maps King County records to an advisory', () => {
  assert.equal(Logic.waterStatus(null), 'unknown', 'no record -> unknown');
  assert.equal(Logic.waterStatus({ hightoday: true, geomean30d: 5 }), 'high', 'flagged today -> high');
  assert.equal(Logic.waterStatus({ hightoday: 'true', geomean30d: 5 }), 'high', 'string boolean -> high');
  assert.equal(Logic.waterStatus({ hightoday: false, geomean30d: 200 }), 'caution', 'over limit -> caution');
  assert.equal(Logic.waterStatus({ hightoday: false, geomean30d: '14.5' }), 'ok', 'string geomean within limit -> ok');
  assert.equal(Logic.waterStatus({ hightoday: false, geomean30d: 126 }), 'ok', 'exactly at the limit is still ok');
  assert.equal(Logic.waterStatus({ hightoday: false, geomean30d: null }), 'unknown', 'no geomean -> unknown');
});

test('water status has a label + hex color for every status', () => {
  for (const status of ['ok', 'caution', 'high', 'unknown', 'unmonitored']) {
    assert.equal(typeof Logic.WATER_STATUS_LABELS[status], 'string');
    assert.match(Logic.WATER_STATUS_COLORS[status], /^#[0-9a-f]{6}$/i);
  }
});

test('coerceRating clamps to integer 0..5', () => {
  assert.equal(Logic.coerceRating(3), 3);
  assert.equal(Logic.coerceRating('4'), 4);
  assert.equal(Logic.coerceRating(9), 5);
  assert.equal(Logic.coerceRating(-2), 0);
  assert.equal(Logic.coerceRating(2.6), 3);
  assert.equal(Logic.coerceRating('nope'), 0);
});

test('spotMatchesFilters handles area, swimmable, and text query', () => {
  const spot = {
    name: 'Seward Park Beach',
    area: 'Lake Washington',
    swimType: 'Lifeguarded beach',
    swim: 'forested peninsula',
    cafe: 'Caffe Vita',
    shade: 'old-growth forest',
    tags: ['shaded', 'top-pick'],
  };
  assert.equal(Logic.spotMatchesFilters(spot, { area: 'All' }), true);
  assert.equal(Logic.spotMatchesFilters(spot, { area: 'West Seattle' }), false);
  assert.equal(Logic.spotMatchesFilters(spot, { swimmableOnly: true }), true);
  assert.equal(Logic.spotMatchesFilters(spot, { query: 'vita' }), true);
  assert.equal(Logic.spotMatchesFilters(spot, { query: 'top-pick' }), true);
  assert.equal(Logic.spotMatchesFilters(spot, { query: 'ballard' }), false);

  const viewOnly = { ...spot, swimType: 'No swimming' };
  assert.equal(Logic.spotMatchesFilters(viewOnly, { swimmableOnly: true }), false);
});

test('spotGoodFor derives swim/play/work and honors explicit goodFor', () => {
  assert.deepEqual(
    Logic.spotGoodFor({ swimType: 'Lifeguarded beach', tags: ['wifi-cafe'] }).sort(),
    ['play', 'swim', 'work']
  );
  assert.deepEqual(
    Logic.spotGoodFor({ swimType: 'Beach (no lifeguard)', tags: [] }).sort(),
    ['play', 'swim']
  );
  // A no-swimming "work-with-a-view" stop is play + work.
  assert.deepEqual(Logic.spotGoodFor({ swimType: 'No swimming' }).sort(), ['play', 'work']);
  // Explicit goodFor wins and is filtered down to valid categories.
  assert.deepEqual(
    Logic.spotGoodFor({ swimType: 'Lifeguarded beach', goodFor: ['work', 'bogus'] }),
    ['work']
  );
});

test('isSwimmable respects explicit goodFor over swimType', () => {
  assert.equal(Logic.isSwimmable({ swimType: 'No swimming', goodFor: ['play', 'work'] }), false);
  assert.equal(
    Logic.isSwimmable({ swimType: 'Lifeguarded beach', goodFor: ['play', 'work'] }),
    false,
    'explicit goodFor without swim overrides a swimmable swimType'
  );
});

test('spotMatchesFilters supports the category filter (all/swim/play/work)', () => {
  const swimWork = { area: 'Eastside', swimType: 'Lifeguarded beach', tags: ['wifi-cafe'] };
  const workPark = { area: 'Eastside', swimType: 'No swimming', goodFor: ['play', 'work'] };
  assert.equal(Logic.spotMatchesFilters(swimWork, { category: 'all' }), true);
  assert.equal(Logic.spotMatchesFilters(swimWork, { category: 'swim' }), true);
  assert.equal(Logic.spotMatchesFilters(swimWork, { category: 'work' }), true);
  assert.equal(Logic.spotMatchesFilters(workPark, { category: 'swim' }), false);
  assert.equal(Logic.spotMatchesFilters(workPark, { category: 'play' }), true);
  assert.equal(Logic.spotMatchesFilters(workPark, { category: 'work' }), true);
  // Legacy swimmableOnly still maps to the swim category.
  assert.equal(Logic.spotMatchesFilters(workPark, { swimmableOnly: true }), false);
});

test('myEntry / upsertEntry round-trip by (spotId, authorId)', () => {
  let entries = [];
  const a = { spotId: 's1', authorId: 'me', visited: true, rating: 4, comment: 'hi' };
  entries = Logic.upsertEntry(entries, a);
  assert.equal(entries.length, 1);
  assert.deepEqual(Logic.myEntry(entries, 's1', 'me'), a);

  const updated = { ...a, comment: 'changed' };
  entries = Logic.upsertEntry(entries, updated);
  assert.equal(entries.length, 1, 'upsert replaces, does not duplicate');
  assert.equal(Logic.myEntry(entries, 's1', 'me').comment, 'changed');

  assert.equal(Logic.myEntry(entries, 's1', 'someone-else'), null);
});

test('othersEntriesForSpot excludes me + empty notes, sorts newest-first', () => {
  const entries = [
    { spotId: 's1', authorId: 'me', comment: 'mine', updatedAt: '2026-06-01' },
    { spotId: 's1', authorId: 'b', comment: 'older', rating: 3, updatedAt: '2026-06-02' },
    { spotId: 's1', authorId: 'c', comment: 'newer', rating: 5, updatedAt: '2026-06-10' },
    { spotId: 's1', authorId: 'd', comment: '', rating: 0, updatedAt: '2026-06-09' }, // empty -> excluded
    { spotId: 's2', authorId: 'e', comment: 'other spot', updatedAt: '2026-06-11' },
  ];
  const others = Logic.othersEntriesForSpot(entries, 's1', 'me');
  assert.deepEqual(others.map((e) => e.authorId), ['c', 'b']);
});

test('progressStats counts visited / rated / commented for one author', () => {
  const spots = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
  const entries = [
    { spotId: 's1', authorId: 'me', visited: true, rating: 4, comment: 'great' },
    { spotId: 's2', authorId: 'me', visited: false, rating: 0, comment: '' },
    { spotId: 's3', authorId: 'other', visited: true, rating: 5, comment: 'theirs' },
  ];
  const stats = Logic.progressStats(spots, entries, 'me');
  assert.deepEqual(stats, { total: 3, visited: 1, rated: 1, commented: 1 });
});

test('normalizeEntry trims, clamps, and flags empty entries', () => {
  const empty = Logic.normalizeEntry({ spotId: 's1', authorId: 'me' });
  assert.equal(empty._empty, true);

  const full = Logic.normalizeEntry({
    spotId: 's1',
    authorId: 'me',
    authorName: 'Seth',
    visited: true,
    rating: 99,
    comment: '  nice  ',
  });
  assert.equal(full.rating, 5);
  assert.equal(full.visited, true);
  assert.ok(!full._empty);

  assert.equal(Logic.normalizeEntry({}), null, 'missing keys -> null');
});
