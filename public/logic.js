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
  ],

  isSwimmable(spot) {
    return Logic.SWIMMABLE_TYPES.indexOf(spot.swimType) !== -1;
  },

  /** Marker / swatch color per swim type (kept here so the map + tests agree). */
  SWIM_TYPE_COLORS: {
    'Lifeguarded beach': '#1f9d55',
    'Heated pool': '#0d7fb8',
    'Saltwater beach': '#b8860d',
    'Beach (no lifeguard)': '#b8860d',
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
    if (f.swimmableOnly && !Logic.isSwimmable(spot)) return false;
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
      comment: String(raw.comment || '').slice(0, 2000),
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
        // Sanity-check the marker sits inside the greater-Seattle bounding box.
        if (spot.lat < 47.3 || spot.lat > 47.9) errors.push(`${label}: lat out of Seattle range`);
        if (spot.lng < -122.6 || spot.lng > -122.1) errors.push(`${label}: lng out of Seattle range`);
      }
      if (spot.tags && !Array.isArray(spot.tags)) {
        errors.push(`${label}: tags must be an array`);
      }
    });
    return errors;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Logic;
}
