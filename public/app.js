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
  const PREFS_KEY = 'swimwork.prefs';
  const THEME_KEY = 'swimwork.theme';
  const API_URL = '/api/entries';

  const state = {
    profile: null,
    entries: [],
    mode: 'local', // 'cloud' | 'local'
    prefs: {
      showOthers: false,
      area: 'All',
      query: '',
      swimmableOnly: false,
      view: 'list',
      origin: null, // { lat, lng, label } for the "nearest swim" finder
    },
  };

  // Leaflet map handles (created lazily the first time the map view is shown).
  let map = null;
  let markersLayer = null;

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
    await loadEntries();
    render();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const SWIM_BADGE_CLASS = {
    'Lifeguarded beach': 'badge--swim-lifeguarded',
    'Heated pool': 'badge--swim-pool',
    'Saltwater beach': 'badge--swim-salt',
    'Beach (no lifeguard)': 'badge--swim-nolifeguard',
    'Tide pools': 'badge--swim-tide',
    'No swimming': 'badge--swim-none',
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

  function renderAreaTabs() {
    const tabs = $('#area-tabs');
    tabs.textContent = '';
    const areas = ['All'].concat(Logic.areaList(SPOTS));
    for (const area of areas) {
      const btn = el('button', {
        class: 'area-tab' + (state.prefs.area === area ? ' is-active' : ''),
        type: 'button',
        role: 'tab',
        text: area,
        onclick: () => {
          state.prefs.area = area;
          savePrefs();
          render();
        },
      });
      tabs.appendChild(btn);
    }
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

    card.appendChild(
      el('div', { class: 'badges' }, [
        el('span', { class: badgeClassForSwim(spot.swimType), text: spot.swimType }),
        el('span', { class: 'badge badge--water', text: spot.water + 'water' }),
      ])
    );

    card.appendChild(detailRow('🏊', 'Swim', spot.swim));
    card.appendChild(detailRow('☕', 'Work', spot.cafe));
    card.appendChild(detailRow('🌳', 'Shade', spot.shade));

    if (spot.tags && spot.tags.length) {
      card.appendChild(
        el('div', { class: 'tags' }, spot.tags.map((t) => el('span', { class: 'tag', text: t })))
      );
    }

    card.appendChild(
      el('a', {
        class: 'card__map',
        href: Logic.buildMapUrl(spot),
        target: '_blank',
        rel: 'noopener',
        text: '📍 Open in Maps',
      })
    );

    // ---- the user's own controls ----
    const visitedCheckbox = el('input', { type: 'checkbox' });
    visitedCheckbox.checked = visited;
    visitedCheckbox.addEventListener('change', () =>
      saveField(spot, { visited: visitedCheckbox.checked })
    );

    const comment = el('textarea', {
      class: 'comment',
      placeholder: 'Your notes — wifi? outlets? shade? worth a swim?',
      maxlength: '2000',
    });
    comment.value = mine && mine.comment ? mine.comment : '';

    const saveState = el('span', { class: 'save-state' });

    let commentTimer = null;
    comment.addEventListener('input', () => {
      saveState.textContent = 'Editing…';
      clearTimeout(commentTimer);
      commentTimer = setTimeout(() => saveField(spot, { comment: comment.value }, saveState), 700);
    });
    comment.addEventListener('blur', () => {
      clearTimeout(commentTimer);
      saveField(spot, { comment: comment.value }, saveState);
    });

    const controls = el('div', { class: 'controls' }, [
      el('div', { class: 'controls__row' }, [
        el('label', { class: 'visited' }, [visitedCheckbox, document.createTextNode('Visited')]),
        renderStars(spot, mine),
      ]),
      comment,
      saveState,
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
    renderAreaTabs();
    const filtered = SPOTS.filter((s) => Logic.spotMatchesFilters(s, state.prefs));
    renderProgress(filtered);

    renderFinderResults();

    const mapView = state.prefs.view === 'map';
    $('#spots').hidden = mapView;
    $('#map-view').hidden = !mapView;
    $('#empty').hidden = filtered.length !== 0;

    if (mapView) {
      renderMap(filtered);
      return;
    }

    const container = $('#spots');
    container.textContent = '';
    for (const spot of filtered) container.appendChild(renderCard(spot));
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

  function setOrigin(origin) {
    state.prefs.origin = origin;
    savePrefs();
    render();
  }

  function clearOrigin() {
    state.prefs.origin = null;
    savePrefs();
    $('#finder-status').textContent = '';
    render();
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

    const recs = Logic.recommendSwimSpots(SPOTS, origin, state.entries, { limit: 3 });
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
              onclick: () => setView('map'),
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
    // Click anywhere on the map to drop a start point for the finder.
    map.on('click', (e) => setOrigin({ lat: e.latlng.lat, lng: e.latlng.lng, label: 'Picked point' }));
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
    return el('div', { class: 'mappop' }, [
      el('span', { class: 'mappop__area', text: spot.area }),
      el('h3', { class: 'mappop__title', text: spot.name }),
      el('span', { class: badgeClassForSwim(spot.swimType), text: spot.swimType }),
      el('p', { class: 'mappop__swim', text: spot.swim }),
      el('div', { class: 'mappop__actions' }, [
        el('button', {
          class: 'btn btn--primary mappop__btn',
          type: 'button',
          text: 'View details',
          onclick: () => jumpToCard(spot.id),
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

    const origin = state.prefs.origin;
    const recs =
      origin && Logic.hasCoords(origin)
        ? Logic.recommendSwimSpots(SPOTS, origin, state.entries, { limit: 3 })
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
        fillColor: Logic.swimTypeColor(spot.swimType),
        fillOpacity: 0.95,
      });
      marker.bindPopup(buildPopup(spot));
      markersLayer.addLayer(marker);
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

    if (points.length) {
      map.fitBounds(points, { padding: [34, 34], maxZoom: 14 });
    }
    // The container may have just been un-hidden, so its size needs recomputing.
    setTimeout(() => map.invalidateSize(), 0);

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

  function syncViewToggle() {
    const mapView = state.prefs.view === 'map';
    const listBtn = $('#view-list');
    const mapBtn = $('#view-map');
    listBtn.classList.toggle('is-active', !mapView);
    mapBtn.classList.toggle('is-active', mapView);
    listBtn.setAttribute('aria-pressed', String(!mapView));
    mapBtn.setAttribute('aria-pressed', String(mapView));
  }

  function setView(view) {
    state.prefs.view = view === 'map' ? 'map' : 'list';
    savePrefs();
    syncViewToggle();
    render();
  }

  // ---------------------------------------------------------------------------
  // Saving a single field on the user's entry
  // ---------------------------------------------------------------------------
  async function saveField(spot, patch, saveStateEl) {
    const existing = Logic.myEntry(state.entries, spot.id, state.profile.id) || {};
    const merged = Logic.normalizeEntry({
      spotId: spot.id,
      authorId: state.profile.id,
      authorName: state.profile.name,
      visited: 'visited' in patch ? patch.visited : existing.visited,
      rating: 'rating' in patch ? patch.rating : existing.rating,
      comment: 'comment' in patch ? patch.comment : existing.comment,
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

    // Re-render so visited styling / stars / progress stay in sync.
    render();
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

    $('#swimmable-only').addEventListener('change', (e) => {
      state.prefs.swimmableOnly = e.target.checked;
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

    $('#theme-btn').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function init() {
    applyTheme(currentTheme());
    state.prefs = Object.assign(state.prefs, readJSON(PREFS_KEY, {}));
    state.profile = readJSON(PROFILE_KEY, null);

    bindControls();

    // Reflect persisted prefs into the static controls.
    $('#search').value = state.prefs.query || '';
    $('#swimmable-only').checked = !!state.prefs.swimmableOnly;
    $('#toggle-others').checked = !!state.prefs.showOthers;
    syncViewToggle();

    if (state.profile && state.profile.id) {
      startSession(state.profile);
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
