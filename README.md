# Swim + Work Seattle

A tiny static site that maps **swimmable spots around Seattle** (Lake Washington,
Lake Union, West Seattle, plus Green Lake) paired with **cafes and shaded parks
for working remotely**.

Each person signs in with a local profile and can:

- ✅ **Check off** spots they've visited
- ⭐ **Rate** each spot (0–5)
- 📝 **Leave comments / notes** (wifi, outlets, shade, swim quality…)
- 👀 **Toggle on other people's comments** to see what everyone else thinks
- 🗺️ **Browse a map** (List/Map toggle) with markers color-coded by swim type
- 🧭 **Find the nearest swim** from any park, cafe, or address — type a location,
  use your current location, or click the map; it ranks swimmable spots by a blend
  of distance and community rating
- 💧 **See live freshwater quality** — monitored Lake Washington + Green Lake
  beaches show a color-coded bacteria advisory, water temp, and sample date from
  King County; saltwater/unmonitored spots are clearly labeled "Not monitored"

Comments sync through a small **Cloudflare Worker + D1** backend (the Worker also
serves the static front-end via Workers static assets). If the backend isn't
reachable (e.g. opening the files directly, or before D1 is set up), the app
falls back to this-browser-only storage and shows a **"Local only"** badge
instead of **"Synced"**.

---

## Project layout

```
public/               # static front-end (served as Workers assets)
  index.html          #   markup + login gate
  styles.css          #   styling (light/dark)
  app.js              #   browser wiring (rendering + cloud/local store)
  logic.js            #   pure, testable logic (shared with tests)
  data/spots.js       #   the curated list of spots
src/index.mjs         # Cloudflare Worker: /api/entries (D1) + /api/geocode + /api/water + static assets
schema.sql            # D1 table definition
wrangler.toml         # Cloudflare config (Worker entry, assets, D1 binding)
test/                 # node:test unit tests
```

No framework, no build step — it's plain HTML/CSS/JS. Everything in `public/` is
served as Workers static assets, and `src/index.mjs` handles the `/api/*` routes.

---

## Run locally

**Static only (no shared sync — quickest):**

```bash
# any static server works; serve the public/ dir, e.g.
python3 -m http.server 8080 --directory public
# open http://localhost:8080
```

You'll see the "Local only" badge; check-offs/comments save to your browser.

**Full stack with the D1 backend (recommended):**

