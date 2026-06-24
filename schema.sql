-- Swim + Work Seattle — D1 schema
-- One row per (spot_id, author_id): a person's notes on a spot.

CREATE TABLE IF NOT EXISTS entries (
  spot_id     TEXT    NOT NULL,
  author_id   TEXT    NOT NULL,
  author_name TEXT    NOT NULL DEFAULT 'Anonymous',
  visited     INTEGER NOT NULL DEFAULT 0,   -- 0/1
  rating      INTEGER,                       -- 0–5 (0 / NULL == unrated)
  comment     TEXT,
  updated_at  TEXT    NOT NULL,              -- ISO-8601 timestamp
  PRIMARY KEY (spot_id, author_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_spot ON entries (spot_id);
CREATE INDEX IF NOT EXISTS idx_entries_author ON entries (author_id);
