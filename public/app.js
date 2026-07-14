/*
 * Swim + Work Seattle — browser app wiring.
 *
 * Storage model:
 *   - Profile (id + name) lives in localStorage. "Login" just picks a profile;
 *     there is no real auth yet (see README → Cloudflare Access TODO).
 *   - Entries (visited / rating / comment per spot, per author) sync to the
 *     Cloudflare D1 backend via /api/entries when it's reachable, and fall back
 *     to a localStorage cache so the site still works as a pure static page.
 */
(function () {
  'use strict';

  const PROFILE_KEY = 'swimwork.profile';
  const ENTRIES_CACHE_KEY = 'swimwork.entries';
  const USERSPOTS_CACHE_KEY = 'swimwork.userspots';
  const PREFS_KEY = 'swimwork.prefs';
  const THEME_KEY = 'swimwork.theme';
  const API_URL = '/api/entries';
  const SPOTS_URL = '/api/spots';

  const state = {
    profile: null,
    entries: [],
    userSpots: [], // community + own spots from /api/spots
    water: null, // { source, updated, beaches: { name: {...} } } from /api/water
    mode: 'local', // 'cloud' | 'local'
    prefs: {
      showOthers: false,
      area: 'All',
      query: '',
      category: 'all', // 'all' | 'swim' | 'play' | 'work'
      view: 'list',
      origin: null, // { lat, lng, label } for the "nearest swim" finder
    },
  };

  // Curated spots (global SPOTS) + community spots, merged for every view.
  function allSpots() {
    return SPOTS.concat(state.userSpots || []);
  }

  function findSpot(id) {
    return allSpots().find((s) => s.id === id) || null;
  }

  // Current prefs plus the set of community-reported swimmable spot ids, so the
  // Swim filter includes "Swim-possible" spots. Recomputed per call (cheap).
  function activeFilters() {
    return Object.assign({}, state.prefs, {
      reportedSwimIds: Logic.reportedSwimIds(allSpots(), state.entries),
    });
  }

  // Leaflet map handles (created lazily the first time the map view is shown).
  let map = null;
  let markersLayer = null;
  let markersById = {}; // spotId -> Leaflet marker (rebuilt each map render)
  let pendingFocusId = null; // spot to zoom to on the next map render
  let preserveMapView = false; // when true, the next map render keeps the current center/zoom
  let selectedDetailId = null; // spot whose full card is shown in the panel under the map

  // Add/edit-spot modal state.
  let editingSpotId = null; // null = creating a new spot
  let draftLocation = null; // { lat, lng, label } chosen in the spot form
  let pickingLocation = false; // a map click sets the draft location, not the finder origin

  // ---------------------------------------------------------------------------
  // Tiny DOM helpers (textContent-first to avoid XSS from user comments).
  // ---------------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const val = props[key];
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val; // only used with trusted strings
        else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2), val);
        } else if (val !== null && val !== undefined && val !== false) {
          node.setAttribute(key, val);
        }
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage full / disabled — ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Entries store: cloud first, local cache fallback.
  // ---------------------------------------------------------------------------
  async function loadEntries() {
    try {
      const res = await fetch(API_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.entries = Array.isArray(data.entries) ? data.entries : [];
      state.mode = 'cloud';
      writeJSON(ENTRIES_CACHE_KEY, state.entries);
    } catch (_) {
      state.entries = readJSON(ENTRIES_CACHE_KEY, []);
      state.mode = 'local';
    }
    updateSyncPill();
  }

  // Community + own spots. Public spots are visible to everyone; private ones
  // only to their author. Falls back to a local cache so the map still shows
  // your own spots offline.
  async function loadUserSpots() {
    const authorId = state.profile ? state.profile.id : '';
    try {
      const res = await fetch(`${SPOTS_URL}?authorId=${encodeURIComponent(authorId)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.userSpots = Array.isArray(data.spots) ? data.spots : [];
      writeJSON(USERSPOTS_CACHE_KEY, state.userSpots);
    } catch (_) {
      state.userSpots = readJSON(USERSPOTS_CACHE_KEY, []);
    }
  }

  // Live freshwater quality (King County). Best-effort: if it fails, the
  // chips just don't appear — the rest of the app is unaffected.
  async function loadWater() {
    try {
      const res = await fetch('/api/water', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.water = data && data.beaches ? data : null;
    } catch (_) {
      state.water = null;
    }
  }

  async function persistEntry(entry) {
    // Optimistic local update + cache first.
    state.entries = Logic.upsertEntry(state.entries, entry);
    writeJSON(ENTRIES_CACHE_KEY, state.entries);
    try {
      const res = await fetch(API_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (state.mode !== 'cloud') {
        state.mode = 'cloud';
        updateSyncPill();
      }
      return true;
    } catch (_) {
      if (state.mode !== 'local') {
        state.mode = 'local';
        updateSyncPill();
      }
      return false;
    }
  }

  // --- user-spot create / edit / delete -------------------------------------
  async function createUserSpot(payload) {
    const res = await fetch(SPOTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ authorId: state.profile.id, authorName: state.profile.name }, payload)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.userSpots = [data.spot].concat(state.userSpots);
    writeJSON(USERSPOTS_CACHE_KEY, state.userSpots);
    return data.spot;
  }

  async function updateUserSpot(id, payload) {
    const res = await fetch(`${SPOTS_URL}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ authorId: state.profile.id }, payload)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.userSpots = state.userSpots.map((s) => (s.id === id ? data.spot : s));
    writeJSON(USERSPOTS_CACHE_KEY, state.userSpots);
    return data.spot;
  }

  async function deleteUserSpot(id) {
    const url = `${SPOTS_URL}/${encodeURIComponent(id)}?authorId=${encodeURIComponent(state.profile.id)}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.userSpots = state.userSpots.filter((s) => s.id !== id);
    writeJSON(USERSPOTS_CACHE_KEY, state.userSpots);
  }

  async function removeEntry(spotId, authorId) {
    state.entries = state.entries.filter(
      (e) => !(e.spotId === spotId && e.authorId === authorId)
    );
    writeJSON(ENTRIES_CACHE_KEY, state.entries);
    try {
      const url = `${API_URL}?spotId=${encodeURIComponent(spotId)}&authorId=${encodeURIComponent(
        authorId
      )}`;
      await fetch(url, { method: 'DELETE' });
    } catch (_) {
      /* stays removed locally */
    }
  }

  // ---------------------------------------------------------------------------
  // Profile / login
  // ---------------------------------------------------------------------------
  function genId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
    const input = $('#login-name');
    input.value = state.profile ? state.profile.name : '';
    setTimeout(() => input.focus(), 30);
  }

  async function startSession(profile) {
    state.profile = profile;
    writeJSON(PROFILE_KEY, profile);
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#profile-name').textContent = profile.name;
    await Promise.all([loadEntries(), loadUserSpots()]);
    render();
    // Fetch water quality in the background; re-render to show chips when ready.
    loadWater().then(() => render());
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const SWIM_BADGE_CLASS = {
    'Lifeguarded beach': 'badge--swim-lifeguarded',
    'Heated pool': 'badge--swim-pool',
    'Saltwater beach': 'badge--swim-salt',
    'Beach (no lifeguard)': 'badge--swim-nolifeguard',
    'Shoreline access': 'badge--swim-shoreline',
    'Tide pools': 'badge--swim-tide',
    'No swimming': 'badge--swim-none',
    'Swim-possible': 'badge--swim-possible',
  };

  function updateSyncPill() {
    const pill = $('#sync-pill');
    if (state.mode === 'cloud') {
      pill.textContent = 'Synced';
      pill.className = 'pill pill--cloud';
      pill.title = 'Connected to the shared Cloudflare backend';
    } else {
      pill.textContent = 'Local only';
      pill.className = 'pill pill--local';
      pill.title = 'Backend unavailable — changes are saved in this browser only';
    }
  }

  function renderProgress(filtered) {
    const stats = Logic.progressStats(filtered, state.entries, state.profile.id);
    $('#progress').textContent =
      `Visited ${stats.visited}/${stats.total} · ${stats.rated} rated · ${stats.commented} noted`;
  }

  // Refresh just the progress line without rebuilding cards — used after a note
  // auto-save so the focused textarea (and the mobile keyboard) survive.
  function updateProgress() {
    renderProgress(allSpots().filter((s) => Logic.spotMatchesFilters(s, activeFilters())));
  }

  function renderAreaSelect() {
    const sel = $('#area-select');
    const areas = ['All'].concat(Logic.areaList(allSpots()));
    // Drop a persisted area that no longer exists (e.g. an area that only came
    // from a since-deleted community spot) so the filter can't get stuck empty.
    if (areas.indexOf(state.prefs.area) === -1) state.prefs.area = 'All';
    sel.textContent = '';
    for (const area of areas) {
      sel.appendChild(el('option', { value: area, text: area === 'All' ? 'All areas' : area }));
    }
    sel.value = state.prefs.area || 'All';
  }

  function renderStars(spot, mine) {
    const current = mine ? Logic.coerceRating(mine.rating) : 0;
    const wrap = el('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Your rating' });
    for (let i = 1; i <= 5; i += 1) {
      wrap.appendChild(
        el('button', {
          class: 'star' + (i <= current ? ' is-on' : ''),
          type: 'button',
          'aria-label': `${i} star${i > 1 ? 's' : ''}`,
          text: i <= current ? '★' : '☆',
          onclick: () => saveField(spot, { rating: i }),
        })
      );
    }
    if (current > 0) {
      wrap.appendChild(
        el('button', {
          class: 'star__clear',
          type: 'button',
          text: 'clear',
          onclick: () => saveField(spot, { rating: 0 }),
        })
      );
    }
    return wrap;
  }

  function renderOthers(spot) {
    const others = Logic.othersEntriesForSpot(state.entries, spot.id, state.profile.id);
    const wrap = el('div', { class: 'others' });
    wrap.appendChild(el('p', { class: 'others__title', text: `Others' notes (${others.length})` }));
    if (others.length === 0) {
      wrap.appendChild(el('p', { class: 'others__empty', text: 'No notes from others yet.' }));
      return wrap;
    }
    for (const o of others) {
      const rating = Logic.coerceRating(o.rating);
      const head = el('div', { class: 'other__head' }, [
        el('span', { class: 'other__author', text: o.authorName || 'Anonymous' }),
        rating > 0
          ? el('span', { class: 'other__rating', text: '★'.repeat(rating) + '☆'.repeat(5 - rating) })
          : null,
      ]);
      const meta = el('div', {}, [
        head,
        o.updatedAt ? el('span', { class: 'other__date', text: formatDate(o.updatedAt) }) : null,
      ]);
      const body = o.comment && o.comment.trim()
        ? el('p', { class: 'other__body', text: o.comment })
        : null;
      wrap.appendChild(el('div', { class: 'other' }, [meta, body]));
    }
    return wrap;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function badgeClassForSwim(swimType) {
    return 'badge ' + (SWIM_BADGE_CLASS[swimType] || 'badge--swim-none');
  }

  // Short "Jun 16" date; noon avoids a timezone roll-back to the prior day.
  function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /**
   * Water-quality badge for a spot. Monitored freshwater beaches show a live,
   * color-coded reading (status · temp · date); swimmable saltwater/unmonitored
   * spots show a muted "Not monitored" chip. View-only spots get no chip.
   */
  function waterChip(spot) {
    if (!Logic.isSwimmable(spot)) return null;

    if (spot.kcBeach) {
      if (!state.water || !state.water.beaches) return null; // not loaded yet
      const rec = state.water.beaches[spot.kcBeach];
      const status = Logic.waterStatus(rec);
      const color = Logic.WATER_STATUS_COLORS[status];
      const parts = ['💧 ' + Logic.WATER_STATUS_LABELS[status]];
      if (rec && rec.watertempf != null) parts.push(`${Math.round(rec.watertempf)}°F`);
      if (rec && rec.date) parts.push(formatShortDate(rec.date));
      const gm = rec && rec.geomean30d != null ? Math.round(rec.geomean30d) : null;
      return el('span', {
        class: 'badge badge--waterq',
        text: parts.join(' · '),
        style: `border-color:${color};color:${color};background:color-mix(in srgb, ${color} 16%, transparent)`,
        title:
          (gm != null ? `30-day E. coli geomean: ${gm} MPN/100mL (rec. limit 126). ` : '') +
          'Source: King County Swim Beach Monitoring — always check the official advisory before swimming.',
      });
    }

    return el('span', {
      class: 'badge badge--waterq-na',
      text: '💧 Not monitored',
      title:
        'No King County freshwater sampling here (saltwater or unmonitored). ' +
        'Check posted advisories before swimming.',
    });
  }

  function renderCard(spot) {
    const mine = Logic.myEntry(state.entries, spot.id, state.profile.id);
    const visited = !!(mine && mine.visited);

    const card = el('article', {
      class: 'card' + (visited ? ' is-visited' : ''),
      id: 'card-' + spot.id,
    });

    card.appendChild(
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('span', { class: 'card__area', text: spot.area }),
          el('h2', { class: 'card__title', text: spot.name }),
        ]),
      ])
    );

    const disp = Logic.displaySwimType(spot, state.entries);
    const swimBadge = el('span', { class: badgeClassForSwim(disp.type), text: disp.type });
    if (disp.reported) {
      swimBadge.title = `Reported swimmable by ${disp.count} ${
        disp.count === 1 ? 'person' : 'people'
      } — user-reported, unofficial. Waters here are unmonitored and unguarded.`;
    }
    const badges = [
      swimBadge,
      el('span', { class: 'badge badge--water', text: spot.water + 'water' }),
    ];
    const wq = waterChip(spot);
    if (wq) badges.push(wq);
    if (Logic.spotGoodFor(spot).indexOf('work') !== -1) {
      badges.push(el('span', { class: 'badge badge--work-ok', text: '💻 Work-friendly' }));
    }
    if (Logic.isUserSubmitted(spot)) {
      badges.push(el('span', { class: 'badge badge--community', text: '👥 Community' }));
      badges.push(
        el('span', {
          class: 'badge ' + (spot.isPublic ? 'badge--public' : 'badge--private'),
          text: spot.isPublic ? 'Public' : 'Private (only you)',
        })
      );
    }
    card.appendChild(el('div', { class: 'badges' }, badges));

    if (spot.swim) card.appendChild(detailRow('🏊', 'Swim', spot.swim));
    if (spot.cafe) card.appendChild(detailRow('☕', 'Work', spot.cafe));
    if (spot.shade) card.appendChild(detailRow('🌳', 'Shade', spot.shade));

    if (spot.tags && spot.tags.length) {
      card.appendChild(
        el('div', { class: 'tags' }, spot.tags.map((t) => el('span', { class: 'tag', text: t })))
      );
    }

    const linkRow = el('div', { class: 'card__links' }, [
      el('a', {
        class: 'card__map',
        href: Logic.buildMapUrl(spot),
        target: '_blank',
        rel: 'noopener',
        text: '📍 Open in Maps',
      }),
    ]);
    if (Logic.canEditSpot(spot, state.profile.id)) {
      linkRow.appendChild(
        el('button', {
          class: 'btn btn--ghost card__owner-btn',
          type: 'button',
          text: '✏️ Edit',
          onclick: () => openSpotModal(spot),
        })
      );
      if (Logic.canDeleteSpot(spot, state.profile.id)) {
        linkRow.appendChild(
          el('button', {
            class: 'btn btn--ghost card__owner-btn card__owner-btn--danger',
            type: 'button',
            text: '🗑 Delete',
            onclick: () => confirmDeleteSpot(spot),
          })
        );
      }
    }
    card.appendChild(linkRow);

    // ---- the user's own controls ----
    const visitedCheckbox = el('input', { type: 'checkbox' });
    visitedCheckbox.checked = visited;
    visitedCheckbox.addEventListener('change', () =>
      saveField(spot, { visited: visitedCheckbox.checked })
    );

    const comment = el('textarea', {
      class: 'comment',
      placeholder: 'Your note — wifi? outlets? shade? worth a swim? (one per spot)',
      maxlength: String(Logic.NOTE_MAX),
    });
    comment.value = mine && mine.comment ? mine.comment : '';

    const saveState = el('span', { class: 'save-state' });
    const counter = el('span', { class: 'comment__count' });
    const updateCount = () => {
      counter.textContent = `${comment.value.length}/${Logic.NOTE_MAX}`;
    };
    updateCount();

    let commentTimer = null;
    comment.addEventListener('input', () => {
      saveState.textContent = 'Editing…';
      updateCount();
      clearTimeout(commentTimer);
      // Auto-save after a longer pause, and without a re-render so typing/keyboard
      // aren't interrupted while you're still thinking.
      commentTimer = setTimeout(
        () => saveField(spot, { comment: comment.value }, saveState, { rerender: false }),
        1500
      );
    });
    comment.addEventListener('blur', () => {
      clearTimeout(commentTimer);
      saveField(spot, { comment: comment.value }, saveState, { rerender: false });
    });

    // "I swam here" — only on "No swimming" spots (mislabeled shoreline access).
    // A report flips the badge to "Swim-possible" and lists it under the Swim filter.
    let swamRow = null;
    if (Logic.swamHereEligible(spot)) {
      const swamCheckbox = el('input', { type: 'checkbox' });
      swamCheckbox.checked = !!(mine && mine.swamHere);
      swamCheckbox.addEventListener('change', () =>
        saveField(spot, { swamHere: swamCheckbox.checked })
      );
      const count = Logic.swamHereCount(state.entries, spot.id);
      const note = count
        ? `Reported swimmable by ${count} ${count === 1 ? 'person' : 'people'}`
        : 'Not a designated swim spot — mark if you’ve swum here';
      swamRow = el('div', { class: 'swamhere' }, [
        el('label', { class: 'swamhere__label' }, [
          swamCheckbox,
          document.createTextNode(' 🏊 I’ve swum here'),
        ]),
        el('span', { class: 'swamhere__count', text: note }),
      ]);
    }

    const controls = el('div', { class: 'controls' }, [
      el('div', { class: 'controls__row' }, [
        el('label', { class: 'visited' }, [visitedCheckbox, document.createTextNode('Visited')]),
        renderStars(spot, mine),
      ]),
      swamRow,
      comment,
      el('div', { class: 'controls__foot' }, [saveState, counter]),
    ]);
    card.appendChild(controls);

    if (state.prefs.showOthers) {
      card.appendChild(renderOthers(spot));
    }

    return card;
  }

  function detailRow(icon, label, text) {
    return el('div', { class: 'detail' }, [
      el('span', { class: 'detail__icon', text: icon, 'aria-hidden': 'true' }),
      el('p', { class: 'detail__text' }, [el('b', { text: label + ': ' }), document.createTextNode(text)]),
    ]);
  }

  function render() {
    renderAreaSelect();
    const filtered = allSpots().filter((s) => Logic.spotMatchesFilters(s, activeFilters()));
    renderProgress(filtered);

    renderFinderResults();

    const mapView = state.prefs.view === 'map';
    $('#spots').hidden = mapView;
    $('#map-view').hidden = !mapView;
    $('#empty').hidden = filtered.length !== 0;

    if (mapView) {
      // Clear stale list cards so their ids can't collide with the detail panel.
      $('#spots').textContent = '';
      renderMap(filtered);
      renderMapDetail(filtered);
      updateScrollTopBtn();
      return;
    }

    const container = $('#spots');
    container.textContent = '';
    for (const spot of filtered) container.appendChild(renderCard(spot));
    updateScrollTopBtn();
  }

  // Show a spot's full, editable card in a panel just below the map (from a
  // marker popup's "View details"), keeping the user in Map view.
  function showMapDetail(spotId) {
    selectedDetailId = spotId;
    preserveMapView = true; // don't refit/jump the map when the panel opens
    if (map) map.closePopup(); // the panel replaces the popup's info
    renderMapDetail(allSpots().filter((s) => Logic.spotMatchesFilters(s, activeFilters())));
    const panel = $('#map-detail');
    if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeMapDetail() {
    selectedDetailId = null;
    const panel = $('#map-detail');
    panel.hidden = true;
    panel.textContent = '';
  }

  function renderMapDetail(filtered) {
    const panel = $('#map-detail');
    panel.textContent = '';
    const spot = selectedDetailId ? findSpot(selectedDetailId) : null;
    // Drop the panel if the spot is gone or filtered out of the current view.
    if (!spot || !filtered.some((s) => s.id === spot.id)) {
      selectedDetailId = null;
      panel.hidden = true;
      return;
    }
    const head = el('div', { class: 'map-detail__head' }, [
      el('span', { class: 'map-detail__label', text: 'Selected spot' }),
      el('button', {
        class: 'btn btn--ghost map-detail__close',
        type: 'button',
        text: '✕ Close',
        onclick: closeMapDetail,
      }),
    ]);
    panel.appendChild(head);
    panel.appendChild(renderCard(spot));
    panel.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Nearest-swim finder (geocode / geolocation / map-click -> recommendations)
  // ---------------------------------------------------------------------------
  function formatDistance(km) {
    const mi = km * 0.621371;
    if (mi < 0.1) return '< 0.1 mi';
    return `${mi.toFixed(1)} mi`;
  }

  async function geocodeQuery(q) {
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.result ? data.result : null;
    } catch (_) {
      return null;
    }
  }

  // Re-render without letting the page jump: the recommendations panel sits
  // above the map, so adding/removing it shifts the map down/up. Pin the map's
  // viewport position by scrolling to the offset that keeps its top constant.
  // We derive the map's document offset as (rect.top + scrollY), which is
  // invariant to the scroll clamping the browser applies when the page shrinks.
  function renderKeepingMapStable() {
    if (state.prefs.view !== 'map') {
      render();
      return;
    }
    const mapEl = $('#map-view');
    const beforeTop = mapEl.getBoundingClientRect().top;
    render();
    // (rect.top + scrollY) is the map's document offset, invariant to the scroll
    // clamping the browser applies when the page shrinks.
    const docOffset = mapEl.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, docOffset - beforeTop), behavior: 'auto' });
  }

  function setOrigin(origin, { preserveView = false } = {}) {
    state.prefs.origin = origin;
    savePrefs();
    // A map click is already framed by the user, so keep their view; an address
    // search / geolocation fits the origin + recommendations into view instead.
    preserveMapView = preserveView;
    if (preserveView) renderKeepingMapStable();
    else render();
  }

  function clearOrigin() {
    state.prefs.origin = null;
    savePrefs();
    $('#finder-status').textContent = '';
    // Just drop the pin + recommendations; leave the map where the user has it.
    preserveMapView = true;
    renderKeepingMapStable();
  }

  function renderFinderResults() {
    const box = $('#finder-results');
    const origin = state.prefs.origin;
    $('#finder-clear').hidden = !origin;

    if (!origin || !Logic.hasCoords(origin)) {
      box.hidden = true;
      box.textContent = '';
      return;
    }

    const recs = Logic.recommendSwimSpots(allSpots(), origin, state.entries, { limit: 3 });
    box.textContent = '';
    box.appendChild(
      el('p', { class: 'finder__label' }, [
        document.createTextNode('Best swims near '),
        el('b', { text: origin.label || 'your location' }),
      ])
    );

    if (!recs.length) {
      box.appendChild(el('p', { class: 'others__empty', text: 'No swimmable spots found.' }));
      box.hidden = false;
      return;
    }

    const list = el('ol', { class: 'recs' });
    recs.forEach((r, i) => {
      const ratingText = r.ratingCount
        ? `★ ${r.avgRating.toFixed(1)} (${r.ratingCount})`
        : 'no ratings yet';
      list.appendChild(
        el('li', { class: 'rec' }, [
          el('div', { class: 'rec__left' }, [
            el('span', { class: 'rec__rank', text: String(i + 1) }),
            el('div', { class: 'rec__main' }, [
              el('span', { class: 'rec__name', text: r.spot.name }),
              el('span', {
                class: 'rec__meta',
                text: `${r.spot.area} · ${formatDistance(r.distanceKm)} · ${ratingText}`,
              }),
            ]),
          ]),
          el('div', { class: 'rec__actions' }, [
            el('button', {
              class: 'btn btn--ghost rec__btn',
              type: 'button',
              text: 'Details',
              onclick: () => jumpToCard(r.spot.id),
            }),
            el('button', {
              class: 'btn btn--ghost rec__btn',
              type: 'button',
              text: 'Map',
              onclick: () => jumpToMap(r.spot.id),
            }),
          ]),
        ])
      );
    });
    box.appendChild(list);
    box.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Map view (Leaflet + OpenStreetMap, no API key)
  // ---------------------------------------------------------------------------
  function ensureMap() {
    if (map) return map;
    if (typeof window.L === 'undefined') {
      $('#map-fallback').hidden = false;
      return null;
    }
    map = L.map('map', { scrollWheelZoom: true }).setView([47.62, -122.33], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    // Click anywhere on the map to drop a start point for the finder; keep the
    // user's current zoom/center since they just pointed at where they want it.
    // When the add/edit-spot form is picking a location, set that instead.
    map.on('click', (e) => {
      const point = { lat: e.latlng.lat, lng: e.latlng.lng, label: 'Picked point' };
      if (pickingLocation) {
        pickingLocation = false;
        setDraftLocation(point);
        $('#finder-status').textContent = '';
        $('#spot-modal').hidden = false; // reopen the form with the location filled in
        return;
      }
      setOrigin(point, { preserveView: true });
    });
    return map;
  }

  function buildOriginPopup() {
    const origin = state.prefs.origin || {};
    return el('div', { class: 'mappop' }, [
      el('span', { class: 'mappop__area', text: 'Start point' }),
      el('h3', { class: 'mappop__title', text: origin.label || 'Your location' }),
      el('div', { class: 'mappop__actions' }, [
        el('button', {
          class: 'btn btn--ghost mappop__btn',
          type: 'button',
          text: 'Clear',
          onclick: () => clearOrigin(),
        }),
      ]),
    ]);
  }

  function buildPopup(spot) {
    const disp = Logic.displaySwimType(spot, state.entries);
    return el('div', { class: 'mappop' }, [
      el('span', { class: 'mappop__area', text: spot.area }),
      el('h3', { class: 'mappop__title', text: spot.name }),
      el('span', { class: badgeClassForSwim(disp.type), text: disp.type }),
      el('p', { class: 'mappop__swim', text: spot.swim }),
      waterChip(spot),
      el('div', { class: 'mappop__actions' }, [
        el('button', {
          class: 'btn btn--primary mappop__btn',
          type: 'button',
          text: 'View details',
          onclick: () => showMapDetail(spot.id),
        }),
        el('a', {
          class: 'card__map',
          href: Logic.buildMapUrl(spot),
          target: '_blank',
          rel: 'noopener',
          text: '📍 Maps',
        }),
      ]),
    ]);
  }

  function renderMap(filtered) {
    if (!ensureMap()) return;
    $('#map-fallback').hidden = true;
    markersLayer.clearLayers();
    markersById = {};

    const origin = state.prefs.origin;
    const recs =
      origin && Logic.hasCoords(origin)
        ? Logic.recommendSwimSpots(allSpots(), origin, state.entries, { limit: 3 })
        : [];
    const recIds = new Set(recs.map((r) => r.spot.id));

    const points = [];
    for (const spot of filtered) {
      if (!Logic.hasCoords(spot)) continue;
      const mine = Logic.myEntry(state.entries, spot.id, state.profile.id);
      const visited = !!(mine && mine.visited);
      const isRec = recIds.has(spot.id);
      const marker = L.circleMarker([spot.lat, spot.lng], {
        radius: isRec ? 12 : 9,
        weight: visited ? 3 : 2,
        color: visited ? '#f4b740' : '#ffffff',
        fillColor: Logic.swimTypeColor(Logic.displaySwimType(spot, state.entries).type),
        fillOpacity: 0.95,
      });
      marker.bindPopup(buildPopup(spot));
      markersLayer.addLayer(marker);
      markersById[spot.id] = marker;
      points.push([spot.lat, spot.lng]);
    }

    // Draw the finder's start point + a line to the top recommendation.
    if (origin && Logic.hasCoords(origin)) {
      const o = [origin.lat, origin.lng];
      if (recs.length) {
        markersLayer.addLayer(
          L.polyline([o, [recs[0].spot.lat, recs[0].spot.lng]], {
            color: '#0d7fb8',
            weight: 3,
            dashArray: '6 6',
            opacity: 0.8,
          })
        );
      }
      markersLayer.addLayer(
        L.circleMarker(o, {
          radius: 8,
          weight: 3,
          color: '#ffffff',
          fillColor: '#e0467c',
          fillOpacity: 1,
        }).bindPopup(buildOriginPopup())
      );
      points.push(o);
    }

    // Focusing a single spot (from a recommendation's "Map" button) zooms in
    // instead of fitting all markers; otherwise fit everything in view — unless
    // we're asked to preserve the current view (e.g. clearing the pin).
    const focusSpot = pendingFocusId ? findSpot(pendingFocusId) : null;
    const focusMarker = pendingFocusId ? markersById[pendingFocusId] : null;
    pendingFocusId = null;
    // Keep the current view when explicitly asked, or whenever the detail panel
    // is open (so editing a note/rating doesn't refit and jump the map).
    const preserveView = preserveMapView || (!!selectedDetailId && !focusSpot);
    preserveMapView = false;

    // The container may have just been un-hidden, so its size needs recomputing
    // before any setView/fitBounds so the math uses the real dimensions.
    setTimeout(() => {
      map.invalidateSize();
      if (focusSpot && Logic.hasCoords(focusSpot)) {
        map.flyTo([focusSpot.lat, focusSpot.lng], 15, { duration: 0.6 });
        if (focusMarker) focusMarker.openPopup();
      } else if (!preserveView && points.length) {
        map.fitBounds(points, { padding: [34, 34], maxZoom: 14 });
      }
    }, 0);

    renderLegend();
  }

  function renderLegend() {
    const legend = $('#map-legend');
    legend.textContent = '';
    const types = [
      'Lifeguarded beach',
      'Heated pool',
      'Saltwater beach',
      'Beach (no lifeguard)',
      'Shoreline access',
      'Swim-possible',
      'Tide pools',
      'No swimming',
    ];
    for (const t of types) {
      legend.appendChild(
        el('span', { class: 'legend__item' }, [
          el('span', { class: 'legend__dot', style: `background:${Logic.swimTypeColor(t)}` }),
          el('span', { text: t }),
        ])
      );
    }
  }

  function jumpToCard(spotId) {
    setView('list');
    const card = document.getElementById('card-' + spotId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 1700);
  }

  // Switch to the map and zoom in on a single spot (from a recommendation).
  function jumpToMap(spotId) {
    pendingFocusId = spotId;
    setView('map');
  }

  function syncViewToggle() {
    const mapView = state.prefs.view === 'map';
    const listBtn = $('#view-list');
    const mapBtn = $('#view-map');
    listBtn.classList.toggle('is-active', !mapView);
    mapBtn.classList.toggle('is-active', mapView);
    listBtn.setAttribute('aria-pressed', String(!mapView));
    mapBtn.setAttribute('aria-pressed', String(mapView));
  }

  function syncCategoryButtons() {
    const active = state.prefs.category || 'all';
    document.querySelectorAll('.catfilter__btn').forEach((btn) => {
      const on = btn.dataset.cat === active;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function setView(view) {
    state.prefs.view = view === 'map' ? 'map' : 'list';
    savePrefs();
    syncViewToggle();
    render();
  }

  // Show the back-to-top button once the list is scrolled past its first item.
  function updateScrollTopBtn() {
    const btn = $('#scroll-top');
    if (!btn) return;
    let show = false;
    if (state.prefs.view === 'list') {
      const first = document.querySelector('#spots .card');
      if (first) show = first.getBoundingClientRect().bottom < 0;
    }
    btn.classList.toggle('is-visible', show);
  }

  // ---------------------------------------------------------------------------
  // Add / edit a community spot
  // ---------------------------------------------------------------------------
  function setDraftLocation(loc) {
    draftLocation = loc && Logic.hasCoords(loc) ? loc : null;
    const status = $('#spot-loc-status');
    if (draftLocation) {
      const label = loc.label || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
      status.textContent = `📍 ${label}`;
      status.classList.add('is-set');
    } else {
      status.textContent = 'No location set yet.';
      status.classList.remove('is-set');
    }
  }

  function spotFormError(msg) {
    const p = $('#spot-form-error');
    p.textContent = msg;
    p.hidden = !msg;
  }

  function openSpotModal(spot) {
    editingSpotId = spot ? spot.id : null;
    const isEdit = !!spot;
    $('#spot-modal-title').textContent = isEdit ? 'Edit spot' : 'Add a spot';
    $('#spot-save').textContent = isEdit ? 'Save changes' : 'Save spot';
    spotFormError('');

    const cats = isEdit ? Logic.spotGoodFor(spot) : ['swim'];
    $('#spot-name').value = isEdit ? spot.name : '';
    $('#spot-cat-swim').checked = cats.indexOf('swim') !== -1;
    $('#spot-cat-play').checked = cats.indexOf('play') !== -1;
    $('#spot-cat-work').checked = cats.indexOf('work') !== -1;
    $('#spot-swimtype').value = isEdit && spot.swimType ? spot.swimType : 'Shoreline access';
    $('#spot-water').value = isEdit && spot.water === 'Salt' ? 'Salt' : 'Fresh';
    $('#spot-desc').value = isEdit ? spot.swim || '' : '';
    $('#spot-addr').value = '';

    const pub = $('#spot-public');
    pub.checked = isEdit ? !!spot.isPublic : false;
    // Public is permanent — an already-public spot can't be turned back to private.
    pub.disabled = isEdit && !!spot.isPublic;

    const del = $('#spot-delete');
    if (isEdit && Logic.canDeleteSpot(spot, state.profile.id)) {
      del.hidden = false;
      del.onclick = () => confirmDeleteSpot(spot);
    } else {
      del.hidden = true;
      del.onclick = null;
    }

    if (isEdit) setDraftLocation({ lat: spot.lat, lng: spot.lng, label: spot.address || spot.name });
    else setDraftLocation(state.prefs.origin ? Object.assign({}, state.prefs.origin) : null);

    $('#spot-modal').hidden = false;
    setTimeout(() => $('#spot-name').focus(), 30);
  }

  function closeSpotModal() {
    $('#spot-modal').hidden = true;
    pickingLocation = false;
  }

  async function submitSpotForm() {
    const name = $('#spot-name').value.trim();
    if (!name) return spotFormError('Please give the spot a name.');
    if (!draftLocation) {
      return spotFormError('Set a location — search an address, use my location, or pick on the map.');
    }
    const goodFor = [];
    if ($('#spot-cat-swim').checked) goodFor.push('swim');
    if ($('#spot-cat-play').checked) goodFor.push('play');
    if ($('#spot-cat-work').checked) goodFor.push('work');
    if (!goodFor.length) goodFor.push('play');

    // Only keep a human place label as the address (not raw "lat, lng").
    const label = draftLocation.label || '';
    const payload = {
      name,
      description: $('#spot-desc').value.trim(),
      goodFor,
      swimType: $('#spot-swimtype').value,
      water: $('#spot-water').value,
      isPublic: $('#spot-public').checked,
      lat: draftLocation.lat,
      lng: draftLocation.lng,
      address: /^-?\d+(\.\d+)?,/.test(label) ? '' : label,
    };

    $('#spot-save').disabled = true;
    try {
      const saved = editingSpotId
        ? await updateUserSpot(editingSpotId, payload)
        : await createUserSpot(payload);
      closeSpotModal();
      render();
      if (saved && Logic.hasCoords(saved)) jumpToMap(saved.id);
    } catch (err) {
      spotFormError((err && err.message) || 'Could not save — the backend may be unavailable.');
    } finally {
      $('#spot-save').disabled = false;
    }
  }

  async function confirmDeleteSpot(spot) {
    if (!window.confirm(`Delete "${spot.name}"? This can't be undone.`)) return;
    try {
      await deleteUserSpot(spot.id);
      closeSpotModal();
      render();
    } catch (err) {
      window.alert((err && err.message) || 'Could not delete this spot.');
    }
  }

  // ---------------------------------------------------------------------------
  // Saving a single field on the user's entry
  // ---------------------------------------------------------------------------
  async function saveField(spot, patch, saveStateEl, opts) {
    // `rerender: false` skips the full card rebuild — used for note auto-saves so
    // the focused textarea (and the mobile keyboard) aren't torn down mid-edit.
    const rerender = !(opts && opts.rerender === false);
    const existing = Logic.myEntry(state.entries, spot.id, state.profile.id) || {};
    const merged = Logic.normalizeEntry({
      spotId: spot.id,
      authorId: state.profile.id,
      authorName: state.profile.name,
      visited: 'visited' in patch ? patch.visited : existing.visited,
      rating: 'rating' in patch ? patch.rating : existing.rating,
      comment: 'comment' in patch ? patch.comment : existing.comment,
      swamHere: 'swamHere' in patch ? patch.swamHere : existing.swamHere,
      updatedAt: new Date().toISOString(),
    });

    if (saveStateEl) saveStateEl.textContent = 'Saving…';

    if (merged._empty) {
      // Nothing left worth storing — remove the entry entirely.
      await removeEntry(spot.id, state.profile.id);
    } else {
      const ok = await persistEntry(merged);
      if (saveStateEl) {
        saveStateEl.textContent = ok ? 'Saved ✓' : 'Saved locally (offline)';
      }
    }

    if (rerender) {
      // Rebuild so visited styling / stars / progress stay in sync.
      render();
    } else {
      // Note-only save: keep the card (and focus) intact, just refresh the count.
      updateProgress();
    }
  }

  // ---------------------------------------------------------------------------
  // Prefs + theme
  // ---------------------------------------------------------------------------
  function savePrefs() {
    writeJSON(PREFS_KEY, state.prefs);
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function currentTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored) return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  // ---------------------------------------------------------------------------
  // Wire up static controls
  // ---------------------------------------------------------------------------
  function bindControls() {
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#login-name').value.trim() || 'Anonymous';
      const profile =
        state.profile && state.profile.id
          ? { id: state.profile.id, name }
          : { id: genId(), name };
      startSession(profile);
    });

    $('#switch-profile').addEventListener('click', showLogin);

    $('#search').addEventListener('input', (e) => {
      state.prefs.query = e.target.value;
      savePrefs();
      render();
    });

    document.querySelectorAll('.catfilter__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.prefs.category = btn.dataset.cat || 'all';
        savePrefs();
        syncCategoryButtons();
        render();
      });
    });

    $('#area-select').addEventListener('change', (e) => {
      state.prefs.area = e.target.value;
      savePrefs();
      render();
    });

    $('#toggle-others').addEventListener('change', (e) => {
      state.prefs.showOthers = e.target.checked;
      savePrefs();
      render();
    });

    $('#view-list').addEventListener('click', () => setView('list'));
    $('#view-map').addEventListener('click', () => setView('map'));

    $('#finder-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = $('#finder-input').value.trim();
      if (!q) return;
      const status = $('#finder-status');
      status.textContent = 'Searching…';
      const result = await geocodeQuery(q);
      if (result && Logic.hasCoords(result)) {
        status.textContent = '';
        setOrigin({ lat: result.lat, lng: result.lng, label: result.label });
      } else {
        status.textContent = "Couldn't find that location — try 'My location' or click the map.";
      }
    });

    $('#finder-geo').addEventListener('click', () => {
      const status = $('#finder-status');
      if (!navigator.geolocation) {
        status.textContent = 'Geolocation is not available in this browser.';
        return;
      }
      status.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          status.textContent = '';
          setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Your location' });
        },
        () => {
          status.textContent = 'Could not get your location (permission denied?).';
        },
        { enableHighAccuracy: false, timeout: 8000 }
      );
    });

    $('#finder-clear').addEventListener('click', clearOrigin);

    // --- add / edit community spot ---
    $('#add-spot-fab').addEventListener('click', () => openSpotModal(null));
    $('#spot-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitSpotForm();
    });
    document.querySelectorAll('#spot-modal [data-close]').forEach((btn) => {
      btn.addEventListener('click', closeSpotModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#spot-modal').hidden) closeSpotModal();
    });

    $('#spot-addr-btn').addEventListener('click', async () => {
      const q = $('#spot-addr').value.trim();
      if (!q) return;
      const status = $('#spot-loc-status');
      status.textContent = 'Searching…';
      const r = await geocodeQuery(q);
      if (r && Logic.hasCoords(r)) {
        setDraftLocation({ lat: r.lat, lng: r.lng, label: r.label });
      } else {
        status.textContent = "Couldn't find that — try another address or pick on the map.";
      }
    });

    $('#spot-geo').addEventListener('click', () => {
      const status = $('#spot-loc-status');
      if (!navigator.geolocation) {
        status.textContent = 'Geolocation is not available in this browser.';
        return;
      }
      status.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => setDraftLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'My location' }),
        () => {
          status.textContent = 'Could not get your location (permission denied?).';
        },
        { enableHighAccuracy: false, timeout: 8000 }
      );
    });

    $('#spot-pick').addEventListener('click', () => {
      $('#spot-modal').hidden = true; // hide without resetting pick mode
      pickingLocation = true;
      setView('map');
      $('#finder-status').textContent = 'Tap the map to set your spot’s location…';
    });

    $('#theme-btn').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    // Back-to-top: fade in past the first list item; click smooth-scrolls up.
    $('#scroll-top').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    let scrollRaf = null;
    window.addEventListener(
      'scroll',
      () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = null;
          updateScrollTopBtn();
        });
      },
      { passive: true }
    );
    window.addEventListener('resize', updateScrollTopBtn, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function init() {
    applyTheme(currentTheme());
    state.prefs = Object.assign(state.prefs, readJSON(PREFS_KEY, {}));
    state.profile = readJSON(PROFILE_KEY, null);

    // Migrate the legacy "swimmable only" flag to the new category filter.
    if (!state.prefs.category) {
      state.prefs.category = state.prefs.swimmableOnly ? 'swim' : 'all';
    }
    delete state.prefs.swimmableOnly;

    bindControls();

    // Reflect persisted prefs into the static controls.
    $('#search').value = state.prefs.query || '';
    $('#toggle-others').checked = !!state.prefs.showOthers;
    syncViewToggle();
    syncCategoryButtons();

    if (state.profile && state.profile.id) {
      startSession(state.profile);
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
