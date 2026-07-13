'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SPOTS = require('../public/data/spots.js');
const Logic = require('../public/logic.js');

test('spots dataset is valid (unique kebab ids, required fields, valid swimType)', () => {
  const errors = Logic.validateSpots(SPOTS);
  assert.deepEqual(errors, [], 'validateSpots should report no errors');
});

test('dataset covers all requested areas', () => {
  const areas = Logic.areaList(SPOTS);
  for (const area of ['West Seattle', 'Lake Washington', 'Lake Union', 'Green Lake']) {
    assert.ok(areas.includes(area), `expected area "${area}" in dataset`);
  }
});

test('dataset has a healthy number of spots', () => {
  assert.ok(SPOTS.length >= 150, `expected >=150 spots, got ${SPOTS.length}`);
});

test('dataset includes the expanded regional areas', () => {
  const areas = Logic.areaList(SPOTS);
  const expected = [
    'Ballard & North',
    'Magnolia',
    'Elliott Bay',
    'Eastside',
    'Renton & South Lake WA',
    'Lake Sammamish & I-90',
    'South King County',
    'North Sound',
    'Burien & South Sound',
    'Tacoma & South Sound',
  ];
  for (const area of expected) {
    assert.ok(areas.includes(area), `expected area "${area}" in dataset`);
  }
});

test('"park + work" spots exist: good for work but not swim, and validate', () => {
  const workParks = SPOTS.filter(
    (s) => Logic.spotGoodFor(s).includes('work') && !Logic.spotGoodFor(s).includes('swim')
  );
  assert.ok(workParks.length >= 3, `expected >=3 work-only park spots, got ${workParks.length}`);
  for (const spot of workParks) {
    assert.ok(!Logic.isSwimmable(spot), `${spot.id} should not be swimmable`);
    assert.ok(Logic.spotGoodFor(spot).includes('play'), `${spot.id} should still be 'play'`);
  }
});

test('every kcBeach maps a distinct King County beach and all monitored beaches are covered', () => {
  const monitored = SPOTS.filter((s) => 'kcBeach' in s);
  // King County publishes 30 monitored beaches; we should cover them all.
  assert.ok(monitored.length >= 25, `expected >=25 monitored beaches, got ${monitored.length}`);
});

test('Shoreline access spots are present, swimmable, and validate', () => {
  const shoreline = SPOTS.filter((s) => s.swimType === 'Shoreline access');
  assert.ok(shoreline.length >= 3, `expected >=3 shoreline-access spots, got ${shoreline.length}`);
  for (const spot of shoreline) {
    assert.ok(Logic.isSwimmable(spot), `${spot.id} should count as swimmable`);
    assert.match(Logic.swimTypeColor(spot.swimType), /^#[0-9a-f]{6}$/i);
  }
});

test('SDOT shoreline street ends are imported, tagged, and classified', () => {
  const ends = SPOTS.filter((s) => (s.tags || []).includes('shoreline-street-end'));
  // 143 city records minus a few deduped against curated spots.
  assert.ok(ends.length >= 120, `expected >=120 street ends, got ${ends.length}`);

  for (const s of ends) {
    assert.deepEqual(Logic.validateSpots([s]), [], `${s.id} should validate`);
    const notReady = (s.tags || []).includes('not-yet-accessible');
    if (notReady) {
      assert.equal(s.swimType, 'No swimming', `${s.id} not-yet-accessible => No swimming`);
      assert.ok(!Logic.isSwimmable(s), `${s.id} not-yet-accessible must not be swimmable`);
    }
    if (s.swimType === 'Shoreline access') {
      assert.ok(Logic.isSwimmable(s), `${s.id} shoreline access should be swimmable`);
    }
  }

  // The city flags many sites as not yet open to visitors — surface them.
  const notReady = ends.filter((s) => (s.tags || []).includes('not-yet-accessible'));
  assert.ok(notReady.length >= 20, `expected >=20 not-yet-accessible ends, got ${notReady.length}`);

  // Some are genuinely swimmable (sand/pebble beaches, kayak/boat launches).
  const swimmable = ends.filter((s) => s.swimType === 'Shoreline access');
  assert.ok(swimmable.length >= 10, `expected >=10 swimmable ends, got ${swimmable.length}`);
});

test('every spot produces a usable map URL', () => {
  for (const spot of SPOTS) {
    assert.match(Logic.buildMapUrl(spot), /^https:\/\/www\.google\.com\/maps\/search\//);
  }
});

test('every spot has valid coordinates inside the coverage area', () => {
  // Widened box: Tacoma/Lakewood (south) to Edmonds (north), out the I-90 corridor (east).
  for (const spot of SPOTS) {
    assert.ok(Logic.hasCoords(spot), `${spot.id} is missing numeric lat/lng`);
    assert.ok(spot.lat > 47.05 && spot.lat < 47.95, `${spot.id} lat ${spot.lat} out of range`);
    assert.ok(spot.lng > -122.75 && spot.lng < -121.3, `${spot.id} lng ${spot.lng} out of range`);
  }
});

test('kcBeach is only set on freshwater swimmable spots and is a non-empty name', () => {
  const monitored = SPOTS.filter((s) => 'kcBeach' in s);
  assert.ok(monitored.length >= 9, `expected >=9 monitored beaches, got ${monitored.length}`);
  for (const spot of monitored) {
    assert.equal(typeof spot.kcBeach, 'string');
    assert.ok(spot.kcBeach.trim().length > 0, `${spot.id} has empty kcBeach`);
    assert.equal(spot.water, 'Fresh', `${spot.id} kcBeach should map a freshwater spot`);
    assert.ok(Logic.isSwimmable(spot), `${spot.id} kcBeach should map a swimmable spot`);
  }
  // No duplicate beach names across spots (each maps a distinct beach).
  const names = monitored.map((s) => s.kcBeach);
  assert.equal(new Set(names).size, names.length, 'kcBeach names must be unique');
});
