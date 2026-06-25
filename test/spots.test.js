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
  assert.ok(SPOTS.length >= 18, `expected >=18 spots, got ${SPOTS.length}`);
});

test('every spot produces a usable map URL', () => {
  for (const spot of SPOTS) {
    assert.match(Logic.buildMapUrl(spot), /^https:\/\/www\.google\.com\/maps\/search\//);
  }
});
