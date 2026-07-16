-- Swim + Work Seattle — D1 schema
-- One row per (spot_id, author_id): a person's notes on a spot.

CREATE TABLE IF NOT EXISTS entries (
  spot_id     TEXT    NOT NULL,
  author_id   TEXT    NOT NULL,
  author_name TEXT    NOT NULL DEFAULT 'Anonymous',
  visited       INTEGER NOT NULL DEFAULT 0,   -- 0/1
  want_to_visit INTEGER NOT NULL DEFAULT 0,    -- 0/1: user's "want to visit" wishlist flag
  rating        INTEGER,                       -- 0–5 (0 / NULL == unrated)
  comment       TEXT,                          -- note; capped at 250 chars in code
  swam_here     INTEGER NOT NULL DEFAULT 0,    -- 0/1: user reports swimming here; flips a "No swimming" spot to "Swim-possible"
  updated_at    TEXT    NOT NULL,              -- ISO-8601 timestamp
  PRIMARY KEY (spot_id, author_id)
);

-- Migrations for databases created before newer columns existed. SQLite has no
-- "ADD COLUMN IF NOT EXISTS"; run these once against an existing DB (each errors
-- harmlessly with "duplicate column name" on a DB already built from the
-- CREATE TABLE above):
--   ALTER TABLE entries ADD COLUMN swam_here INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE entries ADD COLUMN want_to_visit INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_entries_spot ON entries (spot_id);
CREATE INDEX IF NOT EXISTS idx_entries_author ON entries (author_id);

-- User-created spots. Public spots are visible to everyone and permanent (they
-- can't be deleted, only edited by their author); private spots are visible to
-- (and deletable by) their author only. Behave like curated spots otherwise.
CREATE TABLE IF NOT EXISTS user_spots (
  id          TEXT    NOT NULL PRIMARY KEY, -- app spot id, e.g. 'user-<uuid>'
  name        TEXT    NOT NULL,
  area        TEXT    NOT NULL DEFAULT 'Community spots',
  address     TEXT    NOT NULL DEFAULT '',
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  swim_type   TEXT    NOT NULL DEFAULT 'Shoreline access',
  water       TEXT    NOT NULL DEFAULT 'Fresh',
  good_for    TEXT    NOT NULL DEFAULT 'swim', -- comma-separated: swim,play,work
  description TEXT    NOT NULL DEFAULT '',
  author_id   TEXT    NOT NULL,
  author_name TEXT    NOT NULL DEFAULT 'Anonymous',
  is_public   INTEGER NOT NULL DEFAULT 0,    -- 0 private / 1 public
  created_at  TEXT    NOT NULL,              -- ISO-8601 timestamp
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_spots_author ON user_spots (author_id);
CREATE INDEX IF NOT EXISTS idx_user_spots_public ON user_spots (is_public);
