/*
 * Generate public/data/street-ends.js from SDOT's "Shoreline Street Ends"
 * ArcGIS layer (149 designated public shoreline access points; 143 live records).
 *
 * Run:  node scripts/gen-street-ends.mjs
 *
 * Output is committed static data (matches the app's offline-friendly model) —
 * re-run only to refresh from the city. Each street end:
 *   - inherits `area` + `water` from the nearest curated spot (consistent tabs)
 *   - is auto-classified swim vs play/view-only from SDOT's description
 *   - is tagged 'not-yet-accessible' when the site isn't in service (INSVC)
 *   - is deduped against curated spots that already cover the same point
 *
 * Data © City of Seattle / SDOT (public domain open data).
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CURATED = require('../public/data/spots.js');

const LAYER =
  'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/' +
  'Shoreline_Street_Ends/FeatureServer/0/query';

const DEDUPE_METERS = 45; // a generated end this close to a curated spot is the same place

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function nearestCurated(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const s of CURATED) {
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue;
    const d = haversineM({ lat, lng }, s);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { spot: best, meters: bestD };
}

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']);
const STREET_TYPES = {
  st: 'St', ave: 'Ave', av: 'Ave', pl: 'Pl', way: 'Way', blvd: 'Blvd',
  dr: 'Dr', ct: 'Ct', ln: 'Ln', rd: 'Rd', ter: 'Ter', pkwy: 'Pkwy', rdwy: 'Rdwy',
};

function smartTitle(str) {
  return str
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      if (DIRECTIONALS.has(tok)) return tok.toUpperCase();
      if (STREET_TYPES[tok]) return STREET_TYPES[tok];
      if (/^\d+(st|nd|rd|th)$/.test(tok)) return tok; // ordinals: 3rd, 28th
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(' ');
}

/** Split SDOT's UNITDESC ("<label>\r| <address>   <description>") into parts. */
function parseUnitDesc(raw) {
  const clean = String(raw || '').replace(/[\r\n]+/g, ' ');
  const pipe = clean.indexOf('|');
  const label = (pipe === -1 ? clean : clean.slice(0, pipe)).trim();
  const rest = (pipe === -1 ? '' : clean.slice(pipe + 1)).trim();
  const m = rest.match(/^(\S.*?)\s{2,}(.*)$/);
  let address = '';
  let description = '';
  if (m) {
    address = m[1].trim();
    description = m[2].replace(/\s+/g, ' ').trim();
  } else {
    description = rest.replace(/\s+/g, ' ').trim();
  }
  // Some records single-space the address into the description ("4850R SW BRACE
  // POINT DR A narrow road..."). Strip a leading run of ALL-CAPS / numeric
  // address tokens; stop at the first token containing a lowercase letter.
  const stripped = stripLeadingAddress(description);
  if (!address && stripped.removed) address = stripped.removed;
  description = stripped.text;
  return { label, address, description };
}

function stripLeadingAddress(text) {
  const tokens = text.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^(\d+[A-Z]?|[A-Z0-9]{2,}|N|S|E|W)$/.test(tokens[i])) i += 1;
  if (i === 0) return { text, removed: '' };
  return { text: tokens.slice(i).join(' ').trim(), removed: tokens.slice(0, i).join(' ') };
}

const NOT_SWIM = /(fire station|not ready|not yet|no beach|no swimming|steep|riprap|industrial|closed to|no public access|no access|viewpoint|overlook|privately owned|private property|not open to the public)/i;
const SWIM_HINT = /(beach|swim|wade|wading|kayak|paddle|boat launch|\blaunch\b|sandy|gravel beach|dip|into the water|dock)/i;
const WORK_HINT = /(bench|seating|picnic|table|lawn|grass|green space|public art|\bart\b|garden|plaza|shade)/i;

