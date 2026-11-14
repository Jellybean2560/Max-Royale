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
  -- Added 28 Oct 2026 (null on older matches), via ALTER TABLE matches ADD COLUMN …:
  ta   INTEGER,                -- tower troop card id
  tb   INTEGER,
  ka   INTEGER,                -- king tower HP left (0 = destroyed)
  kb   INTEGER,
  sa   INTEGER,                -- princess towers' HP left, summed (destroyed ones count 0)
  sb   INTEGER,
  la   REAL,                   -- elixir leaked
  lb   REAL,
  PRIMARY KEY (time, pa, pb)
) WITHOUT ROWID;

-- Everyone's rating at each UTC day's first leaderboard refresh (kept 9 days),
-- so /top can show who climbed most over a day and a week. Added 28 Oct 2026.
CREATE TABLE IF NOT EXISTS ratings (
  day    TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  tag    TEXT NOT NULL,
  rating INTEGER,
  PRIMARY KEY (day, tag)
) WITHOUT ROWID;

-- Timestamps of the periodic jobs, counters, last error, and the computed stats
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- ── Archive (10 Nov 2026): kept forever, so the Meta screen can show any past
-- season and card trends since collection began. The archive job tallies each
-- finished period once — a UTC day, split where a season starts (first Monday
-- of the month, 09:00 UTC). Times in unix seconds.

-- One row per archived period
CREATE TABLE IF NOT EXISTS periods (
  start   INTEGER PRIMARY KEY,
  end     INTEGER,
  season  INTEGER,             -- the season it belongs to (its start)
  matches INTEGER
);
-- Every deck played in a period: games, wins, draws, three-crown wins, and per
-- tower troop [[troop id, games, wins, three-crown wins]] as JSON
CREATE TABLE IF NOT EXISTS day_decks (
  start INTEGER NOT NULL,
  deck  TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  tr    TEXT,
  PRIMARY KEY (start, deck)
) WITHOUT ROWID;
-- Every card (id + e / h form) per period; card '_' holds the period's matches in n
CREATE TABLE IF NOT EXISTS card_days (
  start INTEGER NOT NULL,
  card  TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  PRIMARY KEY (start, card)
) WITHOUT ROWID;
-- One card's days, for its all-time trend line
CREATE INDEX IF NOT EXISTS card_days_card ON card_days (card, start);
-- Running season totals, added to as each period is archived
CREATE TABLE IF NOT EXISTS season_decks (
  season INTEGER NOT NULL, deck TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  PRIMARY KEY (season, deck)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS season_cards (
  season INTEGER NOT NULL, card TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  PRIMARY KEY (season, card)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS season_troops (
  season INTEGER NOT NULL, troop INTEGER NOT NULL,
  n INTEGER, w INTEGER, t INTEGER,
  PRIMARY KEY (season, troop)
) WITHOUT ROWID;
-- Each season's stats as served by /season (JSON), rebuilt as periods are added
CREATE TABLE IF NOT EXISTS seasons (
  start INTEGER PRIMARY KEY,
  v     TEXT
);
-- Per tracked player and deck per archived period, for /top (kept PLAYER_DAYS_KEEP days)
CREATE TABLE IF NOT EXISTS player_days (
  start INTEGER NOT NULL, tag TEXT NOT NULL, deck TEXT NOT NULL,
  n INTEGER, w INTEGER,
  PRIMARY KEY (start, tag, deck)
) WITHOUT ROWID;
-- A season's top decks without scanning all of them
CREATE INDEX IF NOT EXISTS season_decks_n ON season_decks (season, n);