```bash
npm install                 # installs wrangler locally
npm run db:create           # one-time: creates the D1 db, prints a database_id
# paste that id into wrangler.toml -> [[d1_databases]].database_id
npm run db:init:local       # creates the table in the local D1
npm run dev                 # wrangler dev -> http://localhost:8787
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

## Deploy to Cloudflare (Workers + static assets)

> **Why Workers, not Pages?** Cloudflare has retired creating new **Pages**
> projects from the dashboard (there's no "Pages" tab anymore — only **Create
> application** under Workers & Pages). This project now deploys as a single
> **Worker** that serves the static files _and_ the `/api/*` routes, configured
> entirely in `wrangler.toml` (`main`, `[assets]`, and the `DB` binding). The
> default `npx wrangler deploy` build command "just works" with the token a
> Workers build injects — no Pages-scoped token needed.

Steps run in your **terminal** (the `wrangler` CLI) or on the **Cloudflare
website** (dashboard); each is labeled.

1. **[terminal]** Push this repo to GitHub (already wired to
   `SethDonohue/swim-work`).
2. **[terminal]** Authenticate once (opens a browser), then create the D1
   database and load the **production** schema from inside `~/code/swim-work`:
   ```bash
   npx wrangler login
   npx wrangler d1 create swim-work          # provisions the DB; prints a database_id
   npx wrangler d1 execute swim-work --remote --file=./schema.sql   # creates the table in PRODUCTION
   ```
   Paste the printed `database_id` into `wrangler.toml` →
   `[[d1_databases]].database_id` (it's an identifier, not a secret — safe to
   commit), then commit + push.
3. **[website]** Connect the repo as a **Worker**: dashboard → **Workers & Pages
   → Create application → Import a repository** (a.k.a. "Connect to Git"), pick
   this repo.
   - **Build command:** _(none)_
   - **Deploy command:** `npx wrangler deploy` (the default — leave it as-is).
   - Wrangler reads `wrangler.toml`, uploads the static assets, deploys
     `src/index.mjs`, and applies the `DB` binding automatically.
4. **[website] (verify)** Open the `swim-work` Worker → **Settings → Bindings**
   and confirm a **D1 database binding** named **`DB`** → database **`swim-work`**
   exists. It should be created from `wrangler.toml` on the first deploy; add it
   here manually only if it's missing.
5. **[website]** Trigger a deploy (push a commit, or **Deployments → Retry**).
   Done — the app should now show the **Synced** badge instead of **Local only**.

> **Local vs. remote:** the commands above set up the *production* database.
> Local dev (`npm run dev` → `wrangler dev`) uses a separate local database —
> seed it once with `npm run db:init:local`.

> You can also deploy straight from your machine (bypassing the Git build) with
> `npm run deploy` (`npx wrangler deploy`) after `npx wrangler login`.

### Troubleshooting

- **`Missing entry-point to Worker script or to assets directory`** — an old
  symptom from when this repo was a Pages-style project deployed through a
  Workers build. It's fixed: `wrangler.toml` now declares both `main`
  (`src/index.mjs`) and `[assets]`, so `npx wrangler deploy` has a valid entry
  point. Make sure the deploy command is the default `npx wrangler deploy` (not
  `wrangler pages deploy`).
- **`Authentication error [code: 10000]`** — caused by running
  `npx wrangler pages deploy` inside a Workers build (the injected token lacks
  Pages permissions). Don't use the Pages deploy command; the Workers token works
  fine with `npx wrangler deploy`.
- **App shows "Local only" in production** — the `DB` binding isn't reaching the
  Worker. Confirm `wrangler.toml` has the real `database_id` (not the
  placeholder), the binding shows up under the Worker's **Settings → Bindings**,
  and the production schema was loaded once with
  `npx wrangler d1 execute swim-work --remote --file=./schema.sql`.

---

## API routes

The Worker (`src/index.mjs`) exposes:

- `GET|PUT|DELETE /api/entries` — visited / rating / comment storage in D1.
- `GET /api/geocode?q=<place>` — geocodes a place/address to `{ lat, lng, label }`
  for the "nearest swim" finder. It proxies **OpenStreetMap Nominatim** (biased to
  the Seattle area), caches each lookup for a day, and sends a descriptive
  `User-Agent` per [Nominatim's usage policy](https://operations.osmfoundation.org/policies/nominatim/).
  Map tiles + geocoding are © OpenStreetMap contributors. For heavier use, swap in
  a dedicated geocoder (Mapbox, Google, etc.).
- `GET /api/water` — latest freshwater quality per beach:
  `{ source, updated, beaches: { "<beach>": { date, geomean30d, hightoday, nsampleshigh30d, watertempf } } }`.
  It proxies the [King County Swim Beach Monitoring](https://green2.kingcounty.gov/swimbeach/)
  Socrata dataset (`mbzm-4r9y`, no key), reduces to the newest sample per beach,
  and caches the result for 6h. The client maps each spot's `kcBeach` to this data
  and derives the advisory (`Logic.waterStatus`): a sample flagged high today →
  **High bacteria**; a 30-day E. coli geomean over **126 MPN/100mL** → **Caution**;
  otherwise **Good**. It's an advisory, not an official closure — always check the
  posted status before swimming.

## TODO / roadmap

- [ ] **Real authentication (Cloudflare Access).** Today "login" is just a local
  profile name — there's no security, and the backend trusts whatever author id
  the client sends. Next step: gate the site (and the `/api/*` routes) behind
  **Cloudflare Access** (Google / one-time-PIN email), and derive the author
  identity from the verified Access JWT (`Cf-Access-Jwt-Assertion` /
  `cf-access-authenticated-user-email`) instead of trusting the client.
- [~] **See/track water quality per location.**
  - [x] **Freshwater (Lake Washington + Green Lake) — done.** Each monitored
    beach has a `kcBeach` name mapping it to King County Swim Beach open data
    (Socrata `mbzm-4r9y.json`, JSON, no key; E. coli geomean + temp; weekly,
    ~mid-May→mid-Sep). The Worker proxies + caches it at `/api/water` and the
    card/map chips show a color-coded advisory + water temp + sample date.
    Swimmable saltwater + unmonitored spots render a muted "Not monitored" chip.
  - [ ] **Saltwater (Alki + West Seattle).** WA Dept. of Ecology's BEACH program
    Coastal Atlas ArcGIS layer (`gis.ecology.wa.gov/.../MapServer/888`) currently
    **403s** programmatic access (Azure gateway), so there's no live saltwater feed
    yet. Options: revisit with an Ecology-approved endpoint/token, or fall back to
    the EPA/USGS Water Quality Portal (`waterqualitydata.us`).
  - [ ] **User-logged observations.** Let users record their own clarity / algae /
    temperature notes per visit over time.
- [ ] Per-spot photos.
- [ ] "Hide visited" filter + sort options.
- [ ] Export/import a profile's notes as JSON.

### Next 10 feature ideas

1. [x] **Interactive map view.** ✅ Each spot has `lat`/`lng` and is plotted on a
   Leaflet + OpenStreetMap map (no API key) with markers color-coded by swim
   type (visited spots get a gold ring). A List/Map toggle switches views, a
   legend explains the colors, and a marker popup's "View details" button jumps
   to that spot's card.
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
6. [~] **Distance, sort, and directions.** ✅ Done: the "nearest swim" finder takes
   any park/cafe/address (geocoded), your geolocation, or a map click and ranks
   swimmable spots by distance blended with community rating. Still to do: show
   drive/bike/transit time, sort the main list by proximity, and multi-tag
   filtering (e.g. "wifi-cafe" + "shaded").
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
