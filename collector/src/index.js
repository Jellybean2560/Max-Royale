// Max Royale meta collector.
//
// Collects the ranked (Path of Legends) matches of the global top 1,000 and keeps
// deck and card win rates for the app. The API only shows a player's last 30
// battles, so each player is polled again before their log can roll over: busy
// players every hour or two, quiet ones twice a day.
//
// Runs on the Workers free plan, which shapes everything here:
//  - one job per minute (cron), each small: 10 ms CPU and 50 subrequests a run
//  - D1 free tier: 100k rows written and 5M read a day. Inserts go in one query
//    each (rows passed as one JSON parameter — D1 allows only 100 bound
//    parameters), matches are stored once (no extra index) and kept 90 days,
//    and the stats are computed every 1–24 hours as their cost allows, not per
//    request. The archive tallies each finished day once (day_decks); a stats
//    run sums the stored days and reads only the matches not archived yet, and
//    /top sums per-player daily tallies the same way. Every query's
//    rows_read (polling too) is counted per UTC day, and a heavy job that would
//    push the day past READ_BUDGET minus the polling reserve waits for tomorrow
//    instead of running into D1's limit.
//
// GET /meta    the latest stats (CORS open, for the app)
// GET /top     the top 1,000 with rank, rating, clan and main deck
// GET /history one card tally per day, for the app's trend lines
// GET /counters the top decks' records against each opponent card
// GET /status  collection progress, reads used today and the last error

const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const BOARD_EVERY = 6 * HOUR;       // leaderboard refresh
const PRUNE_EVERY = DAY;
// Raw matches older than this are deleted. The stats, /top and the archive only
// read the last ~9 days (everything older lives on in the daily tallies, kept
// forever); at 90 days the matches alone would have filled D1's free 500 MB by
// Jan 2027 (~5 MB a day, Nov 2026)
const KEEP_DAYS = 30;
const WINDOW_DAYS = 7;              // the stats cover this many days
const PLAYERS_PER_RUN = 5;          // battle logs fetched per minute (~7,200 a day max)
const RETRY_AFTER = 30 * MINUTE;    // a failed periodic job or battle log waits this long
const MIN_INTERVAL = 30 * MINUTE;
const MAX_INTERVAL = 12 * HOUR;
const TOP_DECKS = 300;              // enough to search by card and find similar decks
// /meta and /top are recomputed as often as their cost allows: each job gets a
// daily share of the read budget and runs every (24 h × last run's reads / share),
// kept between 1 and 24 hours — every few hours while the window is young and
// runs are cheap, less often once a full week (and the week before) is read
const STATS_SHARE = 1.1e6, TOP_SHARE = 0.45e6;
const DECK_DAYS = 8;                // deck_days keeps each day's top decks this long, for rising / new decks
const GAP_STEP = 40, GAPS = 8;      // rating gap buckets for the skill adjustment: < -120, -120…-80, …, ≥ +120
const HISTORY_DAYS = 63;            // /history keeps a card tally per day this long: two 4-week blocks for month vs month
const ACTIVITY_DAYS = 35;
const RATING_DAYS = 9;              // /top reads the ratings a day and a week back (the table itself is kept forever)
// D1 allows 100 columns in a result (a CTE too) and 127 arguments to a function,
// so per-deck counts are packed 4 to an integer column, 15 bits each (a deck
// plays far fewer than 32,767 games a week), and unpacked in the final select
const BITS = 15, MASK = (1 << BITS) - 1, CHUNK = 100;
const MIN_REFRESH = HOUR, MAX_REFRESH = 24 * HOUR;
const refreshEvery = (reads, share) => Math.min(MAX_REFRESH, Math.max(MIN_REFRESH, DAY * (reads || 0) / share));
// 2.3M of D1's free 5M rows read a day (Cloudflare mails warnings from 80%), all
// queries counted; heavy jobs leave POLL_RESERVE for polling (~150k a day),
// the leaderboard, pruning and /status
const READ_BUDGET = 2.3e6, POLL_RESERVE = 250e3;   // raised from 2M by the user, 10 Nov 2026
// D1's free 100k rows written a day (index entries count too; Cloudflare mails
// when it's hit, 14 Nov 2026). Writes are counted like reads; the archive and
// prune only run if their last run's writes leave WRITE_RESERVE for polling
// (~25k a day), and everything but the stats and /top stops at WRITE_BUDGET,
// below the limit for what isn't counted (state rows, manual work)
const WRITE_BUDGET = 92e3, WRITE_RESERVE = 30e3, WRITE_GUESS = { archive: 12e3, prune: 25e3, draft: 8e3 };
// next_poll of players who fell off the leaderboard: past the end of the poll
// index's range, so picking who to poll no longer walks over them (700 stale
// overdue rows were read on every poll — ~1M rows a day — before this)
const PARKED = 9e15;
// A new season empties the leaderboard: only players already back in Ultimate
// Champion are listed (44 the day after the Nov 2026 reset). While it holds fewer
// than MIN_BOARD, last season's top 1,000 — everyone on the last board that was
// full (full_board_at) — stay polled, so the stats don't run dry.
const MIN_BOARD = 500;
// Players are polled when seen on the current board, or on the last full one while it's short
const pollFrom = st => Math.min(+st.board_at || 0, +st.full_board_at || +st.board_at || 0) - HOUR;
// Full tower HP in ranked, for damage = full − left. Princess HP depends on the
// tower troop, so each troop's full pair is learnt from the data (the most seen
// left standing in recent matches) and kept as the highest ever seen. These are
// the starting values, from ranked battles Oct 2026 (king 7,728; Tower Princess 4,858 each).
const KING_HP = 7728, PRINCESS_HP = { 159000000: 2 * 4858 };
// D1 refuses queries ("D1 DB is overloaded") once about 10 s of work falls in
// any 10-second window, and a week's grouping takes ~7 s on its own (610k rows,
// Nov 2026) — so a stats run waits this long after each grouping before the next query
const D1_PAUSE = 12e3;
const pause = () => new Promise(r => setTimeout(r, D1_PAUSE));
const TOWER_SAMPLE = 3000;          // recent matches read to learn full tower HP
// The archive (kept forever): a period is tallied once it's this old — a
// player's log is read at most every 12 h, so their matches can arrive that late
// 13 h left ~1.5% of a day's matches out (14 Nov 2026: players woken or polled
// late); after 25 h fewer than 0.2% still arrive
const ARCHIVE_LAG = 25 * HOUR;
// Until then a finished day gets a provisional tally (a "draft") DRAFT_LAG after
// it ends, from the matches saved by then (matches.seen before its cut); the stats
// and /top sum it like an archived day and read only the day's matches saved
// after the cut live. The final archive replaces its rows. Without it the stats
// tallied ~2 days of raw matches a run (~540k rows, Nov 2026).
const DRAFT_LAG = 30 * MINUTE;
const SEASON_DECKS = 300;           // decks served per season
const RIVALS_EVERY = 72 * HOUR;     // /top recounts the rivalries every third day (~300k rows, Nov 2026)
const TOP_STARVED = 48 * HOUR;      // /top this old jumps ahead of the stats
const PLAYER_DAYS_KEEP = 9;         // days of per-player deck tallies kept for /top
// While the archive is more than a day behind, /top runs at most every 48 h, so
// the backlog gets the budget it frees (stats ~1.1M + /top ~0.8M + polling left
// ~90k a day — one period — in Nov 2026)
const TOP_EVERY_BACKLOG = 48 * HOUR;
// Path of Legends seasons start the first Monday of the month at 09:00 UTC
const firstMonday = (y, m) => { const dow = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + (8 - dow) % 7, 9); };
function seasonStartOf(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), start = firstMonday(y, m);
  return t < start ? firstMonday(y, m - 1) : start;
}
const nextSeasonStart = t => { const d = new Date(seasonStartOf(t)); return firstMonday(d.getUTCFullYear(), d.getUTCMonth() + 1); };
// The period starting at `start` (ms) ends at the next UTC midnight or season start, whichever is first
const periodEnd = start => Math.min(Math.floor(start / DAY + 1) * DAY, nextSeasonStart(start));