function kebab(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// fetch + build
// ---------------------------------------------------------------------------
async function main() {
  const url = new URL(LAYER);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', 'UNITID,UNITDESC,INTERSECTION,CURRENT_STATUS');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'json');
  url.searchParams.set('resultRecordCount', '400');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ArcGIS fetch failed: ${res.status}`);
  const data = await res.json();
  const feats = data.features || [];
  console.error(`fetched ${feats.length} street-end records`);

  const spots = [];
  const seenIds = new Set();
  let deduped = 0;
  let notAccessible = 0;
  let swimmable = 0;

  for (const f of feats) {
    const a = f.attributes || {};
    const g = f.geometry || {};
    const lat = g.y;
    const lng = g.x;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    const near = nearestCurated(lat, lng);
    if (near.meters < DEDUPE_METERS) {
      deduped += 1;
      continue; // curated data already covers this point
    }

    const { label, address, description } = parseUnitDesc(a.UNITDESC);
    const primary = (label.split('/')[0] || label).trim() || 'Shoreline';
    const name = `${smartTitle(primary)} Shoreline Street End`;

    const id = 'street-end-' + kebab(a.UNITID || `${lat}-${lng}`);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const inService = a.CURRENT_STATUS === 'INSVC';
    const isSwim = inService && !NOT_SWIM.test(description) && SWIM_HINT.test(description);
    const isWork = WORK_HINT.test(description);

    let swimType;
    let goodFor;
    const tags = ['shoreline-street-end', 'sdot'];
    tags.push(near.spot && near.spot.water === 'Salt' ? 'saltwater' : 'freshwater');

    let swim;
    if (!inService) {
      notAccessible += 1;
      swimType = 'No swimming';
      goodFor = ['play'];
      tags.push('not-yet-accessible');
      swim =
        'Not yet open to visitors — a designated SDOT shoreline street end awaiting improvements. ' +
        (description || 'Public right-of-way to the water.');
    } else if (isSwim) {
      swimmable += 1;
      swimType = 'Shoreline access';
      goodFor = isWork ? ['swim', 'play', 'work'] : ['swim', 'play'];
      swim = description || 'Public SDOT shoreline street end with informal water access (unmonitored; no lifeguard).';
    } else {
      swimType = 'No swimming';
      goodFor = isWork ? ['play', 'work'] : ['play'];
      swim = description || 'Public SDOT shoreline street end — shoreline/park access (not a designated swim spot).';
    }
    if (/kayak|paddle|launch/i.test(description)) tags.push('paddle');

    spots.push({
      id,
      name,
      area: (near.spot && near.spot.area) || 'Lake Union',
      address: address ? `${address.replace(/(\d+)R\b/, '$1')}, Seattle, WA` : `${smartTitle(primary)}, Seattle, WA`,
      lat: Number(lat.toFixed(5)),
      lng: Number(lng.toFixed(5)),
      swimType,
      water: (near.spot && near.spot.water) || 'Fresh',
      swim: swim.slice(0, 400),
      cafe: 'No cafe on-site — grab coffee nearby and bring a mobile hotspot.',
      shade: 'Exposed shoreline access — bring your own shade.',
      goodFor,
      tags,
    });
  }

  spots.sort((x, y) => x.id.localeCompare(y.id));

  console.error(
    `built ${spots.length} spots (deduped ${deduped}, swimmable ${swimmable}, ` +
      `not-yet-accessible ${notAccessible})`
  );

  const header = `/*
 * SDOT Shoreline Street Ends — GENERATED FILE, do not edit by hand.
 * Regenerate with:  node scripts/gen-street-ends.mjs
 *
 * Source: City of Seattle / SDOT "Shoreline Street Ends" ArcGIS layer.
 * ${spots.length} public shoreline street ends across Seattle. Each is deduped
 * against the curated dataset, inherits area/water from the nearest curated
 * spot, and is auto-classified swim vs play/view-only from SDOT's description.
 * Sites not yet "in service" are tagged 'not-yet-accessible'.
 *
 * Loaded as a global (STREET_END_SPOTS) before data/spots.js, which appends it.
 */
const STREET_END_SPOTS = ${JSON.stringify(spots, null, 2)};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = STREET_END_SPOTS;
}
`;

  const outPath = join(__dirname, '..', 'public', 'data', 'street-ends.js');
  writeFileSync(outPath, header);
  console.error(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
