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
//    and the stats are computed every 6 hours, not per request (each run reads
//    the week's matches twice: ~2M rows a day at ~15k matches a day).
//
// GET /meta    the latest stats (CORS open, for the app)
// GET /status  collection progress and the last error

const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const BOARD_EVERY = 6 * HOUR;       // leaderboard refresh
const STATS_EVERY = 6 * HOUR;       // recompute /meta
const PRUNE_EVERY = DAY;
const KEEP_DAYS = 30;               // matches older than this are deleted
const WINDOW_DAYS = 7;              // the stats cover this many days
const PLAYERS_PER_RUN = 5;          // battle logs fetched per minute (~7,200 a day max)
const MIN_INTERVAL = 30 * MINUTE;
const MAX_INTERVAL = 12 * HOUR;
const TOP_DECKS = 60;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch(e => setState(env, { last_error: `${new Date().toISOString()} ${e.message}` })));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/meta') {
      const row = await env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`).first();
      return new Response(row?.v || JSON.stringify({ empty: true }), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    }
    if (url.pathname === '/status') {
      const st = await getState(env);
      const board = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(polls > 0) AS polled FROM players WHERE seen_at >= ?1`).bind((+st.board_at || 0) - HOUR).first();
      const day = await env.DB.prepare(`SELECT COUNT(*) AS n FROM matches WHERE time >= ?1`).bind(Math.floor((Date.now() - DAY) / 1000)).first();
      return new Response(JSON.stringify({ ...st, players: board?.n || 0, players_polled: board?.polled || 0, matches_last_24h: day?.n || 0 }, null, 2), { headers });
    }
    return new Response('Max Royale meta collector — see /meta and /status', { status: 404 });
  },
};

// ── One job per minute: whichever periodic job is due, else poll players ──
async function tick(env) {
  const now = Date.now(), st = await getState(env);
  if (now - (+st.board_at || 0) > BOARD_EVERY) return refreshBoard(env, now);
  if (now - (+st.stats_at || 0) > STATS_EVERY && +st.matches_total > 0) return computeStats(env, now);
  if (now - (+st.prune_at || 0) > PRUNE_EVERY) return prune(env, now);
  return pollPlayers(env, now, st);
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
  const items = (board.items || []).map(p => ({ tag: p.tag, name: p.name, rank: p.rank, rating: p.eloRating }));
  if (!items.length) throw new Error('empty leaderboard');
  // New players are due at once; existing ones keep their schedule
  await env.DB.prepare(`
    INSERT INTO players (tag, name, rank, rating, seen_at, next_poll)
    SELECT json_extract(value, '$.tag'), json_extract(value, '$.name'), json_extract(value, '$.rank'),
           json_extract(value, '$.rating'), ?2, ?2
    FROM json_each(?1) WHERE true
    ON CONFLICT (tag) DO UPDATE SET name = excluded.name, rank = excluded.rank,
      rating = excluded.rating, seen_at = excluded.seen_at`).bind(JSON.stringify(items), now).run();
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
  const { results: due } = await env.DB.prepare(`
    SELECT tag, last_time FROM players WHERE seen_at >= ?1 AND next_poll <= ?2
    ORDER BY next_poll LIMIT ?3`).bind((+st.board_at || 0) - HOUR, now, PLAYERS_PER_RUN).all();
  if (!due.length) return;
  const logs = await Promise.all(due.map(p => api(env, `/players/${p.tag}/battlelog`).catch(e => ({ error: e.message }))));

  const matches = [], updates = [];
  let errors = 0;
  due.forEach((p, i) => {
    const log = logs[i];
    if (!Array.isArray(log)) {
      errors++;
      updates.push({ tag: p.tag, next: now + MAX_INTERVAL, last: p.last_time });
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

  let inserted = 0;
  if (matches.length) {
    const res = await env.DB.prepare(`
      INSERT OR IGNORE INTO matches (time, pa, pb, da, db, ca, cb, ra, rb)
      SELECT json_extract(value, '$.t'), json_extract(value, '$.pa'), json_extract(value, '$.pb'),
             json_extract(value, '$.da'), json_extract(value, '$.db'), json_extract(value, '$.ca'),
             json_extract(value, '$.cb'), json_extract(value, '$.ra'), json_extract(value, '$.rb')
      FROM json_each(?1)`).bind(JSON.stringify(matches)).run();
    inserted = res.meta?.changes || 0;
  }
  await env.DB.prepare(`
    UPDATE players SET next_poll = json_extract(j.value, '$.next'), last_time = json_extract(j.value, '$.last'),
      polls = polls + 1
    FROM json_each(?1) AS j WHERE players.tag = json_extract(j.value, '$.tag')`).bind(JSON.stringify(updates)).run();
  await setState(env, {
    last_poll_at: now,
    polls_total: (+st.polls_total || 0) + due.length,
    matches_total: (+st.matches_total || 0) + inserted,
    ...(errors ? { last_error: `${new Date(now).toISOString()} ${errors} battle log(s) failed: ${logs.find(l => l.error)?.error}` } : {}),
  });
}

// Deck and card stats over the last WINDOW_DAYS, both sides of every match
async function computeStats(env, now) {
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000);
  const sides = `
    WITH s AS (
      SELECT da AS deck, ca > cb AS w, ca = cb AS d FROM matches WHERE time >= ?1
      UNION ALL
      SELECT db, cb > ca, ca = cb FROM matches WHERE time >= ?1)`;
  // MIN / MAX read one row each off the primary key; the match count comes from
  // the card tally (every match is 2 decks × 8 cards) instead of a third scan
  const [range, decks, cards] = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT MIN(time) FROM matches WHERE time >= ?1) AS first,
                           (SELECT MAX(time) FROM matches) AS last`).bind(since),
    env.DB.prepare(`${sides} SELECT deck, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d FROM s
                    GROUP BY deck ORDER BY n DESC LIMIT ?2`).bind(since, TOP_DECKS),
    env.DB.prepare(`${sides} SELECT j.value AS card, COUNT(*) AS n, SUM(s.w) AS w, SUM(s.d) AS d
                    FROM s, json_each('["' || replace(s.deck, ',', '","') || '"]') AS j
                    GROUP BY j.value ORDER BY n DESC`).bind(since),
  ]);
  const t = range.results[0] || {};
  const matches = Math.round(cards.results.reduce((s, r) => s + r.n, 0) / 16);
  const meta = {
    updated: now,
    window_days: WINDOW_DAYS,
    matches,
    first: t.first ? t.first * 1000 : null,
    last: t.last ? t.last * 1000 : null,
    // [deck key, games, wins, draws]
    decks: decks.results.map(r => [r.deck, r.n, r.w, r.d]),
    // [card id + form, decks it was in, wins, draws]
    cards: cards.results.map(r => [r.card, r.n, r.w, r.d]),
  };
  await setState(env, { stats_at: now, meta: JSON.stringify(meta) });
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
  const { results } = await env.DB.prepare(`SELECT k, v FROM state WHERE k != 'meta'`).all();
  return Object.fromEntries(results.map(r => [r.k, r.v]));
}
async function setState(env, values) {
  await env.DB.prepare(`
    INSERT INTO state (k, v) SELECT key, value FROM json_each(?1) WHERE true
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(values)).run();
}