export default {
  async scheduled(event, env, ctx) {
    if (env.PAUSED === '1') return;  // wrangler.toml [vars]: collection paused, no D1 access at all
    // An overloaded D1 also refuses the error's own write, so that waits for the window to clear
    ctx.waitUntil(tick(env).catch(async e => {
      const error = { last_error: `${new Date().toISOString()} ${stage ? `[${stage}] ` : ''}${e.message}` };
      await setState(env, error).catch(() => new Promise(r => setTimeout(r, 15e3)).then(() => setState(env, error)));
    }));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (['/meta', '/top', '/history', '/counters', '/war'].includes(url.pathname)) {
      const row = await env.DB.prepare(`SELECT v FROM state WHERE k = ?1`).bind(url.pathname.slice(1)).first();
      return new Response(row?.v || JSON.stringify({ empty: true }), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    }
    // The archive: the seasons kept, one season's stats, one card's daily tally since collection began
    if (url.pathname === '/seasons') {
      const row = await env.DB.prepare(`SELECT v FROM state WHERE k = 'season_list'`).first();
      return new Response(row?.v || '{"seasons":[]}', { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    }
    if (url.pathname === '/season') {
      const row = await env.DB.prepare(`SELECT v FROM seasons WHERE start = ?1`).bind(Math.floor(+url.searchParams.get('start') / 1000) || 0).first();
      return new Response(row?.v || JSON.stringify({ empty: true }), { status: row ? 200 : 404, headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    }
    if (url.pathname === '/card') {
      const id = parseInt(url.searchParams.get('id'), 10);
      if (!Number.isInteger(id)) return new Response('{"error":"id"}', { status: 400, headers });
      // card '_' is each period's match count; the card's forms are added up
      const { results } = await env.DB.prepare(`
        SELECT start, SUM(CASE WHEN card = '_' THEN n END) AS m, SUM(CASE WHEN card != '_' THEN n END) AS n, SUM(CASE WHEN card != '_' THEN w END) AS w
        FROM card_days WHERE card IN ('_', ?1, ?1 || 'e', ?1 || 'h') GROUP BY start ORDER BY start`).bind(String(id)).all();
      return new Response(JSON.stringify({ id, days: results.map(r => [r.start * 1000, r.m || 0, r.n || 0, r.w || 0]) }),
        { headers: { ...headers, 'Cache-Control': 'public, max-age=3600' } });
    }
    // Small and live, for the app's Meta screen: whether collection is paused at a
    // daily limit or has stopped (~40 state rows read; the app asks at most every 5 min)
    if (url.pathname === '/health') {
      const st = await getState(env), now = Date.now();
      const reads = readsToday(st, now), writes = writesToday(st, now), polled = +st.last_poll_at || 0;
      const statsLate = now - (+st.stats_at || 0) > refreshEvery(+st.stats_reads, STATS_SHARE) + 30 * MINUTE;
      const status = env.PAUSED === '1' ? 'paused'
        : writes >= WRITE_BUDGET ? 'writes'
        : now - polled > 2 * HOUR ? 'stalled'
        : statsLate && reads + (+st.stats_reads || 0) > READ_BUDGET - POLL_RESERVE ? 'reads'
        : 'ok';
      return new Response(JSON.stringify({ status, now, resumes: (Math.floor(now / DAY) + 1) * DAY, polled_at: polled || null, stats_at: +st.stats_at || null,
        reads, read_budget: READ_BUDGET, writes, write_budget: WRITE_BUDGET }), { headers: { ...headers, 'Cache-Control': 'public, max-age=300' } });
    }
    if (url.pathname === '/status') {
      const st = await getState(env);
      const board = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(polls > 0) AS polled FROM players WHERE seen_at >= ?1`).bind(pollFrom(st)).first();
      const [day, war] = await env.DB.batch([`matches`, `war_games`].map(t =>
        env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE time >= ?1`).bind(Math.floor((Date.now() - DAY) / 1000))));
      return new Response(JSON.stringify({ ...st, players: board?.n || 0, players_polled: board?.polled || 0, matches_last_24h: day.results[0]?.n || 0,
        war_games_last_24h: war.results[0]?.n || 0 }, null, 2), { headers });
    }
    return new Response('Max Royale meta collector — see /meta, /top and /status', { status: 404 });
  },
};

// ── One job per minute: whichever periodic job is due, else poll players ──
// A job is due when its last success is older than its interval and it hasn't
// been tried in the last RETRY_AFTER — so a failing job is retried every half
// hour, not every minute (a failing stats run would burn ~400k rows read each
// time), and polling carries on in between.
async function tick(env) {
  const now = Date.now(), st = await getState(env);
  const due = (job, every) => now - (+st[`${job}_at`] || 0) > every && now - (+st[`${job}_try_at`] || 0) > RETRY_AFTER;
  const run = async (job, fn) => {
    await setState(env, { [`${job}_try_at`]: now });
    try {
      return await fn(env, now, st);
    } catch (e) {
      // A heavy job that fails late has still read its rows (D1 counts them), so
      // they go on today's count — six uncounted failed stats runs took a day past
      // D1's free 5M reads (4 Nov 2026). Its last run's reads are the estimate.
      if (st[`${job}_reads`]) {
        const add = async () => { const cur = await getState(env); await setState(env, { reads_day: dayKey(now), reads_count: readsToday(cur, now) + +st[`${job}_reads`] }); };
        await add().catch(() => pause().then(add)).catch(() => {});
      }
      throw e;
    }
  };
  if (!st.started_at) await setState(env, { started_at: now });
  // A heavy job runs only if what it read last time still fits in today's budget
  const fits = job => readsToday(st, now) + (+st[`${job}_reads`] || 0) <= READ_BUDGET - POLL_RESERVE;
  // The heavy writers run only if what they wrote last time leaves room for polling
  const fitsWrites = job => writesToday(st, now) + (+st[`${job}_writes`] || WRITE_GUESS[job]) <= WRITE_BUDGET - WRITE_RESERVE;
  const writesFull = writesToday(st, now) >= WRITE_BUDGET;
  if (!writesFull && due('board', BOARD_EVERY)) return run('board', refreshBoard);
  // /top two days stale (stats kept taking the day's budget first): it goes before the stats this once
  if (+st.matches_total > 0 && now - (+st.top_at || 0) > TOP_STARVED && due('top', 0) && fits('top')) return run('top', computeTop);
  // A finished day's draft goes first, so the stats after it can use it
  if (+st.archive_to && periodEnd(draftStart(st)) <= now - DRAFT_LAG && now - (+st.draft_try_at || 0) > 10 * MINUTE && fits('draft') && fitsWrites('draft')) return run('draft', draftPeriod);
  if (+st.matches_total > 0 && due('stats', refreshEvery(+st.stats_reads, STATS_SHARE)) && fits('stats')) return run('stats', computeStats);
  const backlog = +st.archive_to && periodEnd(+st.archive_to) <= now - ARCHIVE_LAG - DAY;
  if (+st.matches_total > 0 && due('top', Math.max(refreshEvery(+st.top_reads, TOP_SHARE), backlog ? TOP_EVERY_BACKLOG : 0)) && fits('top')) return run('top', computeTop);
  // The archive takes one finished period a run, oldest first (a backlog drains as the budget allows)
  if (+st.archive_to && periodEnd(+st.archive_to) <= now - ARCHIVE_LAG && now - (+st.archive_try_at || 0) > 10 * MINUTE && fits('archive') && fitsWrites('archive')) return run('archive', archivePeriod);
  if (due('prune', PRUNE_EVERY) && fitsWrites('prune')) return run('prune', prune);
  if (due('war', WAR_EVERY) && fits('war')) return run('war', computeWar);
  // Near the day's write limit: wait for midnight UTC (a log polled late still has 30 battles)
  if (writesFull) return;
  return pollPlayers(env, now, st);
}

// D1's daily limits reset at midnight UTC
const dayKey = now => new Date(now).toISOString().slice(0, 10);
const readsToday = (st, now) => st.reads_day === dayKey(now) ? +st.reads_count || 0 : 0;
const rowsRead = results => results.reduce((sum, r) => sum + (r?.meta?.rows_read || 0), 0);
const writesToday = (st, now) => st.writes_day === dayKey(now) ? +st.writes_count || 0 : 0;
const rowsWritten = results => results.reduce((sum, r) => sum + (r?.meta?.rows_written || 0), 0);
// Today's read and write counters with a job's added
const usage = (st, now, reads, writes) => ({ reads_day: dayKey(now), reads_count: readsToday(st, now) + reads,
  writes_day: dayKey(now), writes_count: writesToday(st, now) + writes });
// Adds a job's reads to today's count and remembers them as its next estimate
async function countReads(env, job, now, reads, extra, writes = 0) {
  const st = await getState(env);
  await setState(env, { ...extra, ...usage(st, now, reads, writes), [`${job}_reads`]: reads, ...(writes ? { [`${job}_writes`]: writes } : {}) });
}

// The app's proxy Worker forwards the path to the Clash Royale API
async function api(env, path) {
  for (let attempt = 0; ; attempt++) {
    const res = await env.CR.fetch('https://cr' + path.replace(/#/g, '%23'));
    if (res.ok) return res.json();
    if (res.status < 500 || attempt >= 1) throw new Error(`API ${res.status} for ${path}`);
  }
}

async function refreshBoard(env, now, st) {
  const board = await api(env, '/locations/global/pathoflegend/players?limit=1000');
  const items = (board.items || []).map(p => ({ tag: p.tag, name: p.name, rank: p.rank, rating: p.eloRating, clan: p.clan?.name || null }));
  if (!items.length) throw new Error('empty leaderboard');
  const used = [];
  // New players are due at once; existing ones keep their schedule
  used.push(await env.DB.prepare(`
    INSERT INTO players (tag, name, rank, rating, clan, seen_at, next_poll)
    SELECT json_extract(value, '$.tag'), json_extract(value, '$.name'), json_extract(value, '$.rank'),
           json_extract(value, '$.rating'), json_extract(value, '$.clan'), ?2, ?2
    FROM json_each(?1) WHERE true
    ON CONFLICT (tag) DO UPDATE SET name = excluded.name, rank = excluded.rank,
      rating = excluded.rating, clan = excluded.clan, seen_at = excluded.seen_at,
      next_poll = CASE WHEN players.next_poll >= ${PARKED} THEN excluded.next_poll ELSE players.next_poll END`).bind(JSON.stringify(items), now).run());
  const full = items.length >= MIN_BOARD;
  if (full) {
    // Players no longer on it are parked until they come back
    used.push(await env.DB.prepare(`UPDATE players SET next_poll = ${PARKED} WHERE seen_at < ?1 AND next_poll < ${PARKED}`).bind(now).run());
  } else if (st.full_board_at) {
    // Season start: last season's top 1,000 are woken (once) and kept polled
    used.push(await env.DB.prepare(`UPDATE players SET next_poll = ?2 WHERE next_poll >= ${PARKED} AND seen_at >= ?1`).bind(+st.full_board_at - HOUR, now).run());
  }
  // Each UTC day's first refresh keeps everyone's rating, for the climb over a day / week
  used.push(await env.DB.prepare(`
    INSERT OR IGNORE INTO ratings (day, tag, rating)
    SELECT ?2, json_extract(value, '$.tag'), json_extract(value, '$.rating') FROM json_each(?1)`).bind(JSON.stringify(items), dayKey(now)).run());
  await setState(env, { board_at: now, board_size: items.length, ...(full ? { full_board_at: now } : {}), ...usage(st, now, rowsRead(used), rowsWritten(used) + 3) });
}

// API timestamps look like 20261012T105805.000Z → unix seconds
const apiTime = ts => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(9, 11), +ts.slice(11, 13), +ts.slice(13, 15)) / 1000;
// Sorted card ids, "e" / "h" for a card played as its evolution / hero form
const deckKey = cards => cards.map(c => {
  const form = (c.evolutionLevel || 0) & 1 ? 'e' : (c.evolutionLevel || 0) & 2 ? 'h' : '';
  return c.id + form;
}).sort().join(',');

// One side's tower troop, towers left and elixir leaked. Destroyed princess
// towers drop out of the array (absent = both fell); a fallen king reads 0.
const side = (k, p) => ({
  [`t${k}`]: p.supportCards?.[0]?.id ?? null,
  [`k${k}`]: p.kingTowerHitPoints ?? null,
  [`s${k}`]: p.kingTowerHitPoints == null ? null : (p.princessTowersHitPoints || []).reduce((a, b) => a + b, 0),
  [`l${k}`]: p.elixirLeaked ?? null,
});

// ── War games (19 Nov 2026): River Race battles and duels in the same battle logs,
// kept apart from ranked (war_games) for a war deck set builder later. War isn't
// matched by rating, so the opponent can be anyone. A duel's rounds are stored one
// row each (rnd 1…) if the log lists them, else the battle as rnd 0. Kept forever (small).
const WAR_TYPES = ['riverRacePvP', 'riverRaceDuel', 'riverRaceDuelColosseum'];
// A side's average card level on the 1–16 scale (war has no level cap)
const avgLevel = cards => {
  const lv = (cards || []).filter(c => c.level && c.maxLevel).map(c => c.level + 16 - c.maxLevel);
  return lv.length ? Math.round(lv.reduce((a, b) => a + b, 0) / lv.length * 100) / 100 : null;
};
function warGames(b, t) {
  const me = b.team?.[0], opp = b.opponent?.[0];
  if (!me?.tag || !opp?.tag) return [];
  const [a, o] = [me, opp].sort((x, y) => (x.tag < y.tag ? -1 : 1));
  const game = (rnd, A, O) => A?.cards?.length === 8 && O?.cards?.length === 8 ? [{
    t, pa: a.tag, pb: o.tag, rnd, kind: b.type, da: deckKey(A.cards), db: deckKey(O.cards), ca: A.crowns || 0, cb: O.crowns || 0,
    va: avgLevel(A.cards), vb: avgLevel(O.cards), la: A.elixirLeaked ?? null, lb: O.elixirLeaked ?? null }] : [];
  const ra = a.rounds, ro = o.rounds;
  if (Array.isArray(ra) && Array.isArray(ro) && ra.length && ra.length === ro.length) return ra.flatMap((r, i) => game(i + 1, r, ro[i]));
  return game(0, a, o);
}

// /war: every deck in the war games of the last WAR_DAYS, both sides (the
// opponent's deck is a war deck too) — [key, games, wins, avg card level of the
// players with it, of their opponents, different players], most played first
const WAR_DAYS = 28, WAR_EVERY = 6 * HOUR, WAR_DECKS = 500;
async function computeWar(env, now) {
  const since = Math.floor((now - WAR_DAYS * DAY) / 1000);
  const [decks, tot] = await env.DB.batch([
    env.DB.prepare(`
      WITH s AS (
        SELECT da AS deck, pa AS p, ca > cb AS w, va AS v, vb AS o FROM war_games WHERE time >= ?1
        UNION ALL SELECT db, pb, cb > ca, vb, va FROM war_games WHERE time >= ?1)
      SELECT deck, COUNT(*) AS n, SUM(w) AS w, ROUND(AVG(v), 2) AS v, ROUND(AVG(o), 2) AS o, COUNT(DISTINCT p) AS p
      FROM s GROUP BY deck ORDER BY n DESC LIMIT ?2`).bind(since, WAR_DECKS),
    env.DB.prepare(`SELECT COUNT(*) AS n, MIN(time) AS first FROM war_games WHERE time >= ?1`).bind(since),
  ]);
  const t = tot.results[0] || {};
  const war = { updated: now, next: now + WAR_EVERY, window_days: WAR_DAYS, games: t.n || 0, first: t.first ? t.first * 1000 : null,
    decks: decks.results.map(r => [r.deck, r.n, r.w, r.v, r.o, r.p]) };
  await countReads(env, 'war', now, rowsRead([decks, tot]), { war_at: now, war: JSON.stringify(war) }, 3);
}

async function pollPlayers(env, now, st) {
  const dueRes = await env.DB.prepare(`
    SELECT tag, last_time FROM players WHERE seen_at >= ?1 AND next_poll <= ?2
    ORDER BY next_poll LIMIT ?3`).bind(pollFrom(st), now, PLAYERS_PER_RUN).all();
  const due = dueRes.results;
  if (!due.length) return;
  const logs = await Promise.all(due.map(p => api(env, `/players/${p.tag}/battlelog`).catch(e => ({ error: e.message }))));

  const matches = [], updates = [], war = [];
  let errors = 0, duelSample = null;
  // Tower troop names and art, so /meta can show them; saved when a new one turns up
  const troopNames = JSON.parse(st.troop_names || '{}'), newTroops = {};
  due.forEach((p, i) => {
    const log = logs[i];
    if (!Array.isArray(log)) {
      errors++;
      updates.push({ tag: p.tag, next: now + RETRY_AFTER, last: p.last_time });
      return;
    }
    let last = p.last_time || 0;
    for (const b of log) {
      // War battles: every one in the log (the insert skips those already saved)
      if (WAR_TYPES.includes(b.type) && b.battleTime) {
        war.push(...warGames(b, apiTime(b.battleTime)));
        if (b.type !== 'riverRacePvP' && !st.war_duel_seen && !duelSample) duelSample = b;
        continue;
      }
      if (b.type !== 'pathOfLegend' || !b.battleTime) continue;
      const t = apiTime(b.battleTime);
      if (t <= (p.last_time || 0)) continue;
      const me = b.team?.[0], opp = b.opponent?.[0];
      if (me?.cards?.length !== 8 || opp?.cards?.length !== 8) continue;
      const [a, o] = [me, opp].sort((x, y) => (x.tag < y.tag ? -1 : 1));
      matches.push({ t, pa: a.tag, pb: o.tag, da: deckKey(a.cards), db: deckKey(o.cards),
                     ca: a.crowns || 0, cb: o.crowns || 0, ra: a.startingTrophies ?? null, rb: o.startingTrophies ?? null,
                     ...side('a', a), ...side('b', o) });
      for (const x of [a, o]) for (const c of x.supportCards || []) if (!troopNames[c.id]) newTroops[c.id] = [c.name, c.iconUrls?.medium || ''];
      last = Math.max(last, t);
    }
    // Poll again before the 30-battle log can roll over: at half the time its
    // battles span (all modes count toward the 30)
    const times = log.map(b => b.battleTime && apiTime(b.battleTime)).filter(Boolean);
    const span = times.length >= 25 ? (Math.max(...times) - Math.min(...times)) * 1000 : Infinity;
    const interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, span / 2));
    updates.push({ tag: p.tag, next: now + interval, last });
  });

  let inserted = 0, insertRes = null;
  if (matches.length) {
    const res = insertRes = await env.DB.prepare(`
      INSERT OR IGNORE INTO matches (time, pa, pb, da, db, ca, cb, ra, rb, ta, tb, ka, kb, sa, sb, la, lb, seen)
      SELECT json_extract(value, '$.t'), json_extract(value, '$.pa'), json_extract(value, '$.pb'),
             json_extract(value, '$.da'), json_extract(value, '$.db'), json_extract(value, '$.ca'),
             json_extract(value, '$.cb'), json_extract(value, '$.ra'), json_extract(value, '$.rb'),
             json_extract(value, '$.ta'), json_extract(value, '$.tb'), json_extract(value, '$.ka'),
             json_extract(value, '$.kb'), json_extract(value, '$.sa'), json_extract(value, '$.sb'),
             json_extract(value, '$.la'), json_extract(value, '$.lb'), ?2
      FROM json_each(?1) RETURNING time`).bind(JSON.stringify(matches), now).all();
    inserted = res.results.length;
  }
  let warRes = null;
  if (war.length) warRes = await env.DB.prepare(`
    INSERT OR IGNORE INTO war_games (time, pa, pb, rnd, kind, da, db, ca, cb, va, vb, la, lb, seen)
    SELECT value ->> 't', value ->> 'pa', value ->> 'pb', value ->> 'rnd', value ->> 'kind', value ->> 'da', value ->> 'db',
           value ->> 'ca', value ->> 'cb', value ->> 'va', value ->> 'vb', value ->> 'la', value ->> 'lb', ?2
    FROM json_each(?1)`).bind(JSON.stringify(war), now).run();
  // Matches per UTC hour, from the ones actually inserted (a match between two
  // top players is seen twice). Matches before `from` are counted once by the
  // stats job (seedActivity).
  const act = JSON.parse(st.activity || '{"days":{}}');
  const actFrom = act.from || Math.floor(now / 1000);
  let actChanged = !act.from;
  for (const r of insertRes?.results || []) {
    if (r.time < actFrom) continue;
    const k = dayKey(r.time * 1000);
    (act.days[k] ||= Array(24).fill(0))[new Date(r.time * 1000).getUTCHours()]++;
    actChanged = true;
  }
  if (actChanged) {
    act.from = actFrom;
    for (const k in act.days) if (Date.parse(k) < now - ACTIVITY_DAYS * DAY) delete act.days[k];
  }
  const updateRes = await env.DB.prepare(`
    UPDATE players SET next_poll = json_extract(j.value, '$.next'), last_time = json_extract(j.value, '$.last'),
      polls = polls + 1
    FROM json_each(?1) AS j WHERE players.tag = json_extract(j.value, '$.tag')`).bind(JSON.stringify(updates)).run();
  const reads = rowsRead([dueRes, insertRes, updateRes, warRes]) + 25;  // + the tick's state read
  const warNew = warRes?.meta?.changes || 0;
  await setState(env, {
    ...usage(st, now, reads, rowsWritten([insertRes, updateRes, warRes]) + 4),  // + the state rows
    ...(warNew ? { war_total: (+st.war_total || 0) + warNew } : {}),
    // The first duel seen, whole, to check how the log lists its rounds
    ...(duelSample ? { war_duel_sample: JSON.stringify(duelSample), war_duel_seen: 1 } : {}),
    last_poll_at: now,
    polls_total: (+st.polls_total || 0) + due.length,
    matches_total: (+st.matches_total || 0) + inserted,
    ...(actChanged ? { activity: JSON.stringify(act) } : {}),
    ...(Object.keys(newTroops).length ? { troop_names: JSON.stringify({ ...troopNames, ...newTroops }) } : {}),
    ...(errors ? { last_error: `${new Date(now).toISOString()} ${errors} battle log(s) failed: ${logs.find(l => l.error)?.error}` } : {}),
  });
}

// Deck and card stats over the last WINDOW_DAYS, both sides of every match, plus
// the week before for trends once collection has run that long (skipped until
// then: it would only read rows to describe a half-collected week)
// The step a stats run is at, for its error message
let stage = '';
const step = name => { stage = name; console.log(`stats: ${name} at ${Date.now()}`); };
// ── Deck tallies: the same per-deck counts for the archive (one finished period,
// stored in day_decks) and the stats (the parts of the window not archived yet).
// Summing stored days instead of re-reading a week of matches keeps a stats run
// at a fraction of the rows and time — the full-week grouping took 12.9 s by
// Nov 2026, past the ~10 s D1 allows in a 10-second window.
//
// Counters (a top deck's games and wins against each opponent card) are kept as
// integer columns c0, c1, … of day_decks, two cards to a column — [games, wins]
// of one card in bits 0–29, the other's in 30–59 — so stored days are summed
// like any number (a JSON object per deck and day cost ~360k rows read a run to
// unpack). Each card has a fixed slot (state card_slots, append-only): a new card
// gets the next one, and a new column is added when the slots outgrow them
// (card_cols). D1 allows 100 columns a table: day_decks has 19 others, so the
// columns run out at ~160 cards (Nov 2026: 125) — then counters need their own table.

// What a tally needs: full tower HP, the rating bands, the top decks counters are
// kept for, the card ids they're counted against, every card's slot and every
// tower troop seen. New cards get a slot (and a column when needed) here.
async function tallyContext(env, st, oldMeta, sample) {
  const towers = { king: Math.max(KING_HP, oldMeta?.towers?.king || 0), princess: { ...PRINCESS_HP } };
  for (const [id, hp] of Object.entries(oldMeta?.towers?.princess || {})) towers.princess[id] = Math.max(towers.princess[id] || 0, hp);
  for (const r of sample?.results || []) for (const [t, k, sp] of [[r.ta, r.ka, r.sa], [r.tb, r.kb, r.sb]]) {
    if (t != null && sp != null) towers.princess[t] = Math.max(towers.princess[t] || 0, sp);
    if (k != null) towers.king = Math.max(towers.king, k);
  }
  // Rating bands: a side's rating at the match against today's #100 and #1000
  // (read off /top inside SQLite: parsing its 140 KB here would eat the CPU limit)
  const bandRow = await env.DB.prepare(`
    SELECT COALESCE(json_extract(v, '$.players[99][4]'), (SELECT json_extract(v, '$.bands.hi') FROM state WHERE k = 'meta')) AS hi,
           COALESCE(json_extract(v, '$.players[999][4]'), (SELECT json_extract(v, '$.bands.lo') FROM state WHERE k = 'meta'),
                    json_extract(v, '$.players[#-1][4]')) AS lo
    FROM state WHERE k = 'top'`).first();
  const bands = { hi: Math.round(+bandRow?.hi) || 3000, lo: Math.round(+bandRow?.lo) || 2500 };
  // Counters are kept for last run's top decks (keys checked to be digits, e/h
  // and commas, so they can go into the SQL) against every card id seen
  const topKeys = (oldMeta?.decks || []).map(d => d[0]).filter(k => /^[0-9eh,]+$/.test(k));
  const cardIds = [...new Set((oldMeta?.cards || []).map(c => parseInt(c[0], 10)))].filter(Number.isInteger).sort((a, b) => a - b);
  const slots = JSON.parse(st.card_slots || '[]').filter(Number.isInteger);
  const fresh = cardIds.filter(id => !slots.includes(id));
  slots.push(...fresh);
  const had = +st.card_cols || 0, cols = Math.ceil(slots.length / 2);
  for (let k = had; k < cols; k++)
    await env.DB.prepare(`ALTER TABLE day_decks ADD COLUMN c${k} INTEGER`).run().catch(e => { if (!/duplicate column/i.test(e.message)) throw e; });
  if (fresh.length || cols !== had) await setState(env, { card_slots: JSON.stringify(slots), card_cols: cols });
  // Troop ids and HP go into the SQL as numbers: a json_each lookup per match would count as rows read
  const troopIds = [...new Set([...Object.keys(towers.princess), ...Object.keys(JSON.parse(st.troop_names || '{}'))].map(Number))]
    .filter(Number.isInteger).sort((a, b) => a - b);
  return { towers, bands, topKeys, cardIds, slots, cols, troopIds };
}

// The columns a tally row has (day_decks holds them per period). bd, z0…y1, cg
// are packed four 15-bit counts to an integer, c0… two cards' [games, wins], so
// stored days can just be summed (no field nears 32,767 for a deck in a week).
const TALLY_BASE = ['deck', 'n', 'w', 'd', 't', 'dealt', 'taken', 'hn', 'leak', 'ln', 'bd', 'z0', 'z1', 'y0', 'y1', 'cg', 'tr'];
const counterCols = c => Array.from({ length: c.cols }, (_, k) => `c${k}`);
const tallyCols = c => TALLY_BASE.concat(counterCols(c)).join(', ');
const unpack = (col, i) => `((${col} >> ${i * BITS}) & ${MASK})`;
// [games per gap bucket ×8, wins per gap bucket ×8] off the packed columns (p: a table prefix)
const gapVals = (p = '', fn = x => x) => ['z', 'y'].flatMap(c => [0, 1].flatMap(j => [0, 1, 2, 3].map(i => fn(unpack(`${p}${c}${j}`, i)))));
// More than 100 arguments go in nested concat() calls (a function takes ≤ 127)
const concatAll = parts => parts.length <= 100 ? `concat(${parts.join(', ')})` : `concat(${concatAll(parts.slice(0, 100))}, ${concatAll(parts.slice(100))})`;

// SQL for a tally over the matches in `ranges` ([[lo, hi, condition?]] SQL
// expressions in unix seconds); `tk` is the parameter holding the top deck keys as JSON.
//   s:   one row per deck played (a side of a match)
//   g:   the grouping of s by deck, used as `lg`
//   row: the tally rows (tallyCols) off lg
function tallySQL(c, ranges, tk) {
  const { towers, bands, topKeys, slots, cols, troopIds } = c;
  const hp = troopIds.filter(id => towers.princess[id]);
  const fullP = col => hp.length ? `CASE ${col} ${hp.map(id => `WHEN ${id} THEN ${Math.round(towers.princess[id])}`).join(' ')} ELSE NULL END` : 'NULL';
  // Damage a side's towers took: king + both princess towers, full minus what's left
  const dmg = (t, k, sp) => `CASE WHEN ${k} IS NULL THEN NULL ELSE MAX(0, ${Math.round(towers.king)} - ${k} + ${fullP(t)} - ${sp}) END`;
  // Rating gap (own rating − opponent's, both before the match) → bucket 0…GAPS-1
  const gap = (a, b) => `CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL ELSE MIN(${GAPS - 1}, MAX(0, (${a} - ${b} + ${GAP_STEP * GAPS / 2} + ${GAP_STEP * 100}) / ${GAP_STEP} - 100)) END`;
  // Counters: for a top deck, the opponent's deck (cx) is searched with instr()
  // per card — no json_each, so it reads no extra rows
  const counters = topKeys.length > 0;
  const side = (A, B, lo, hi, cond) => `
      SELECT d${A} AS deck, c${A} > c${B} AS w, ca = cb AS d, c${A} > c${B} AND c${A} = 3 AS t, t${A} AS tt,
             ${dmg(`t${B}`, `k${B}`, `s${B}`)} AS dealt, ${dmg(`t${A}`, `k${A}`, `s${A}`)} AS taken, l${A} AS leak, r${A} AS rt,
             ${counters ? `CASE WHEN d${A} IN (SELECT k FROM tk) THEN ',' || d${B} END` : 'NULL'} AS cx,
             ${gap(`r${A}`, `r${B}`)} AS gb, c${A} - c${B} AS mg, c${B} AS oc
        FROM matches WHERE time >= ${lo} AND time < ${hi}${cond ? ` AND ${cond}` : ''}`;
  const s = ranges.flatMap(([lo, hi, cond]) => [side('a', 'b', lo, hi, cond), side('b', 'a', lo, hi, cond)]).join('\n      UNION ALL');
  const hit = id => `(instr(cx, ',${id}') > 0)`;
  const counterSum = k => {
    const ids = slots.slice(2 * k, 2 * k + 2);
    return counters && ids.length ? `SUM(${ids.map((id, i) => `(${hit(id)} << ${2 * i * BITS}) + ((w * ${hit(id)}) << ${(2 * i + 1) * BITS})`).join(' + ')})` : 'NULL';
  };
  const g = `
      SELECT deck, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d, SUM(t) AS t,
             SUM(dealt) AS dealt, SUM(taken) AS taken, COUNT(dealt) AS hn, SUM(leak) AS leak, COUNT(leak) AS ln,
             /* games and wins at #1–100 rating, then at #101–1000 */
             SUM(CASE WHEN rt >= ${bands.hi} THEN 1 + (w << ${BITS}) WHEN rt >= ${bands.lo} THEN (1 << ${2 * BITS}) + (w << ${3 * BITS}) END) AS bd
             /* games (z) and wins (y) per rating gap bucket, four buckets to a column */
             ${[0, 1].map(j => `, SUM(CASE WHEN gb / 4 = ${j} THEN 1 << ((gb % 4) * ${BITS}) END) AS z${j}, SUM(CASE WHEN gb / 4 = ${j} AND w THEN 1 << ((gb % 4) * ${BITS}) END) AS y${j}`).join('')}
             /* close games: won by one crown (not three), lost by one (not to three), lost to three crowns */
             , SUM(CASE WHEN mg = 1 AND oc < 2 THEN 1 WHEN mg = -1 AND oc < 3 THEN 1 << ${BITS} WHEN mg < 0 AND oc = 3 THEN 1 << ${2 * BITS} ELSE 0 END) AS cg
             /* per tower troop: games, wins, three-crown wins */
             ${troopIds.map(id => `, SUM(CASE WHEN tt = ${id} THEN 1 + (w << ${BITS}) + (t << ${2 * BITS}) END) AS q${id}`).join('')}
             /* per opponent card (by slot, two to a column): games against it and wins */
             ${Array.from({ length: cols }, (_, k) => `, ${counterSum(k)} AS c${k}`).join('')}
      FROM s GROUP BY deck`;
  // Tower troops as [[id, games, wins, three-crown wins]], the ones played only
  const tr = troopIds.length ? `'[' || rtrim(${concatAll(troopIds.map(id =>
    `CASE WHEN ${unpack(`q${id}`, 0)} > 0 THEN '[${id},' || ${unpack(`q${id}`, 0)} || ',' || ${unpack(`q${id}`, 1)} || ',' || ${unpack(`q${id}`, 2)} || '],' ELSE '' END`))}, ',') || ']'` : `'[]'`;
  const row = `SELECT ${TALLY_BASE.slice(0, -1).join(', ')}, ${tr} AS tr${counterCols(c).map(x => `, ${x}`).join('')} FROM lg`;
  // Every deck's troop and gap totals off lg, for the period / the untallied part
  const troopTotals = `json_object(${troopIds.map(id => `'${id}', json_array(SUM(${unpack(`q${id}`, 0)}), SUM(${unpack(`q${id}`, 1)}), SUM(${unpack(`q${id}`, 2)}))`).join(', ')})`;
  const gapTotals = `json_array(${gapVals('', v => `SUM(${v})`).join(', ')})`;
  return { tk: `tk(k) AS (SELECT value FROM json_each(${tk}))`, s, g, row, troopTotals, gapTotals };
}

// The window's top decks, cards, troop and gap totals: stored days summed plus
// the untallied matches (useTallies false: every match in the window, for testing)
async function statsGrouping(env, st, oldMeta, since, until, useTallies = true) {
  // Full tower HP: the highest left standing in a recent sample (a match where a
  // side's towers went untouched), never below what earlier runs saw
  step('tower sample');
  const sample = await env.DB.prepare(`
    SELECT ta, tb, ka, kb, sa, sb FROM matches WHERE time >= ?1 ORDER BY time DESC LIMIT ?2`).bind(since, TOWER_SAMPLE).all();
  const c = await tallyContext(env, st, oldMeta, sample);
  const { cardIds, slots } = c;
  // The window's archived periods with a full tally (x set; those archived before
  // 15 Nov 2026 have deck and card totals only): [tFrom, tTo), contiguous. The
  // matches before and after it are tallied here.
  step('range');
  const [range, per] = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT MIN(time) FROM matches WHERE time >= ?1) AS first, (SELECT MAX(time) FROM matches) AS last`).bind(since),
    env.DB.prepare(`SELECT start, end, x FROM periods WHERE start >= ?1 ORDER BY start`).bind(since),
  ]);
  // Drafts carry on where the archive ends (a period archived since wins)
  const stored = per.results.concat(draftsOf(st).filter(d => d.start >= since && !per.results.some(p => p.start === d.start)))
    .sort((x, y) => x.start - y.start);
  const tallied = [];
  for (const p of useTallies ? stored : []) {
    if (!p.x) { if (tallied.length) break; continue; }
    if (tallied.length && p.start !== tallied[tallied.length - 1].end) break;
    tallied.push(p);
  }
  const tFrom = tallied[0]?.start ?? since, tTo = tallied[tallied.length - 1]?.end ?? since;
  // Live: before and after the stored run, and each draft's matches saved after
  // its cut — read with the matches after the run, as one index range from the
  // first draft on (D1 allows 5 terms in a UNION)
  const live = [['?1', '?5'], lateRange(tallied, '?6', '?2')];
  const q = tallySQL(c, live, '?4');
  // A top deck's games (i 0) or wins (i 1) against each card, in cardIds order, CHUNK to an array
  const cardArray = i => {
    const vals = cardIds.map(id => { const sl = slots.indexOf(id); return unpack(`COALESCE(tp.c${sl >> 1}, 0)`, 2 * (sl & 1) + i); }), parts = [];
    for (let k = 0; k < vals.length; k += CHUNK) parts.push(`json_array(${vals.slice(k, k + CHUNK).join(', ')})`);
    return `CASE WHEN tp.c0 IS NULL THEN NULL ELSE json_array(${parts.join(', ')}) END`;
  };
  const bandsOf = col => `json_array(${[0, 1, 2, 3].map(i => unpack(col, i)).join(', ')})`;
  // Per deck: [games per gap bucket ×8, wins per gap bucket ×8, close wins, close losses, three-crowned losses]
  const extraOf = p => `json_array(${gapVals(p).join(', ')}, ${[0, 1, 2].map(i => unpack(`${p}cg`, i)).join(', ')})`;
  const nulls = n => Array(n).fill('NULL').join(', ');
  const sums = ['n', 'w', 'd', 't', 'dealt', 'taken', 'hn', 'leak', 'ln', 'bd', 'z0', 'z1', 'y0', 'y1', 'cg', ...counterCols(c)];
  // Players per top deck: player_days (every player, from 15 Nov 2026) and the untallied matches' sides
  const liveSides = live.flatMap(([lo, hi, cond]) => ['a', 'b'].map(A =>
    `SELECT d${A}, p${A} FROM matches WHERE time >= ${lo} AND time < ${hi}${cond ? ` AND ${cond}` : ''} AND d${A} IN (SELECT deck FROM tp)`)).join(' UNION ALL ');
  // Top decks and every card in one statement. u: the stored days plus the
  // untallied matches' tally, in the same columns; g sums them per deck.
  step('grouping');
  const both = await env.DB.prepare(`
    WITH ${q.tk},
    s AS (${q.s}),
    lg AS MATERIALIZED (${q.g}),
    u AS MATERIALIZED (
      SELECT ${tallyCols(c)} FROM day_decks WHERE start >= ?5 AND start < ?6
      UNION ALL ${q.row}),
    g AS MATERIALIZED (SELECT deck, ${sums.map(x => `SUM(${x}) AS ${x}`).join(', ')} FROM u GROUP BY deck),
    tp AS MATERIALIZED (SELECT * FROM g ORDER BY n DESC LIMIT ?3),
    trs AS MATERIALIZED (
      SELECT deck, json_group_array(json_array(troop, n, w, t)) AS tr FROM (
        /* not "id": json_each has an id column of its own, which GROUP BY would take */
        SELECT u.deck, j.value ->> 0 AS troop, SUM(j.value ->> 1) AS n, SUM(j.value ->> 2) AS w, SUM(j.value ->> 3) AS t
        FROM u, json_each(u.tr) AS j WHERE u.deck IN (SELECT deck FROM tp) AND j.value ->> 0 IS NOT NULL GROUP BY u.deck, troop ORDER BY troop)
      GROUP BY deck),
    pl AS MATERIALIZED (
      SELECT deck, COUNT(DISTINCT tag) AS p FROM (
        SELECT deck, tag FROM player_days WHERE start >= ?5 AND start < ?6 AND deck IN (SELECT deck FROM tp)
        UNION ALL ${liveSides})
      GROUP BY deck)
    SELECT * FROM (
      SELECT 'd' AS kind, tp.deck AS k, tp.n, tp.w, tp.d, tp.t, pl.p, tp.dealt, tp.taken, tp.hn, tp.leak, tp.ln, trs.tr,
             ${bandsOf('tp.bd')} AS bd, ${cardIds.length ? `${cardArray(0)} AS cn, ${cardArray(1)} AS cw` : 'NULL AS cn, NULL AS cw'}, ${extraOf('tp.')} AS ex
      FROM tp LEFT JOIN trs ON trs.deck = tp.deck LEFT JOIN pl ON pl.deck = tp.deck
      ORDER BY tp.n DESC)
    UNION ALL
    SELECT 'c', card, SUM(n), SUM(w), SUM(d), SUM(t), ${nulls(7)}, json_array(SUM(b1n), SUM(b1w), SUM(b2n), SUM(b2w)), NULL, NULL, NULL FROM (
      SELECT card, n, w, d, t, b1n, b1w, b2n, b2w FROM card_days WHERE start >= ?5 AND start < ?6 AND card != '_'
      UNION ALL
      SELECT j.value, lg.n, lg.w, lg.d, lg.t, ${[0, 1, 2, 3].map(i => unpack('lg.bd', i)).join(', ')}
      FROM lg, json_each('["' || replace(lg.deck, ',', '","') || '"]') AS j)
    GROUP BY card
    UNION ALL SELECT 'x', ${q.troopTotals}, ${nulls(15)} FROM lg
    UNION ALL SELECT 'z', ${q.gapTotals}, ${nulls(15)} FROM lg`)
    .bind(since, until, TOP_DECKS, JSON.stringify(c.topKeys), tFrom, tTo).all();
  return { c, sample, range, per, both, tallied };
}

async function computeStats(env, now) {
  step('state');
  const st = await getState(env);
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000), until = Math.floor(now / 1000) + 60;
  const oldMeta = JSON.parse((await env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`).first())?.v || 'null');
  const { c, sample, range, per, both, tallied } = await statsGrouping(env, st, oldMeta, since, until);
  const { towers, cardIds } = c;
  const results = [range, per, both];
  const counters = c.topKeys.length > 0 && cardIds.length > 0, bands = c.bands;
  // Trend lines: each run's card tally (a 7-day window) is that day's point — the
  // day's last run replaces earlier ones. Nothing extra is scanned for it. With
  // no history yet, the previous run's stats seed a first point.
  await pause();
  step('stored state');
  const stored = await env.DB.batch([
    env.DB.prepare(`SELECT v FROM state WHERE k = 'history'`),
    env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`),
    env.DB.prepare(`SELECT v FROM state WHERE k = 'deck_days'`),
  ]);
  const hist = JSON.parse(stored[0].results[0]?.v || '{"days":[]}');
  if (!hist.days.length) {
    const old = JSON.parse(stored[1].results[0]?.v || 'null');
    if (old?.cards && dayKey(old.updated) !== dayKey(now)) hist.days.push([old.updated, old.matches, Object.fromEntries(old.cards.map(c => [c[0], c[1]]))]);
  }
  // The week before, for trends: the /history point taken about a week ago is
  // that week's 7-day card tally, so it costs no scan (a grouping over it read
  // ~700k rows — half a stats run — until Nov 2026). Points before 28 Oct 2026 have no wins.
  const weekBefore = hist.days.filter(d => d[3] && Math.abs(d[0] - (now - WINDOW_DAYS * DAY)) < 1.5 * DAY)
    .sort((a, b) => Math.abs(a[0] - (now - WINDOW_DAYS * DAY)) - Math.abs(b[0] - (now - WINDOW_DAYS * DAY)))[0];
  const decks = both.results.filter(r => r.kind === 'd');
  const cards = both.results.filter(r => r.kind === 'c').sort((a, b) => b.n - a.n);
  const t = range.results[0] || {};
  const count = rows => Math.round(rows.reduce((sum, r) => sum + r.n, 0) / 16);
  // Matches per hour: polling tallies the matches it saves from `activity.from`
  // on; the ones saved before that are counted once, here
  const act = JSON.parse(st.activity || '{"days":{}}');
  let seed = null;
  if (act.from && !act.seeded) {
    seed = await env.DB.prepare(`SELECT time / 3600 AS h, COUNT(*) AS n FROM matches WHERE time >= ?1 AND time < ?2 GROUP BY h`)
      .bind(Math.floor((now - ACTIVITY_DAYS * DAY) / 1000), act.from).all();
    for (const r of seed.results) {
      const ms = r.h * HOUR;
      (act.days[dayKey(ms)] ||= Array(24).fill(0))[new Date(ms).getUTCHours()] += r.n;
    }
    act.seeded = true;
  }
  const reads = rowsRead(results) + rowsRead(stored) + rowsRead([sample]) + (seed ? rowsRead([seed]) : 0) + 2;
  const names = JSON.parse(st.troop_names || '{}');
  // Troop and gap totals: the untallied matches' (rows x, z) plus each stored period's (periods.x)
  const archived = tallied.map(p => JSON.parse(p.x));
  const troopTot = {};
  for (const [id, v] of Object.entries(JSON.parse(both.results.find(r => r.kind === 'x')?.k || '{}'))) if (v?.[0]) troopTot[id] = [v[0] || 0, v[1] || 0, v[2] || 0];
  for (const a of archived) for (const [id, n, w, t3] of a.tr || []) { const e = (troopTot[id] ||= [0, 0, 0]); e[0] += n || 0; e[1] += w || 0; e[2] += t3 || 0; }
  const avg = (sum, n) => n ? Math.round(sum / n * 10) / 10 : null;
  const bandsOfRow = r => (JSON.parse(r.bd || 'null') || []).concat([0, 0, 0, 0]).slice(0, 4).map(v => v || 0);
  const troopsOfRow = r => JSON.parse(r.tr || '[]').map(x => [+x[0], x[1] || 0, x[2] || 0, x[3] || 0]).filter(x => x[1] > 0);
  // Skill adjustment: the win rate at each rating gap, from every deck played
  const zr = JSON.parse(both.results.find(r => r.kind === 'z')?.k || '[]');
  for (const a of archived) (a.z || []).forEach((v, i) => { zr[i] = (zr[i] || 0) + (v || 0); });
  const gapRates = Array.from({ length: GAPS }, (_, i) => [zr[i] || 0, zr[GAPS + i] || 0]);
  const exOf = r => JSON.parse(r.ex || '[]');
  // A deck's expected wins: its games at each gap × the win rate there
  const expected = ex => {
    let e = 0, n = 0;
    for (let i = 0; i < GAPS; i++) if (ex[i] && gapRates[i][0]) { e += ex[i] * gapRates[i][1] / gapRates[i][0]; n += ex[i]; }
    return [Math.round(e * 10) / 10, n];
  };
  // Top decks per day, for rising / new decks: the 7-day tally a week ago is
  // the snapshot taken then. Seeded from the previous run's stats.
  const deckDays = JSON.parse(stored[2].results[0]?.v || '{"days":[]}');
  if (!deckDays.days.length && oldMeta?.decks && dayKey(oldMeta.updated) !== dayKey(now))
    deckDays.days.push([oldMeta.updated, oldMeta.matches, oldMeta.decks.map(d => [d[0], d[1], d[2]])]);
  deckDays.days = deckDays.days.filter(d => dayKey(d[0]) !== dayKey(now) && d[0] > now - DECK_DAYS * DAY)
    .concat([[now, count(cards), decks.map(r => [r.k, r.n, r.w])]]);
  // The snapshot closest to a week before (else the oldest there is)
  const weekAgo = deckDays.days.filter(d => d[0] <= now - 6.5 * DAY).pop() || deckDays.days[0];
  const meta = {
    updated: now,
    next: now + refreshEvery(reads, STATS_SHARE),  // when these stats are recomputed
    window_days: WINDOW_DAYS,
    started: +st.started_at || null,  // when collection began; older matches came from the first logs
    // Players on the leaderboard; while a new season's board is short, `held` is when
    // the last full one was read — last season's top 1,000 are still followed
    board: { size: +st.board_size || 0, held: +st.board_size < MIN_BOARD && +st.full_board_at || null },
    matches: count(cards),
    first: t.first ? t.first * 1000 : null,
    last: t.last ? t.last * 1000 : null,
    // [deck key, games, wins, draws, different players, three-crown wins,
    //  avg tower damage dealt, avg taken, avg elixir leaked, games with tower data,
    //  [[tower troop id, games, wins, three-crown wins]], rating bands]
    //  [expected wins from the rating gaps, games with both ratings known],
    //  [close wins, close losses, three-crowned losses]]
    decks: decks.map(r => { const ex = exOf(r); return [r.k, r.n, r.w, r.d, r.p, r.t, avg(r.dealt, r.hn), avg(r.taken, r.hn), avg(r.leak, r.ln), r.hn || 0,
                           troopsOfRow(r), bandsOfRow(r), expected(ex), ex.slice(2 * GAPS, 2 * GAPS + 3).map(v => v || 0)]; }),
    // Win rate by rating gap (own − opponent's): [[games, wins]] per GAP_STEP bucket, from the lowest
    gaps: { step: GAP_STEP, rates: gapRates },
    // Top decks of the snapshot about a week before: { at, matches, decks: [[key, games, wins]] }
    prev_decks: weekAgo && weekAgo[0] < now - DAY ? { at: weekAgo[0], matches: weekAgo[1], decks: weekAgo[2] } : null,
    // Rating bands: [games, wins] at #1–100 rating (≥ hi), then #101–1000 (≥ lo);
    // the rest of a deck's or card's games were below lo
    bands,
    // [tower troop id, name, art, games, wins, three-crown wins], most played first
    troops: Object.entries(troopTot).map(([id, v]) => [+id, names[id]?.[0] || null, names[id]?.[1] || null, ...v])
      .filter(r => r[3] > 0).sort((a, b) => b[3] - a[3]),
    // Full tower HP the damage figures are measured against
    towers,
    // [card id + form, decks it was in, wins, draws, three-crown wins, rating bands]
    cards: cards.map(r => [r.k, r.n, r.w, r.d, r.t, bandsOfRow(r)]),
    // Matches per UTC hour: [[YYYY-MM-DD, [24 counts]]], the last 4 weeks
    activity: Object.entries(act.days).filter(([k]) => Date.parse(k) >= now - 29 * DAY).sort(),
    // The week before, for trends: { matches, cards: [card, decks, wins] }; null until collected
    prev: weekBefore ? { at: weekBefore[0], matches: weekBefore[1],
      cards: Object.entries(weekBefore[2]).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n, weekBefore[3][k] || 0]) } : null,
  };
  // [time, matches, { card id + form: decks it was in }, { card id + form: wins }]
  // (days before 28 Oct 2026 have no wins)
  hist.days = hist.days.filter(d => dayKey(d[0]) !== dayKey(now) && d[0] > now - HISTORY_DAYS * DAY)
    .concat([[now, meta.matches, Object.fromEntries(cards.map(r => [r.k, r.n])), Object.fromEntries(cards.map(r => [r.k, r.w]))]]);
  hist.updated = now;
  // { cards: [card id], decks: [[deck key, [[games against each card]], [[wins]]]] },
  // the inner arrays CHUNK cards each. Spliced from SQLite's JSON text, not parsed:
  // ~200 KB, and the CPU limit is 10 ms.
  const counterJSON = counters ? `{"updated":${now},"cards":${JSON.stringify(cardIds)},"decks":[${
    decks.filter(r => r.cn).map(r => `[${JSON.stringify(r.k)},${r.cn},${r.cw}]`).join(',')}]}` : null;
  step('save');
  await countReads(env, 'stats', now, reads, { stats_at: now, meta: JSON.stringify(meta), history: JSON.stringify(hist), deck_days: JSON.stringify(deckDays),
    ...(counterJSON ? { counters: counterJSON } : {}), ...(seed ? { activity: JSON.stringify(act) } : {}) }, 10);
  step('');
}

// The current top 1,000 with each player's most played ranked deck over the
// window and their overall record in it (players with no ranked match collected
// in the window get no deck)
async function computeTop(env, now) {
  const st = await getState(env);
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000), onBoard = (+st.board_at || 0) - HOUR;
  // Rivalries are recounted every other day (RIVALS_EVERY) — their pass is ~230k
  // rows (Nov 2026) — and kept in their own small state row in between
  const fresh = now - (+st.rivals_at || 0) > RIVALS_EVERY;
  // Stored days come from player_days (archived and drafts, from the first one in the window);
  // the rest of the window — its start, today, and the drafts' late matches — from the matches
  // The first stored day in the window: the matches before it are read live (the
  // window rarely starts at midnight; taking the table's first day left that part
  // of the window out until 19 Nov 2026)
  const first = await env.DB.prepare(`SELECT MIN(start) AS s FROM player_days WHERE start >= ?1`).bind(since).first();   // one row, by the key
  // Drafts (contiguous from archive_to) have player_days too; their matches saved after the cut are read live
  const drafts = [];
  for (const d of draftsOf(st)) if (d.start === (drafts.length ? drafts[drafts.length - 1].end : Math.floor((+st.archive_to || 0) / 1000))) drafts.push(d);
  const archTo = Math.floor((+st.archive_to || 0) / 1000);
  const pdTo = drafts.length ? drafts[drafts.length - 1].end : archTo, pdFrom = Math.min(first?.s ?? archTo, archTo);
  const [lo, , cond] = lateRange(drafts, '?6', '');
  const after = `time >= max(?1, ${lo})${cond ? ` AND ${cond}` : ''}`;
  const [res, pairs, kept] = await env.DB.batch([env.DB.prepare(`
    WITH s AS (
      SELECT tag, deck, n, w FROM player_days WHERE start >= max(?1, ?5) AND start < ?6
      UNION ALL
      /* two ranges, each its own index range (an OR would scan the whole week) */
      SELECT pa, da, 1, ca > cb FROM matches WHERE time >= ?1 AND time < ?5
      UNION ALL SELECT pb, db, 1, cb > ca FROM matches WHERE time >= ?1 AND time < ?5
      UNION ALL SELECT pa, da, 1, ca > cb FROM matches WHERE ${after}
      UNION ALL SELECT pb, db, 1, cb > ca FROM matches WHERE ${after}),
    g AS (SELECT s.tag, s.deck, SUM(s.n) AS n, SUM(s.w) AS w FROM s JOIN players p ON p.tag = s.tag AND p.seen_at >= ?2
          GROUP BY s.tag, s.deck),
    /* the player's totals come from the same grouping, so the matches are read once */
    r AS (SELECT tag, deck, n, w, ROW_NUMBER() OVER (PARTITION BY tag ORDER BY n DESC) AS rk,
                 SUM(n) OVER (PARTITION BY tag) AS games, SUM(w) OVER (PARTITION BY tag) AS wins FROM g)
    SELECT p.tag, p.name, p.clan, p.rank, p.rating, r.deck, r.n, r.games, r.wins, r.w, d1.rating AS r1, d7.rating AS r7
    FROM players p LEFT JOIN r ON r.tag = p.tag AND r.rk = 1
      LEFT JOIN ratings d1 ON d1.day = ?3 AND d1.tag = p.tag
      LEFT JOIN ratings d7 ON d7.day = ?4 AND d7.tag = p.tag
    WHERE p.seen_at >= ?2 ORDER BY p.rank`).bind(since, onBoard, dayKey(now - DAY), dayKey(now - 7 * DAY), pdFrom, pdTo),
    // Rivalries: the pairs who met most (tags are stored sorted, so a pair is one
    // group). One more pass over the window, ~140k rows a run (Oct 2026); only
    // pairs where both are on the board are kept, checked against the list above
    fresh ? env.DB.prepare(`SELECT pa, pb, COUNT(*) AS n, SUM(ca > cb) AS w, SUM(ca = cb) AS d FROM matches WHERE time >= ?1
      GROUP BY pa, pb HAVING n >= 3 ORDER BY n DESC LIMIT 400`).bind(since) : env.DB.prepare(`SELECT 1 WHERE 0`),
    env.DB.prepare(`SELECT v FROM state WHERE k = 'rivals'`)]);
  const reads = rowsRead([res, pairs, kept]);
  const board = new Set(res.results.map(r => r.tag));
  const rivals = fresh ? pairs.results.filter(r => board.has(r.pa) && board.has(r.pb)).slice(0, 50).map(r => [r.pa, r.pb, r.n, r.w, r.d])
    : JSON.parse(kept.results[0]?.v || '[]').filter(r => board.has(r[0]) && board.has(r[1]));
  // A run's estimate (top_reads) always includes the rivalries pass, so the budget guard plans for the heavier run
  const estimate = rowsRead([res]) + (fresh ? rowsRead([pairs]) : +st.rivals_reads || 0);
  const top = {
    updated: now,
    next: now + refreshEvery(estimate, TOP_SHARE),
    window_days: WINDOW_DAYS,
    // Ratings in the leaderboard snapshots of these days (first refresh after 00:00 UTC)
    rating_days: [dayKey(now - DAY), dayKey(now - 7 * DAY)],
    // [tag, name, clan, rank, rating, main deck key, games with it, ranked games, wins, wins with the main deck,
    //  rating a day ago, a week ago (null: not on the board then)]
    players: res.results.map(r => [r.tag, r.name, r.clan, r.rank, r.rating, r.deck, r.n || 0, r.games || 0, r.wins || 0, r.w || 0, r.r1 ?? null, r.r7 ?? null]),
    // [tag a, tag b, ranked games against each other, a's wins, draws], both on the board, most games first
    rivals,
    rivals_at: fresh ? now : +st.rivals_at,
  };
  await countReads(env, 'top', now, reads, { top_at: now, top: JSON.stringify(top),
    ...(fresh ? { rivals: JSON.stringify(rivals), rivals_at: now, rivals_reads: rowsRead([pairs]) } : {}) }, 8);
  await setState(env, { top_reads: estimate });
}

// ── Archive: one finished period (a UTC day, split at a season start) tallied
// for good — every deck played, every card, the season totals — so past seasons
// and card trends since collection began stay viewable after the 90-day match
// pruning. ~115k rows read and ~7k written a period (Nov 2026: ~3,100 distinct
// decks a day). Everything after the deck tally is one batch (a transaction),
// with archive_to moved in it, so a failure never adds a period to a season twice.
async function archivePeriod(env, now, st) {
  const startMs = +st.archive_to, endMs = periodEnd(startMs);
  const a = startMs / 1000, b = endMs / 1000, season = seasonStartOf(startMs) / 1000;
  // The full tally per deck (tower damage, rating bands and gaps, close games,
  // troops, counters for the top decks), so the stats can sum stored days
  step('archive decks');
  const dayRes = await archiveDecks(env, st, a, b);
  step('archive totals');
  const tot = await periodTotals(env, a);
  const batch = await env.DB.batch([
    cardDays(env, a, tot),
    env.DB.prepare(`
      INSERT INTO season_decks (season, deck, n, w, d, t) SELECT ?2, deck, n, w, d, t FROM day_decks WHERE start = ?1
      ON CONFLICT (season, deck) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, d = d + excluded.d, t = t + excluded.t`).bind(a, season),
    env.DB.prepare(`
      INSERT INTO season_cards (season, card, n, w, d, t) SELECT ?2, card, n, w, d, t FROM card_days WHERE start = ?1 AND card != '_'
      ON CONFLICT (season, card) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, d = d + excluded.d, t = t + excluded.t`).bind(a, season),
    env.DB.prepare(`
      INSERT INTO season_troops (season, troop, n, w, t)
      SELECT ?2, value ->> 0, value ->> 1, value ->> 2, value ->> 3 FROM json_each(?1) WHERE true
      ON CONFLICT (season, troop) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, t = t + excluded.t`).bind(JSON.stringify(tot.x.tr), season),
    // x: the period's rating gap and tower troop totals over every deck; set
    // means the period's day_decks hold the full tally the stats can sum
    env.DB.prepare(`INSERT OR REPLACE INTO periods (start, end, season, matches, x) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(a, b, season, tot.matches, JSON.stringify(tot.x)),
    playerDays(env, a, b),
    env.DB.prepare(`INSERT INTO state (k, v) VALUES ('archive_to', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(endMs)),
  ]);
  let reads = rowsRead([dayRes, ...tot.res]) + rowsRead(batch);
  const writes = rowsWritten([dayRes, ...batch]) + 5;  // + the season's JSON and state rows
  // The season's stats are rebuilt when the archive is caught up, or at a season's last period during a backlog
  // (and at least every 6 h, so a long backlog still shows its progress)
  const caughtUp = periodEnd(endMs) > now - ARCHIVE_LAG, seasonDone = endMs >= nextSeasonStart(startMs);
  const build = caughtUp || seasonDone || now - (+st.season_built_at || 0) > 6 * HOUR;
  if (build) { step('archive season'); reads += await buildSeason(env, now, season); }
  // The period's draft is replaced now
  const drafts = draftsOf(await getState(env)).filter(d => d.start >= b);
  await countReads(env, 'archive', now, reads, { archive_at: now, ...(build ? { season_built_at: now } : {}), drafts: JSON.stringify(drafts.map(draftRow)) }, writes);
  step('');
}

// ── Drafts: a finished day tallied DRAFT_LAG after it ends, from the matches
// saved before `cut` (ms) — day_decks, card_days and player_days rows like the
// archive's, which the final archive replaces (a superset: matches are only
// added). No season totals or periods row. state.drafts: [[start, end, cut, x]]
// (unix seconds, cut in ms as matches.seen), draft_to: where the next one starts.
const draftRow = d => [d.start, d.end, d.cut, typeof d.x === 'string' ? JSON.parse(d.x) : d.x];
function draftsOf(st) {
  const arch = Math.floor((+st.archive_to || 0) / 1000);
  return JSON.parse(st.drafts || '[]').filter(d => Array.isArray(d) && d.slice(0, 3).every(Number.isInteger) && d[0] >= arch)
    .map(([start, end, cut, x]) => ({ start, end, cut, x: typeof x === 'string' ? x : JSON.stringify(x) })).sort((p, q) => p.start - q.start);
}
// The matches after a stored run (from `to` on) plus the drafts' matches saved after
// their cut, as one range [lo, hi, condition] starting at the first draft
function lateRange(stored, to, hi) {
  const late = stored.filter(p => p.cut);
  if (!late.length) return [to, hi];
  return [late[0].start, hi, `(time >= ${to} OR ${late.map(p => `(time >= ${p.start} AND time < ${p.end} AND seen >= ${p.cut})`).join(' OR ')})`];
}
const draftStart = st => Math.max(+st.archive_to || 0, +st.draft_to || 0);
async function draftPeriod(env, now, st) {
  const startMs = draftStart(st), endMs = periodEnd(startMs);
  const a = startMs / 1000, b = endMs / 1000, cut = now - 2 * MINUTE;
  // Saved before the cut (a poll still running at `now` started a minute or more before it)
  const cond = `(seen IS NULL OR seen < ${cut})`;
  step('draft decks');
  const dayRes = await archiveDecks(env, st, a, b, cond);
  step('draft totals');
  const tot = await periodTotals(env, a);
  const batch = await env.DB.batch([cardDays(env, a, tot), playerDays(env, a, b, cond)]);
  const cur = await getState(env);
  const drafts = draftsOf(cur).filter(d => d.start !== a).concat([{ start: a, end: b, cut, x: tot.x }]).sort((p, q) => p.start - q.start);
  await countReads(env, 'draft', now, rowsRead([dayRes, ...tot.res, ...batch]) + 2,
    { draft_at: now, draft_to: endMs, drafts: JSON.stringify(drafts.map(draftRow)) }, rowsWritten([dayRes, ...batch]) + 3);
  step('');
}

// A period's day_decks rows: the full tally per deck (tower damage, rating bands
// and gaps, close games, troops, counters for the top decks), so the stats can sum
// stored days. `cond`: a draft's limit on which matches count.
async function archiveDecks(env, st, a, b, cond) {
  const meta = await env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`).first();
  const c = await tallyContext(env, st, JSON.parse(meta?.v || 'null'), null);
  const q = tallySQL(c, [['?1', '?2', cond]], '?3');
  return env.DB.prepare(`
    WITH ${q.tk}, s AS (${q.s}), lg AS (${q.g})
    INSERT OR REPLACE INTO day_decks (start, ${tallyCols(c)}) SELECT ?1, ${tallyCols(c)} FROM (${q.row})`).bind(a, b, JSON.stringify(c.topKeys)).run();
}

// A period's card totals (with rating bands), tower troop and rating gap totals,
// added up here from its day_decks rows: splitting every deck with json_each in
// SQL read ~48k rows a period (Nov 2026), reading the rows ~4k
async function periodTotals(env, a) {
  const res = await env.DB.batch([
    env.DB.prepare(`SELECT deck, n, w, d, t, ${[0, 1, 2, 3].map(i => `${unpack('bd', i)} AS b${i}`).join(', ')}, tr FROM day_decks WHERE start = ?1`).bind(a),
    env.DB.prepare(`SELECT json_array(${gapVals('', v => `COALESCE(SUM(${v}), 0)`).join(', ')}) AS z FROM day_decks WHERE start = ?1`).bind(a),
  ]);
  const cards = {}, troops = {};
  let sides = 0;
  for (const r of res[0].results) {
    sides += r.n;
    for (const id of r.deck.split(',')) {
      const e = (cards[id] ||= [0, 0, 0, 0, 0, 0, 0, 0]);
      [r.n, r.w, r.d, r.t, r.b0, r.b1, r.b2, r.b3].forEach((v, i) => { e[i] += v || 0; });
    }
    for (const [id, n, w, t3] of JSON.parse(r.tr || '[]')) {
      if (id == null) continue;
      const e = (troops[id] ||= [0, 0, 0]);
      e[0] += n || 0; e[1] += w || 0; e[2] += t3 || 0;
    }
  }
  const tr = Object.entries(troops).map(([id, v]) => [+id, ...v]).sort((p, q) => p[0] - q[0]);
  return { res, cards, matches: Math.floor(sides / 2), x: { z: JSON.parse(res[1].results[0]?.z || '[]'), tr } };
}
// card_days rows from those totals (card '_' is the period's match count)
const cardDays = (env, a, tot) => env.DB.prepare(`
  INSERT OR REPLACE INTO card_days (start, card, n, w, d, t, b1n, b1w, b2n, b2w)
  SELECT ?1, value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4, value ->> 5, value ->> 6, value ->> 7, value ->> 8 FROM json_each(?2)`)
  .bind(a, JSON.stringify(Object.entries(tot.cards).map(([id, v]) => [id, ...v]).concat([['_', tot.matches, 0, 0, 0, null, null, null, null]])));
// Per player and deck: /top sums a week of these instead of re-reading the week's
// matches, the stats count each deck's players from them
const playerDays = (env, a, b, cond) => env.DB.prepare(`
  INSERT OR REPLACE INTO player_days (start, tag, deck, n, w)
  SELECT ?1, tag, deck, COUNT(*), SUM(w) FROM (
    SELECT pa AS tag, da AS deck, ca > cb AS w FROM matches WHERE time >= ?1 AND time < ?2${cond ? ` AND ${cond}` : ''}
    UNION ALL SELECT pb, db, cb > ca FROM matches WHERE time >= ?1 AND time < ?2${cond ? ` AND ${cond}` : ''})
  GROUP BY tag, deck`).bind(a, b);

// One season's stats for /season, and the list of seasons for /seasons
async function buildSeason(env, now, season) {
  const prevSeason = seasonStartOf(season * 1000 - DAY) / 1000;
  const [decks, cards, troops, span, prevCards, list] = await env.DB.batch([
    env.DB.prepare(`SELECT deck, n, w, d, t FROM season_decks WHERE season = ?1 ORDER BY n DESC LIMIT ?2`).bind(season, SEASON_DECKS),
    env.DB.prepare(`SELECT card, n, w, d, t FROM season_cards WHERE season = ?1 ORDER BY n DESC`).bind(season),
    env.DB.prepare(`SELECT troop, n, w, t FROM season_troops WHERE season = ?1 ORDER BY n DESC`).bind(season),
    env.DB.prepare(`SELECT MIN(start) AS a, MAX(end) AS b, SUM(matches) AS m FROM periods WHERE season = ?1`).bind(season),
    env.DB.prepare(`SELECT card, n, w FROM season_cards WHERE season = ?1 ORDER BY n DESC`).bind(prevSeason),
    env.DB.prepare(`SELECT season, MIN(start) AS a, MAX(end) AS b, SUM(matches) AS m FROM periods GROUP BY season ORDER BY season`),
  ]);
  const st = await getState(env), names = JSON.parse(st.troop_names || '{}');
  const sp = span.results[0] || {};
  const seasons = list.results.map(r => ({ start: r.season * 1000, end: nextSeasonStart(r.season * 1000), from: r.a * 1000, to: r.b * 1000, matches: r.m }));
  const prev = seasons.find(x => x.start === prevSeason * 1000);
  const out = {
    start: season * 1000, end: nextSeasonStart(season * 1000), from: sp.a * 1000, to: sp.b * 1000, matches: sp.m || 0, updated: now,
    // the same rows as /meta's: [key, games, wins, draws, players (not kept per season), three-crown wins]
    decks: decks.results.map(r => [r.deck, r.n, r.w, r.d, null, r.t]),
    cards: cards.results.map(r => [r.card, r.n, r.w, r.d, r.t]),
    troops: troops.results.map(r => [r.troop, ...(names[r.troop] || ['', '']), r.n, r.w, r.t]),
    // The season before, for each card's change in use
    prev: prev && prevCards.results.length ? { start: prev.start, matches: prev.matches, cards: prevCards.results.map(r => [r.card, r.n, r.w]) } : null,
  };
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO seasons (start, v) VALUES (?1, ?2)`).bind(season, JSON.stringify(out)),
    env.DB.prepare(`INSERT INTO state (k, v) VALUES ('season_list', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify({ updated: now, seasons })),
  ]);
  return rowsRead([decks, cards, troops, span, prevCards, list]);
}

async function prune(env, now, st) {
  const cutoff = Math.floor((now - KEEP_DAYS * DAY) / 1000);
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM matches WHERE time < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM player_days WHERE start < ?1`).bind(Math.floor((now - PLAYER_DAYS_KEEP * DAY) / 1000)),
    // Off the leaderboard for a week: stop tracking
    // (last season's top 1,000 are kept while the new board is short)
    env.DB.prepare(`DELETE FROM players WHERE seen_at < ?1`).bind(Math.min(now - 7 * DAY, pollFrom(st))),
  ]);
  // Each deleted match is a row written: ~15–25k a day once matches reach KEEP_DAYS
  await setState(env, { prune_at: now, prune_writes: rowsWritten(res), ...usage(st, now, rowsRead(res), rowsWritten(res) + 2) });
}

async function getState(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM state WHERE k NOT IN ('meta', 'top', 'history', 'counters', 'deck_days', 'season_list', 'rivals', 'war_duel_sample', 'war')`).all();
  return Object.fromEntries(results.map(r => [r.k, r.v]));
}
async function setState(env, values) {
  await env.DB.prepare(`
    INSERT INTO state (k, v) SELECT key, value FROM json_each(?1) WHERE true
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(values)).run();
}
