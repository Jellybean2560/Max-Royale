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
//    parameters), matches are stored once (no extra index) and kept 30 days,
//    and the stats are computed every 1–24 hours as their cost allows, not per
//    request. Each run reads the week's matches once per side plus the distinct
//    decks (~200k rows at 25k matches), and the week before again once there is
//    one for trends; the top players' main decks take another pass. Every query's
//    rows_read (polling too) is counted per UTC day, and a heavy job that would
//    push the day past READ_BUDGET minus the polling reserve waits for tomorrow
//    instead of running into D1's limit.
//
// GET /meta    the latest stats (CORS open, for the app)
// GET /top     the top 1,000 with rank, rating, clan and main deck
// GET /status  collection progress, reads used today and the last error

const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const BOARD_EVERY = 6 * HOUR;       // leaderboard refresh
const PRUNE_EVERY = DAY;
const KEEP_DAYS = 30;               // matches older than this are deleted
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
const MIN_REFRESH = HOUR, MAX_REFRESH = 24 * HOUR;
const refreshEvery = (reads, share) => Math.min(MAX_REFRESH, Math.max(MIN_REFRESH, DAY * (reads || 0) / share));
// 2M of D1's free 5M rows read a day (Cloudflare mails warnings from 80%), all
// queries counted; heavy jobs leave POLL_RESERVE for polling (~150k a day),
// the leaderboard, pruning and /status
const READ_BUDGET = 2e6, POLL_RESERVE = 250e3;

