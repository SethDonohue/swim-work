# Swim + Work Seattle

A tiny static site that maps **swimmable spots around Seattle** (Lake Washington,
Lake Union, West Seattle, plus Green Lake) paired with **cafes and shaded parks
for working remotely**.

Each person signs in with a local profile and can:

- ✅ **Check off** spots they've visited
- ⭐ **Rate** each spot (0–5)
- 📝 **Leave comments / notes** (wifi, outlets, shade, swim quality…)
- 👀 **Toggle on other people's comments** to see what everyone else thinks

Comments sync through a small **Cloudflare Pages Function + D1** backend. If the
backend isn't reachable (e.g. opening the files directly, or before D1 is set
up), the app falls back to this-browser-only storage and shows a **"Local only"**
badge instead of **"Synced"**.

---

## Project layout

```
index.html            # markup + login gate
styles.css            # styling (light/dark)
app.js                # browser wiring (rendering + cloud/local store)
logic.js              # pure, testable logic (shared with tests)
data/spots.js         # the curated list of spots
functions/api/entries.js   # Cloudflare Pages Function (D1-backed CRUD)
schema.sql            # D1 table definition
wrangler.toml         # Cloudflare config + D1 binding
test/                 # node:test unit tests
```

No framework, no build step — it's plain HTML/CSS/JS so Cloudflare Pages can
serve the repo root as-is.

---

## Run locally

**Static only (no shared sync — quickest):**

```bash
# any static server works; e.g.
python3 -m http.server 8080
# open http://localhost:8080
```

You'll see the "Local only" badge; check-offs/comments save to your browser.

**Full stack with the D1 backend (recommended):**

```bash
npm install                 # installs wrangler locally
npm run db:create           # one-time: creates the D1 db, prints a database_id
# paste that id into wrangler.toml -> [[d1_databases]].database_id
npm run db:init:local       # creates the table in the local D1
npm run dev                 # wrangler pages dev . -> http://localhost:8788
```

Now the badge shows "Synced" and comments persist in D1.

---

## Run tests

```bash
npm test     # node --test
```

Covers the pure logic (filters, ratings, entry merging, others'-comment
visibility, progress stats) and validates the `data/spots.js` dataset
(unique ids, required fields, valid swim types).

---

## Deploy to Cloudflare Pages

1. Push this repo to GitHub (already wired to `SethDonohue/swim-work`).
2. In the Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to
   Git**, pick this repo.
   - **Build command:** _(none)_
   - **Build output directory:** `/`
3. Create the D1 database and bind it:
   ```bash
   npx wrangler d1 create swim-work          # copy the database_id
   npx wrangler d1 execute swim-work --remote --file=./schema.sql
   ```
   Then in the Pages project → **Settings → Functions → D1 database bindings**,
   add binding **`DB`** → database **`swim-work`** (and keep `wrangler.toml` in
   sync with the `database_id`).
4. Redeploy. Done.

---

## TODO / roadmap

- [ ] **Real authentication (Cloudflare Access).** Today "login" is just a local
  profile name — there's no security, and the backend trusts whatever author id
  the client sends. Next step: gate the site (and the `/api/*` routes) behind
  **Cloudflare Access** (Google / one-time-PIN email), and derive the author
  identity from the verified Access JWT (`Cf-Access-Jwt-Assertion` /
  `cf-access-authenticated-user-email`) instead of trusting the client.
- [ ] **See/track water quality per location.** Surface each beach's current
  water-quality status (bacteria advisories / closures) — e.g. from King County's
  Swim Beach Monitoring program and/or Seattle Parks beach closures — and let
  users log their own observations (clarity, algae, temperature) over time.
- [ ] Per-spot photos.
- [ ] "Hide visited" filter + sort options.
- [ ] Export/import a profile's notes as JSON.

### Next 10 feature ideas

1. [ ] **Interactive map view.** Add `lat`/`lng` to each spot and plot them on a
   map (Leaflet + OpenStreetMap, no API key) with markers color-coded by swim
   type. Click a marker to scroll to its card; toggle between list and map views.
2. [ ] **Live conditions per spot.** Pull current/forecast weather, air temp, UV
   index, and (where available) water temperature, plus today's sunrise/sunset,
   so you can decide *when* to go — not just *where*.
3. [ ] **Tide times for saltwater spots.** Use NOAA Tides & Currents to show the
   next low-tide window — especially useful for the tide-pooling spots
   (Constellation Park, Me-Kwa-Mooks).
4. [ ] **Lifeguard "open now" indicator.** Encode the seasonal lifeguard schedule
   + daily hours and show a live "Lifeguarded now / closed for season" badge on
   each beach.
5. [ ] **Favorites & a "to-try" list.** Let users star spots into a personal
   shortlist that's distinct from "visited", with a quick filter for each.
6. [ ] **Distance, sort, and directions.** With opt-in geolocation, sort spots by
   proximity and show drive/bike/transit time; add sort-by-rating and
   multi-tag filtering (e.g. "wifi-cafe" + "shaded").
7. [ ] **Community aggregates.** Show an average rating + visit count per spot
   (across all users), a "popular this week" sort, and a small sparkline of
   recent activity — turning individual notes into shared signal.
8. [ ] **Day-planner / itinerary builder.** Pair a swim spot with a nearby work
   cafe into a saveable, shareable plan, including a one-tap multi-stop Google
   Maps route.
9. [ ] **PWA + offline support.** Make it installable with a service worker so the
   spot list, your notes, and cached conditions work at the beach on weak signal.
10. [ ] **Comment interactions & moderation.** Add reactions/upvotes and threaded
    replies to notes, plus an edit/delete-own and report/hide control (pairs with
    the Cloudflare Access auth item above for trustworthy identity).

---

## Notes on the data

Seattle Parks runs **free lifeguarded beaches** (Lake Washington + Green Lake)
roughly **late June – early September** (2026: ~Jun 27 – Sep 7). Puget Sound
spots (Alki, Golden Gardens, West Seattle shoreline) stay **cold year-round
(~46–56°F)**. Lake Union has **no legal swimming** (hazardous sediment / spraypark
only) — those entries are included as work-with-a-view stops and labeled
accordingly. Always check current conditions before getting in the water.
