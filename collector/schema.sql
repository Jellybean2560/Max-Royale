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
  seen INTEGER,                -- when polling saved it (ms; null before 19 Nov 2026): a draft's cut (ALTER TABLE matches ADD COLUMN seen INTEGER)
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

-- One row per archived period. x (added 15 Nov 2026): the period's rating gap
-- and tower troop totals, { z: [16], tr: [[troop, games, wins, 3-crown wins]] };
-- set means its day_decks rows hold the full tally the stats sum
CREATE TABLE IF NOT EXISTS periods (
  start   INTEGER PRIMARY KEY,
  end     INTEGER,
  season  INTEGER,             -- the season it belongs to (its start)
  matches INTEGER,
  x       TEXT
);
-- Every deck played in a period: games, wins, draws, three-crown wins, and per
-- tower troop [[troop id, games, wins, three-crown wins]] as JSON. From 15 Nov
-- 2026 (added with ALTER TABLE … ADD COLUMN) also the rest of the stats tally:
-- tower damage dealt / taken summed and the games with it (hn), elixir leaked
-- and its games (ln), rating bands (bd), rating gap games / wins (z0, z1, y0, y1)
-- and close games (cg) packed four 15-bit counts to an integer, and counters in
-- c0, c1, … — two cards (by slot, state card_slots) to a column, [games, wins]
-- each — added by the Worker as cards appear (state card_cols). cx is unused.
CREATE TABLE IF NOT EXISTS day_decks (
  start INTEGER NOT NULL,
  deck  TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  tr    TEXT,
  dealt INTEGER, taken INTEGER, hn INTEGER, leak REAL, ln INTEGER,
  bd INTEGER, z0 INTEGER, z1 INTEGER, y0 INTEGER, y1 INTEGER, cg INTEGER,
  cx TEXT,
  PRIMARY KEY (start, deck)
) WITHOUT ROWID;
-- Every card (id + e / h form) per period; card '_' holds the period's matches in n.
-- b1n / b1w: games and wins at #1–100 rating, b2n / b2w at #101–1000 (from 15 Nov 2026)
CREATE TABLE IF NOT EXISTS card_days (
  start INTEGER NOT NULL,
  card  TEXT NOT NULL,
  n INTEGER, w INTEGER, d INTEGER, t INTEGER,
  b1n INTEGER, b1w INTEGER, b2n INTEGER, b2w INTEGER,
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
-- Per player and deck per archived period (kept PLAYER_DAYS_KEEP days): /top sums
-- the tracked players', the stats count each top deck's players. Every player from
-- 15 Nov 2026 (tracked players only before)
CREATE TABLE IF NOT EXISTS player_days (
  start INTEGER NOT NULL, tag TEXT NOT NULL, deck TEXT NOT NULL,
  n INTEGER, w INTEGER,
  PRIMARY KEY (start, tag, deck)
) WITHOUT ROWID;
-- A season's top decks without scanning all of them
CREATE INDEX IF NOT EXISTS season_decks_n ON season_decks (season, n);

-- River Race battles and duels from the same battle logs (19 Nov 2026), for a war
-- deck set builder; kept forever. rnd: a duel's round (1…), 0 for a single battle.
-- kind: the API's battle type. va / vb: average card level (1–16; war has no cap).
CREATE TABLE IF NOT EXISTS war_games (
  time INTEGER NOT NULL, pa TEXT NOT NULL, pb TEXT NOT NULL, rnd INTEGER NOT NULL,
  kind TEXT, da TEXT, db TEXT, ca INTEGER, cb INTEGER,
  va REAL, vb REAL, la REAL, lb REAL,
  seen INTEGER,
  PRIMARY KEY (time, pa, pb, rnd)
) WITHOUT ROWID;

-- Boat attacks (19 Nov 2026), attacker side: won = at least one tower destroyed,
-- nw new towers destroyed, pv towers already down, rm towers left, lv avg card level
CREATE TABLE IF NOT EXISTS boat_games (
  time INTEGER NOT NULL, tag TEXT NOT NULL, deck TEXT,
  won INTEGER, nw INTEGER, pv INTEGER, rm INTEGER, lv REAL, clan TEXT, dclan TEXT, seen INTEGER,
  PRIMARY KEY (time, tag)
) WITHOUT ROWID;
-- Players followed for war games and boat attacks (found by scout() in River Race logs)
CREATE TABLE IF NOT EXISTS war_players (
  tag TEXT PRIMARY KEY, src TEXT, clan TEXT, boat INTEGER, seen_at INTEGER, next_poll INTEGER, polls INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS war_players_next ON war_players (next_poll);
-- Clans whose latest race scout() reads (scanned_at: when, or when next for clans without boat attackers)
CREATE TABLE IF NOT EXISTS war_clans (
  tag TEXT PRIMARY KEY, top INTEGER DEFAULT 0, scanned_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS war_clans_scan ON war_clans (scanned_at);
