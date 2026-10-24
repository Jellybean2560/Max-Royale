-- Max Royale meta collector. Apply with:
--   npx wrangler d1 execute max-royale-meta --remote --file=schema.sql

-- The global Path of Legends top 1,000, refreshed every few hours. Times in ms.
-- last_time: the newest ranked battle stored for them (unix seconds).
CREATE TABLE IF NOT EXISTS players (
  tag       TEXT PRIMARY KEY,
  name      TEXT,
  rank      INTEGER,
  rating    INTEGER,
  clan      TEXT,              -- clan name, from the leaderboard (added later: ALTER TABLE players ADD COLUMN clan TEXT)
  seen_at   INTEGER,           -- last leaderboard refresh they were on
  next_poll INTEGER,
  last_time INTEGER DEFAULT 0,
  polls     INTEGER DEFAULT 0
);
-- Picking the next players to poll reads a few rows instead of all 1,000
CREATE INDEX IF NOT EXISTS players_next_poll ON players (next_poll);

-- One row per ranked match, whichever top player's log it came from. The key
-- (time, both tags sorted) dedupes a match between two top players, and as a
-- WITHOUT ROWID table it is also the time index, so no second index to write.
-- Decks: sorted card ids, "e" / "h" suffix for a card played as evolution / hero.
CREATE TABLE IF NOT EXISTS matches (
  time INTEGER NOT NULL,       -- unix seconds
  pa   TEXT NOT NULL,
  pb   TEXT NOT NULL,
  da   TEXT,
  db   TEXT,
  ca   INTEGER,                -- crowns
  cb   INTEGER,
  ra   INTEGER,                -- rating before the match
  rb   INTEGER,
  PRIMARY KEY (time, pa, pb)
) WITHOUT ROWID;

-- Timestamps of the periodic jobs, counters, last error, and the computed stats
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT
);
