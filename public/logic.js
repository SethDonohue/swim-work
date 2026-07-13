/*
 * Pure, framework-free logic shared by the browser app and the Node tests.
 * No DOM access in here — keep it testable.
 */
const Logic = {
  /** Swim types that count as "you can actually get in the water". */
  SWIMMABLE_TYPES: [
    'Lifeguarded beach',
    'Heated pool',
    'Saltwater beach',
    'Beach (no lifeguard)',
    'Shoreline access',
  ],

  /** The three things a spot can be "good for" (drives the category filter). */
  CATEGORIES: ['swim', 'play', 'work'],

  /** Max length of a per-user note/comment (one per user per spot). */
  NOTE_MAX: 250,

  /** True for a community-submitted (user-created) spot. */
  isUserSubmitted(spot) {
    return !!(spot && spot.userSubmitted);
  },

  /**
   * Can `authorId` edit this spot? Only the author of a user-submitted spot.
   * (Public spots stay editable by their author; curated spots are never editable.)
   */
  canEditSpot(spot, authorId) {
    return Logic.isUserSubmitted(spot) && !!authorId && spot.authorId === authorId;
  },

  /**
   * Can `authorId` delete this spot? Only the author, and only while it's still
   * private — once a spot is made public it's permanent.
   */
  canDeleteSpot(spot, authorId) {
    return Logic.canEditSpot(spot, authorId) && !spot.isPublic;
  },

  /** Tags that mark a spot as remote-work friendly (cafe wifi / work stop). */
  WORK_TAGS: ['wifi-cafe', 'work-spot', 'lake-view-cafe'],

  isSwimmableType(swimType) {
    return Logic.SWIMMABLE_TYPES.indexOf(swimType) !== -1;
  },

  /**
   * What a spot is good for — any subset of swim / play / work. Uses an
   * explicit `spot.goodFor` when provided; otherwise derives it: swimmable
   * swim types get 'swim', every spot is 'play', and work-friendly spots (a
   * wifi-cafe / work tag, or a no-swim "work-with-a-view" stop) get 'work'.
   */
  spotGoodFor(spot) {
    if (!spot) return [];
    if (Array.isArray(spot.goodFor) && spot.goodFor.length) {
      return spot.goodFor.filter((g) => Logic.CATEGORIES.indexOf(g) !== -1);
    }
    const g = [];
    if (Logic.isSwimmableType(spot.swimType)) g.push('swim');
    g.push('play');
    const tags = spot.tags || [];
    const workTag = tags.some((t) => Logic.WORK_TAGS.indexOf(t) !== -1);
    if (workTag || spot.swimType === 'No swimming') g.push('work');
    return g;
  },

  isSwimmable(spot) {
    return Logic.spotGoodFor(spot).indexOf('swim') !== -1;
  },

  /** Marker / swatch color per swim type (kept here so the map + tests agree). */
  SWIM_TYPE_COLORS: {
    'Lifeguarded beach': '#1f9d55',
    'Heated pool': '#0d7fb8',
    'Saltwater beach': '#b8860d',
    'Beach (no lifeguard)': '#b8860d',
    'Shoreline access': '#0e9aa7',
    'Tide pools': '#7a5cc0',
    'No swimming': '#8aa0b3',
  },

  swimTypeColor(swimType) {
    return Logic.SWIM_TYPE_COLORS[swimType] || '#8aa0b3';
  },

  /** True when a spot has finite numeric coordinates we can map. */
  hasCoords(spot) {
    return (
      !!spot &&
      typeof spot.lat === 'number' &&
      typeof spot.lng === 'number' &&
      Number.isFinite(spot.lat) &&
      Number.isFinite(spot.lng)
    );
  },

  /** Great-circle distance in km between two {lat,lng} points (Haversine). */
  haversineKm(a, b) {
    if (!Logic.hasCoords(a) || !Logic.hasCoords(b)) return Infinity;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371; // earth radius, km
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  },

  /** Average of the non-zero ratings for a spot across all authors. */
  averageRating(entries, spotId) {
    const vals = (entries || [])
      .filter((e) => e.spotId === spotId)
      .map((e) => Logic.coerceRating(e.rating))
      .filter((r) => r > 0);
    if (!vals.length) return { avg: 0, count: 0 };
    const sum = vals.reduce((a, b) => a + b, 0);
    return { avg: sum / vals.length, count: vals.length };
  },

  /**
   * Weighting for the "best nearby swim" score. Distance dominates (it's a
   * *nearby* recommendation) but community rating breaks near-ties and lifts
   * well-loved spots. Unrated spots get a neutral prior so they aren't buried.
   */
  RECOMMEND_WEIGHTS: { distance: 0.7, rating: 0.3, neutralRating: 0.5 },

  /**
   * Rank swimmable spots near an origin {lat,lng}, blending closeness with
   * community rating. Returns up to opts.limit items:
   *   { spot, distanceKm, avgRating, ratingCount, score }  (best first)
   */
  recommendSwimSpots(spots, origin, entries, opts) {
    const options = opts || {};
    const limit = options.limit || 3;
    if (!Logic.hasCoords(origin)) return [];
    const w = Logic.RECOMMEND_WEIGHTS;
    const scored = (spots || [])
      .filter((s) => Logic.isSwimmable(s) && Logic.hasCoords(s))
      .map((spot) => {
        const distanceKm = Logic.haversineKm(origin, spot);
        const { avg, count } = Logic.averageRating(entries, spot.id);
        const distanceScore = 1 / (1 + distanceKm); // 1 at 0km, falls off with distance
        const ratingNorm = count > 0 ? avg / 5 : w.neutralRating;
        const score = w.distance * distanceScore + w.rating * ratingNorm;
        return { spot, distanceKm, avgRating: avg, ratingCount: count, score };
      });
    scored.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
    return scored.slice(0, limit);
  },

  /**
   * EPA recreational-water threshold for the 30-day E. coli geometric mean
   * (MPN/100mL). Above this, freshwater is flagged for caution.
   */
  WATER_GEOMEAN_LIMIT: 126,

  /** Human labels for each derived water-quality status. */
  WATER_STATUS_LABELS: {
    ok: 'Good',
    caution: 'Caution',
    high: 'High bacteria',
    unknown: 'No recent data',
    unmonitored: 'Not monitored',
  },

  /** Status colors (kept beside the labels so card chips + tests agree). */
  WATER_STATUS_COLORS: {
    ok: '#1f9d55',
    caution: '#b8860d',
    high: '#c0392b',
    unknown: '#8aa0b3',
    unmonitored: '#8aa0b3',
  },

  /**
   * Derive an advisory from a King County swim-beach record. The dataset
   * reports bacteria levels (not an official open/closed call), so we map
   * conservatively: a sample flagged high today -> 'high'; a 30-day geomean
   * over the EPA limit -> 'caution'; otherwise 'ok'. Missing data -> 'unknown'.
   */
  waterStatus(rec) {
    if (!rec) return 'unknown';
    if (rec.hightoday === true || rec.hightoday === 'true') return 'high';
    const raw = rec.geomean30d;
    if (raw === null || raw === undefined || raw === '') return 'unknown';
    const gm = Number(raw); // guard above: Number(null/'') is 0 and would read as "ok"
    if (Number.isFinite(gm)) return gm > Logic.WATER_GEOMEAN_LIMIT ? 'caution' : 'ok';
    return 'unknown';
  },

  /** Google Maps search link from the spot's name + address. */
  buildMapUrl(spot) {
    const query = encodeURIComponent(`${spot.name} ${spot.address || ''}`.trim());
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  },

  /** Clamp a rating to an integer 0–5 (0 == no rating). */
  coerceRating(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    if (n > 5) return 5;
    return n;
  },

  /** Distinct, stable-ordered list of areas as they appear in the data. */
  areaList(spots) {
    const seen = [];
    for (const spot of spots) {
      if (seen.indexOf(spot.area) === -1) seen.push(spot.area);
    }
    return seen;
  },

  /** Does a spot pass the active filters? */
  spotMatchesFilters(spot, filters) {
    const f = filters || {};
    if (f.area && f.area !== 'All' && spot.area !== f.area) return false;
    // `category` supersedes the legacy `swimmableOnly` flag ('swim' == old behavior).
    const category = f.category || (f.swimmableOnly ? 'swim' : 'all');
    if (category && category !== 'all' && Logic.spotGoodFor(spot).indexOf(category) === -1) {
      return false;
    }
    const q = (f.query || '').trim().toLowerCase();
    if (q) {
      const haystack = [
        spot.name,
        spot.area,
        spot.swim,
        spot.cafe,
        spot.shade,
        (spot.tags || []).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }
    return true;
  },

  /** The current user's entry for a spot, if any. */
  myEntry(entries, spotId, authorId) {
    return (
      entries.find((e) => e.spotId === spotId && e.authorId === authorId) || null
    );
  },

  /**
   * Other people's entries for a spot that have something worth showing
   * (a comment or a rating). Sorted newest-first.
   */
  othersEntriesForSpot(entries, spotId, authorId) {
    return entries
      .filter(
        (e) =>
          e.spotId === spotId &&
          e.authorId !== authorId &&
          ((e.comment && e.comment.trim()) || Logic.coerceRating(e.rating) > 0)
      )
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  },

  /** Progress for the current user across the (optionally filtered) spots. */
  progressStats(spots, entries, authorId) {
    const total = spots.length;
    let visited = 0;
    let rated = 0;
    let commented = 0;
    for (const spot of spots) {
      const mine = Logic.myEntry(entries, spot.id, authorId);
      if (!mine) continue;
      if (mine.visited) visited += 1;
      if (Logic.coerceRating(mine.rating) > 0) rated += 1;
      if (mine.comment && mine.comment.trim()) commented += 1;
    }
    return { total, visited, rated, commented };
  },

  /**
   * Normalize a raw entry (from a form or the API) into the canonical shape.
   * Returns null when there is nothing meaningful to store.
   */
  normalizeEntry(raw) {
    if (!raw || !raw.spotId || !raw.authorId) return null;
    const entry = {
      spotId: String(raw.spotId),
      authorId: String(raw.authorId),
      authorName: String(raw.authorName || 'Anonymous').slice(0, 60),
      visited: !!raw.visited,
      rating: Logic.coerceRating(raw.rating),
      comment: String(raw.comment || '').slice(0, Logic.NOTE_MAX),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    const isEmpty = !entry.visited && entry.rating === 0 && !entry.comment.trim();
    return isEmpty ? { ...entry, _empty: true } : entry;
  },

  /** Upsert an entry into a list keyed by (spotId, authorId). */
  upsertEntry(entries, entry) {
    const next = entries.filter(
      (e) => !(e.spotId === entry.spotId && e.authorId === entry.authorId)
    );
    next.push(entry);
    return next;
  },

  /**
   * Validate the spots dataset. Returns an array of human-readable errors
   * (empty == valid). Used by the test suite to guard against typos.
   */
  validateSpots(spots) {
    const errors = [];
    if (!Array.isArray(spots)) return ['spots must be an array'];
    const ids = new Set();
    const required = ['id', 'name', 'area', 'address', 'swimType', 'water', 'swim', 'cafe', 'shade'];
    const validSwimTypes = [
      'Lifeguarded beach',
      'Heated pool',
      'Saltwater beach',
      'Beach (no lifeguard)',
      'Shoreline access',
      'Tide pools',
      'No swimming',
    ];
    spots.forEach((spot, i) => {
      const label = spot && spot.id ? spot.id : `index ${i}`;
      for (const key of required) {
        if (!spot[key] || String(spot[key]).trim() === '') {
          errors.push(`${label}: missing "${key}"`);
        }
      }
      if (spot.id) {
        if (ids.has(spot.id)) errors.push(`${label}: duplicate id`);
        ids.add(spot.id);
        if (!/^[a-z0-9-]+$/.test(spot.id)) {
          errors.push(`${label}: id must be kebab-case (a-z, 0-9, -)`);
        }
      }
      if (spot.swimType && validSwimTypes.indexOf(spot.swimType) === -1) {
        errors.push(`${label}: invalid swimType "${spot.swimType}"`);
      }
      if (!Logic.hasCoords(spot)) {
        errors.push(`${label}: missing or invalid lat/lng`);
      } else {
        // Sanity box: Tacoma/Lakewood (south) up to Edmonds (north) and out
        // the I-90 corridor (east) — the widened coverage area.
        if (spot.lat < 47.05 || spot.lat > 47.95) errors.push(`${label}: lat out of range`);
        if (spot.lng < -122.75 || spot.lng > -121.3) errors.push(`${label}: lng out of range`);
      }
      if (spot.tags && !Array.isArray(spot.tags)) {
        errors.push(`${label}: tags must be an array`);
      }
      if (spot.goodFor) {
        if (!Array.isArray(spot.goodFor)) {
          errors.push(`${label}: goodFor must be an array`);
        } else {
          for (const g of spot.goodFor) {
            if (Logic.CATEGORIES.indexOf(g) === -1) errors.push(`${label}: invalid goodFor "${g}"`);
          }
        }
      }
    });
    return errors;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Logic;
}