export default {
  async scheduled(event, env, ctx) {
    if (env.PAUSED === '1') return;  // wrangler.toml [vars]: collection paused, no D1 access at all
    ctx.waitUntil(tick(env).catch(e => setState(env, { last_error: `${new Date().toISOString()} ${e.message}` })));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/meta' || url.pathname === '/top') {
      const row = await env.DB.prepare(`SELECT v FROM state WHERE k = ?1`).bind(url.pathname.slice(1)).first();
      return new Response(row?.v || JSON.stringify({ empty: true }), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    }
    if (url.pathname === '/status') {
      const st = await getState(env);
      const board = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(polls > 0) AS polled FROM players WHERE seen_at >= ?1`).bind((+st.board_at || 0) - HOUR).first();
      const day = await env.DB.prepare(`SELECT COUNT(*) AS n FROM matches WHERE time >= ?1`).bind(Math.floor((Date.now() - DAY) / 1000)).first();
      return new Response(JSON.stringify({ ...st, players: board?.n || 0, players_polled: board?.polled || 0, matches_last_24h: day?.n || 0 }, null, 2), { headers });
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
    return fn(env, now);
  };
  if (!st.started_at) await setState(env, { started_at: now });
  // A heavy job runs only if what it read last time still fits in today's budget
  const fits = job => readsToday(st, now) + (+st[`${job}_reads`] || 0) <= READ_BUDGET - POLL_RESERVE;
  if (due('board', BOARD_EVERY)) return run('board', refreshBoard);
  if (+st.matches_total > 0 && due('stats', refreshEvery(+st.stats_reads, STATS_SHARE)) && fits('stats')) return run('stats', computeStats);
  if (+st.matches_total > 0 && due('top', refreshEvery(+st.top_reads, TOP_SHARE)) && fits('top')) return run('top', computeTop);
  if (due('prune', PRUNE_EVERY)) return run('prune', prune);
  return pollPlayers(env, now, st);
}

// D1's daily limits reset at midnight UTC
const dayKey = now => new Date(now).toISOString().slice(0, 10);
const readsToday = (st, now) => st.reads_day === dayKey(now) ? +st.reads_count || 0 : 0;
const rowsRead = results => results.reduce((sum, r) => sum + (r?.meta?.rows_read || 0), 0);
// Adds a job's reads to today's count and remembers them as its next estimate
async function countReads(env, job, now, reads, extra) {
  const st = await getState(env);
  await setState(env, { ...extra, reads_day: dayKey(now), reads_count: readsToday(st, now) + reads, [`${job}_reads`]: reads });
}

// The app's proxy Worker forwards the path to the Clash Royale API
async function api(env, path) {
  for (let attempt = 0; ; attempt++) {
    const res = await env.CR.fetch('https://cr' + path.replace(/#/g, '%23'));
    if (res.ok) return res.json();
    if (res.status < 500 || attempt >= 1) throw new Error(`API ${res.status} for ${path}`);
  }
}

async function refreshBoard(env, now) {
  const board = await api(env, '/locations/global/pathoflegend/players?limit=1000');
  const items = (board.items || []).map(p => ({ tag: p.tag, name: p.name, rank: p.rank, rating: p.eloRating, clan: p.clan?.name || null }));
  if (!items.length) throw new Error('empty leaderboard');
  // New players are due at once; existing ones keep their schedule
  await env.DB.prepare(`
    INSERT INTO players (tag, name, rank, rating, clan, seen_at, next_poll)
    SELECT json_extract(value, '$.tag'), json_extract(value, '$.name'), json_extract(value, '$.rank'),
           json_extract(value, '$.rating'), json_extract(value, '$.clan'), ?2, ?2
    FROM json_each(?1) WHERE true
    ON CONFLICT (tag) DO UPDATE SET name = excluded.name, rank = excluded.rank,
      rating = excluded.rating, clan = excluded.clan, seen_at = excluded.seen_at`).bind(JSON.stringify(items), now).run();
  await setState(env, { board_at: now, board_size: items.length });
}

// API timestamps look like 20261012T105805.000Z → unix seconds
const apiTime = ts => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(9, 11), +ts.slice(11, 13), +ts.slice(13, 15)) / 1000;
// Sorted card ids, "e" / "h" for a card played as its evolution / hero form
const deckKey = cards => cards.map(c => {
  const form = (c.evolutionLevel || 0) & 1 ? 'e' : (c.evolutionLevel || 0) & 2 ? 'h' : '';
  return c.id + form;
}).sort().join(',');

async function pollPlayers(env, now, st) {
  const dueRes = await env.DB.prepare(`
    SELECT tag, last_time FROM players WHERE seen_at >= ?1 AND next_poll <= ?2
    ORDER BY next_poll LIMIT ?3`).bind((+st.board_at || 0) - HOUR, now, PLAYERS_PER_RUN).all();
  const due = dueRes.results;
  if (!due.length) return;
  const logs = await Promise.all(due.map(p => api(env, `/players/${p.tag}/battlelog`).catch(e => ({ error: e.message }))));

  const matches = [], updates = [];
  let errors = 0;
  due.forEach((p, i) => {
    const log = logs[i];
    if (!Array.isArray(log)) {
      errors++;
      updates.push({ tag: p.tag, next: now + RETRY_AFTER, last: p.last_time });
      return;
    }
    let last = p.last_time || 0;
    for (const b of log) {
      if (b.type !== 'pathOfLegend' || !b.battleTime) continue;
      const t = apiTime(b.battleTime);
      if (t <= (p.last_time || 0)) continue;
      const me = b.team?.[0], opp = b.opponent?.[0];
      if (me?.cards?.length !== 8 || opp?.cards?.length !== 8) continue;
      const [a, o] = [me, opp].sort((x, y) => (x.tag < y.tag ? -1 : 1));
      matches.push({ t, pa: a.tag, pb: o.tag, da: deckKey(a.cards), db: deckKey(o.cards),
                     ca: a.crowns || 0, cb: o.crowns || 0, ra: a.startingTrophies ?? null, rb: o.startingTrophies ?? null });
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
      INSERT OR IGNORE INTO matches (time, pa, pb, da, db, ca, cb, ra, rb)
      SELECT json_extract(value, '$.t'), json_extract(value, '$.pa'), json_extract(value, '$.pb'),
             json_extract(value, '$.da'), json_extract(value, '$.db'), json_extract(value, '$.ca'),
             json_extract(value, '$.cb'), json_extract(value, '$.ra'), json_extract(value, '$.rb')
      FROM json_each(?1)`).bind(JSON.stringify(matches)).run();
    inserted = res.meta?.changes || 0;
  }
  const updateRes = await env.DB.prepare(`
    UPDATE players SET next_poll = json_extract(j.value, '$.next'), last_time = json_extract(j.value, '$.last'),
      polls = polls + 1
    FROM json_each(?1) AS j WHERE players.tag = json_extract(j.value, '$.tag')`).bind(JSON.stringify(updates)).run();
  const reads = rowsRead([dueRes, insertRes, updateRes]) + 25;  // + the tick's state read
  await setState(env, {
    reads_day: dayKey(now), reads_count: readsToday(st, now) + reads,
    last_poll_at: now,
    polls_total: (+st.polls_total || 0) + due.length,
    matches_total: (+st.matches_total || 0) + inserted,
    ...(errors ? { last_error: `${new Date(now).toISOString()} ${errors} battle log(s) failed: ${logs.find(l => l.error)?.error}` } : {}),
  });
}

// Deck and card stats over the last WINDOW_DAYS, both sides of every match, plus
// the week before for trends once collection has run that long (skipped until
// then: it would only read rows to describe a half-collected week)
async function computeStats(env, now) {
  const st = await getState(env);
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000), until = Math.floor(now / 1000) + 60;
  const prevSince = since - WINDOW_DAYS * 86400;
  const havePrev = +st.started_at && +st.started_at <= prevSince * 1000;
  // One row per deck played (w = won, d = draw, t = won with three crowns),
  // grouped by deck first: a week's ~50k decks played are only a few thousand
  // distinct decks, and the cards are unpacked from those. Unpacking every deck
  // played instead (json_each over each side) read ~950k rows a run — D1 counts
  // each unpacked card as a row read.
  const grouped = `
    WITH s AS (
      SELECT pa AS tag, da AS deck, ca > cb AS w, ca = cb AS d, ca > cb AND ca = 3 AS t FROM matches WHERE time >= ?1 AND time < ?2
      UNION ALL
      SELECT pb, db, cb > ca, ca = cb, cb > ca AND cb = 3 FROM matches WHERE time >= ?1 AND time < ?2),
    g AS MATERIALIZED (
      SELECT deck, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d, SUM(t) AS t, COUNT(DISTINCT tag) AS p FROM s GROUP BY deck)`;
  const cardsOfG = `
    SELECT 'c' AS kind, j.value AS k, SUM(g.n) AS n, SUM(g.w) AS w, SUM(g.d) AS d, SUM(g.t) AS t, NULL AS p
    FROM g, json_each('["' || replace(g.deck, ',', '","') || '"]') AS j GROUP BY j.value`;
  // MIN / MAX read one row each off the primary key; match counts come from the
  // card tally (every match is 2 decks × 8 cards) instead of another scan
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT MIN(time) FROM matches WHERE time >= ?1) AS first,
                           (SELECT MAX(time) FROM matches) AS last`).bind(since),
    // top decks and every card in one statement, off one grouping
    env.DB.prepare(`${grouped}
      SELECT * FROM (SELECT 'd' AS kind, deck AS k, n, w, d, t, p FROM g ORDER BY n DESC LIMIT ?3)
      UNION ALL SELECT * FROM (${cardsOfG})`).bind(since, until, TOP_DECKS),
    ...(havePrev ? [env.DB.prepare(`${grouped} ${cardsOfG}`).bind(prevSince, since)] : []),
  ]);
  const [range, both, prev] = results;
  const decks = both.results.filter(r => r.kind === 'd');
  const cards = both.results.filter(r => r.kind === 'c').sort((a, b) => b.n - a.n);
  const t = range.results[0] || {};
  const count = rows => Math.round(rows.reduce((sum, r) => sum + r.n, 0) / 16);
  const reads = rowsRead(results);
  const meta = {
    updated: now,
    next: now + refreshEvery(reads, STATS_SHARE),  // when these stats are recomputed
    window_days: WINDOW_DAYS,
    started: +st.started_at || null,  // when collection began; older matches came from the first logs
    matches: count(cards),
    first: t.first ? t.first * 1000 : null,
    last: t.last ? t.last * 1000 : null,
    // [deck key, games, wins, draws, different players, three-crown wins]
    decks: decks.map(r => [r.k, r.n, r.w, r.d, r.p, r.t]),
    // [card id + form, decks it was in, wins, draws, three-crown wins]
    cards: cards.map(r => [r.k, r.n, r.w, r.d, r.t]),
    // The week before, for trends: { matches, cards: [card, decks, wins] }; null until collected
    prev: prev ? { matches: count(prev.results), cards: prev.results.sort((a, b) => b.n - a.n).map(r => [r.k, r.n, r.w]) } : null,
  };
  await countReads(env, 'stats', now, reads, { stats_at: now, meta: JSON.stringify(meta) });
}

// The current top 1,000 with each player's most played ranked deck over the
// window and their overall record in it (players with no ranked match collected
// in the window get no deck)
async function computeTop(env, now) {
  const st = await getState(env);
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000), onBoard = (+st.board_at || 0) - HOUR;
  const res = await env.DB.prepare(`
    WITH s AS (
      SELECT pa AS tag, da AS deck, ca > cb AS w FROM matches WHERE time >= ?1
      UNION ALL
      SELECT pb, db, cb > ca FROM matches WHERE time >= ?1),
    g AS (SELECT s.tag, s.deck, COUNT(*) AS n, SUM(s.w) AS w FROM s JOIN players p ON p.tag = s.tag AND p.seen_at >= ?2
          GROUP BY s.tag, s.deck),
    -- the player's totals come from the same grouping, so the matches are read once
    r AS (SELECT tag, deck, n, ROW_NUMBER() OVER (PARTITION BY tag ORDER BY n DESC) AS rk,
                 SUM(n) OVER (PARTITION BY tag) AS games, SUM(w) OVER (PARTITION BY tag) AS wins FROM g)
    SELECT p.tag, p.name, p.clan, p.rank, p.rating, r.deck, r.n, r.games, r.wins
    FROM players p LEFT JOIN r ON r.tag = p.tag AND r.rk = 1
    WHERE p.seen_at >= ?2 ORDER BY p.rank`).bind(since, onBoard).all();
  const reads = rowsRead([res]);
  const top = {
    updated: now,
    next: now + refreshEvery(reads, TOP_SHARE),
    window_days: WINDOW_DAYS,
    // [tag, name, clan, rank, rating, main deck key, games with it, ranked games, wins]
    players: res.results.map(r => [r.tag, r.name, r.clan, r.rank, r.rating, r.deck, r.n || 0, r.games || 0, r.wins || 0]),
  };
  await countReads(env, 'top', now, reads, { top_at: now, top: JSON.stringify(top) });
}

async function prune(env, now) {
  const cutoff = Math.floor((now - KEEP_DAYS * DAY) / 1000);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM matches WHERE time < ?1`).bind(cutoff),
    // Off the leaderboard for a week: stop tracking
    env.DB.prepare(`DELETE FROM players WHERE seen_at < ?1`).bind(now - 7 * DAY),
  ]);
  await setState(env, { prune_at: now });
}

async function getState(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM state WHERE k NOT IN ('meta', 'top')`).all();
  return Object.fromEntries(results.map(r => [r.k, r.v]));
}
async function setState(env, values) {
  await env.DB.prepare(`
    INSERT INTO state (k, v) SELECT key, value FROM json_each(?1) WHERE true
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(values)).run();
}
