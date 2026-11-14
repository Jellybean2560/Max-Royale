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
//    request. Each run reads the week's matches once per side plus the distinct
//    decks (~200k rows at 25k matches), and the week before again once there is
//    one for trends; the top players' main decks take another pass. Every query's
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
const KEEP_DAYS = 90;               // matches older than this are deleted (storage only: the stats read a 7-day window)
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
const ARCHIVE_LAG = 13 * HOUR;
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
    if (['/meta', '/top', '/history', '/counters'].includes(url.pathname)) {
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
    if (url.pathname === '/status') {
      const st = await getState(env);
      const board = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(polls > 0) AS polled FROM players WHERE seen_at >= ?1`).bind(pollFrom(st)).first();
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
  if (due('board', BOARD_EVERY)) return run('board', refreshBoard);
  // /top two days stale (stats kept taking the day's budget first): it goes before the stats this once
  if (+st.matches_total > 0 && now - (+st.top_at || 0) > TOP_STARVED && due('top', 0) && fits('top')) return run('top', computeTop);
  if (+st.matches_total > 0 && due('stats', refreshEvery(+st.stats_reads, STATS_SHARE)) && fits('stats')) return run('stats', computeStats);
  const backlog = +st.archive_to && periodEnd(+st.archive_to) <= now - ARCHIVE_LAG - DAY;
  if (+st.matches_total > 0 && due('top', Math.max(refreshEvery(+st.top_reads, TOP_SHARE), backlog ? TOP_EVERY_BACKLOG : 0)) && fits('top')) return run('top', computeTop);
  // The archive takes one finished period a run, oldest first (a backlog drains as the budget allows)
  if (+st.archive_to && periodEnd(+st.archive_to) <= now - ARCHIVE_LAG && now - (+st.archive_try_at || 0) > 10 * MINUTE && fits('archive')) return run('archive', archivePeriod);
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

async function refreshBoard(env, now, st) {
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
      rating = excluded.rating, clan = excluded.clan, seen_at = excluded.seen_at,
      next_poll = CASE WHEN players.next_poll >= ${PARKED} THEN excluded.next_poll ELSE players.next_poll END`).bind(JSON.stringify(items), now).run();
  const full = items.length >= MIN_BOARD;
  if (full) {
    // Players no longer on it are parked until they come back
    await env.DB.prepare(`UPDATE players SET next_poll = ${PARKED} WHERE seen_at < ?1 AND next_poll < ${PARKED}`).bind(now).run();
  } else if (st.full_board_at) {
    // Season start: last season's top 1,000 are woken (once) and kept polled
    await env.DB.prepare(`UPDATE players SET next_poll = ?2 WHERE next_poll >= ${PARKED} AND seen_at >= ?1`).bind(+st.full_board_at - HOUR, now).run();
  }
  // Each UTC day's first refresh keeps everyone's rating, for the climb over a day / week
  await env.DB.prepare(`
    INSERT OR IGNORE INTO ratings (day, tag, rating)
    SELECT ?2, json_extract(value, '$.tag'), json_extract(value, '$.rating') FROM json_each(?1)`).bind(JSON.stringify(items), dayKey(now)).run();
  await setState(env, { board_at: now, board_size: items.length, ...(full ? { full_board_at: now } : {}) });
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

async function pollPlayers(env, now, st) {
  const dueRes = await env.DB.prepare(`
    SELECT tag, last_time FROM players WHERE seen_at >= ?1 AND next_poll <= ?2
    ORDER BY next_poll LIMIT ?3`).bind(pollFrom(st), now, PLAYERS_PER_RUN).all();
  const due = dueRes.results;
  if (!due.length) return;
  const logs = await Promise.all(due.map(p => api(env, `/players/${p.tag}/battlelog`).catch(e => ({ error: e.message }))));

  const matches = [], updates = [];
  let errors = 0;
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
      INSERT OR IGNORE INTO matches (time, pa, pb, da, db, ca, cb, ra, rb, ta, tb, ka, kb, sa, sb, la, lb)
      SELECT json_extract(value, '$.t'), json_extract(value, '$.pa'), json_extract(value, '$.pb'),
             json_extract(value, '$.da'), json_extract(value, '$.db'), json_extract(value, '$.ca'),
             json_extract(value, '$.cb'), json_extract(value, '$.ra'), json_extract(value, '$.rb'),
             json_extract(value, '$.ta'), json_extract(value, '$.tb'), json_extract(value, '$.ka'),
             json_extract(value, '$.kb'), json_extract(value, '$.sa'), json_extract(value, '$.sb'),
             json_extract(value, '$.la'), json_extract(value, '$.lb')
      FROM json_each(?1) RETURNING time`).bind(JSON.stringify(matches)).all();
    inserted = res.results.length;
  }
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
  const reads = rowsRead([dueRes, insertRes, updateRes]) + 25;  // + the tick's state read
  await setState(env, {
    reads_day: dayKey(now), reads_count: readsToday(st, now) + reads,
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
async function computeStats(env, now) {
  step('state');
  const st = await getState(env);
  const since = Math.floor((now - WINDOW_DAYS * DAY) / 1000), until = Math.floor(now / 1000) + 60;
  // One row per deck played (w = won, d = draw, t = won with three crowns),
  // grouped by deck first: a week's ~50k decks played are only a few thousand
  // distinct decks, and the cards are unpacked from those. Unpacking every deck
  // played instead (json_each over each side) read ~950k rows a run — D1 counts
  // each unpacked card as a row read.
  // Full tower HP: the highest left standing in a recent sample (a match where a
  // side's towers went untouched), never below what earlier runs saw
  const oldMeta = JSON.parse((await env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`).first())?.v || 'null');
  step('tower sample');
  const sample = await env.DB.prepare(`
    SELECT ta, tb, ka, kb, sa, sb FROM matches WHERE time >= ?1 ORDER BY time DESC LIMIT ?2`).bind(since, TOWER_SAMPLE).all();
  const towers = { king: Math.max(KING_HP, oldMeta?.towers?.king || 0), princess: { ...PRINCESS_HP } };
  for (const [id, hp] of Object.entries(oldMeta?.towers?.princess || {})) towers.princess[id] = Math.max(towers.princess[id] || 0, hp);
  for (const r of sample.results) for (const [t, k, sp] of [[r.ta, r.ka, r.sa], [r.tb, r.kb, r.sb]]) {
    if (t != null && sp != null) towers.princess[t] = Math.max(towers.princess[t] || 0, sp);
    if (k != null) towers.king = Math.max(towers.king, k);
  }
  // Numbers only (troop ids and HP), so they can be written into the SQL: a
  // json_each lookup per match row would count every lookup as rows read
  const troopIds = Object.keys(towers.princess).map(Number).filter(Number.isInteger);
  const fullP = col => `CASE ${col} ${troopIds.map(id => `WHEN ${id} THEN ${Math.round(towers.princess[id])}`).join(' ')} ELSE NULL END`;
  // Damage a side's towers took: king + both princess towers, full minus what's left
  const dmg = (t, k, sp) => `CASE WHEN ${k} IS NULL THEN NULL ELSE MAX(0, ${Math.round(towers.king)} - ${k} + ${fullP(t)} - ${sp}) END`;
  // Rating bands: a side's rating at the match against today's #100 and #1000
  // (read off /top inside SQLite: parsing its 140 KB here would eat the CPU limit)
  const bandRow = await env.DB.prepare(`
    SELECT COALESCE(json_extract(v, '$.players[99][4]'), (SELECT json_extract(v, '$.bands.hi') FROM state WHERE k = 'meta')) AS hi,
           COALESCE(json_extract(v, '$.players[999][4]'), (SELECT json_extract(v, '$.bands.lo') FROM state WHERE k = 'meta'),
                    json_extract(v, '$.players[#-1][4]')) AS lo
    FROM state WHERE k = 'top'`).first();
  const bands = { hi: Math.round(+bandRow?.hi) || 3000, lo: Math.round(+bandRow?.lo) || 2500 };
  // Counters: each top deck's record against every opponent card. The decks are
  // last run's top ones (keys checked to be digits, e/h and commas, so they can
  // go into the SQL), the cards every card id seen. The opponent's deck is
  // searched with instr() per card, packed 4 cards to a column — no json_each,
  // so it reads no extra rows.
  const topKeys = (oldMeta?.decks || []).map(d => d[0]).filter(k => /^[0-9eh,]+$/.test(k));
  const cardIds = [...new Set((oldMeta?.cards || []).map(c => parseInt(c[0], 10)))].filter(Number.isInteger).sort((a, b) => a - b);
  const counters = topKeys.length && cardIds.length;
  const chunks = [];
  for (let i = 0; i < cardIds.length; i += 4) chunks.push(cardIds.slice(i, i + 4));
  const packed = ids => ids.map((id, i) => `((instr(cx, ',${id}') > 0) << ${i * BITS})`).join(' + ');
  const unpack = (col, i) => `(${col} >> ${i * BITS}) & ${MASK}`;
  // One JSON array of unpacked values per CHUNK cards (json_array takes ≤ 127)
  const cardArray = pre => {
    const vals = cardIds.map((id, i) => unpack(`${pre}${Math.floor(i / 4)}`, i % 4)), parts = [];
    for (let i = 0; i < vals.length; i += CHUNK) parts.push(`json_array(${vals.slice(i, i + CHUNK).join(', ')})`);
    return `CASE WHEN ${pre}0 IS NULL THEN NULL ELSE json_array(${parts.join(', ')}) END`;
  };
  const cx = side => counters ? `CASE WHEN ${side === 'a' ? 'da' : 'db'} IN (${topKeys.map(k => `'${k}'`).join(',')}) THEN ',' || ${side === 'a' ? 'db' : 'da'} END` : 'NULL';
  const bandsOf = col => `json_array(${[0, 1, 2, 3].map(i => unpack(col, i)).join(', ')})`;
  // Rating gap (own rating − opponent's, both before the match) → bucket 0…GAPS-1
  const gap = (a, b) => `CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL ELSE MIN(${GAPS - 1}, MAX(0, (${a} - ${b} + ${GAP_STEP * GAPS / 2} + ${GAP_STEP * 100}) / ${GAP_STEP} - 100)) END`;
  // Per deck: [games per gap bucket ×8, wins per gap bucket ×8, close wins, close losses, three-crowned losses]
  const gapVals = (fn = x => x) => ['z', 'y'].flatMap(c => [0, 1].flatMap(j => [0, 1, 2, 3].map(i => fn(unpack(`${c}${j}`, i)))));
  const extraOf = `json_array(${gapVals().join(', ')}, ${[0, 1, 2].map(i => unpack('cg', i)).join(', ')})`;
  // full: the current window, with everything; else the week before, for trends (cards only)
  const grouped = full => `
    WITH s AS (
      SELECT pa AS tag, da AS deck, ca > cb AS w, ca = cb AS d, ca > cb AND ca = 3 AS t, ta AS tt,
             ${dmg('tb', 'kb', 'sb')} AS dealt, ${dmg('ta', 'ka', 'sa')} AS taken, la AS leak, ra AS rt, ${full ? cx('a') : 'NULL'} AS cx,
             ${gap('ra', 'rb')} AS gb, ca - cb AS mg, cb AS oc
        FROM matches WHERE time >= ?1 AND time < ?2
      UNION ALL
      SELECT pb, db, cb > ca, ca = cb, cb > ca AND cb = 3, tb, ${dmg('ta', 'ka', 'sa')}, ${dmg('tb', 'kb', 'sb')}, lb, rb, ${full ? cx('b') : 'NULL'},
             ${gap('rb', 'ra')}, cb - ca, ca
        FROM matches WHERE time >= ?1 AND time < ?2),
    g AS MATERIALIZED (
      SELECT deck, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d, SUM(t) AS t, COUNT(DISTINCT tag) AS p,
             SUM(dealt) AS dealt, SUM(taken) AS taken, COUNT(dealt) AS hn, SUM(leak) AS leak, COUNT(leak) AS ln,
             /* games and wins at #1–100 rating, then at #101–1000 */
             SUM(CASE WHEN rt >= ${bands.hi} THEN 1 + (w << ${BITS}) WHEN rt >= ${bands.lo} THEN (1 << ${2 * BITS}) + (w << ${3 * BITS}) END) AS bd
             /* games (z) and wins (y) per rating gap bucket, four buckets to a column */
             ${[0, 1].map(j => `, SUM(CASE WHEN gb / 4 = ${j} THEN 1 << ((gb % 4) * ${BITS}) END) AS z${j}, SUM(CASE WHEN gb / 4 = ${j} AND w THEN 1 << ((gb % 4) * ${BITS}) END) AS y${j}`).join('')}
             /* close games: won by one crown (not three), lost by one (not to three), lost to three crowns */
             , SUM(CASE WHEN mg = 1 AND oc < 2 THEN 1 WHEN mg = -1 AND oc < 3 THEN 1 << ${BITS} WHEN mg < 0 AND oc = 3 THEN 1 << ${2 * BITS} ELSE 0 END) AS cg
             /* per tower troop: games, wins, three-crown wins */
             ${troopIds.map(id => `, SUM(CASE WHEN tt = ${id} THEN 1 + (w << ${BITS}) + (t << ${2 * BITS}) END) AS q${id}`).join('')}
             /* per opponent card: games against it (o) and wins (v) */
             ${full && counters ? chunks.map((ids, j) => `, SUM(${packed(ids)}) AS o${j}, SUM(w * (${packed(ids)})) AS v${j}`).join('') : ''}
      FROM s GROUP BY deck)`;
  const cardsOfG = `
    SELECT 'c' AS kind, j.value AS k, SUM(g.n) AS n, SUM(g.w) AS w, SUM(g.d) AS d, SUM(g.t) AS t, NULL AS p,
           NULL AS dealt, NULL AS taken, NULL AS hn, NULL AS leak, NULL AS ln, NULL AS tr,
           json_array(${[0, 1, 2, 3].map(i => `SUM(${unpack('g.bd', i)})`).join(', ')}) AS bd, NULL AS cn, NULL AS cw, NULL AS ex
    FROM g, json_each('["' || replace(g.deck, ',', '","') || '"]') AS j GROUP BY j.value`;
  // Tower troops: one row off the deck grouping, its totals packed as JSON so it
  // fits the same columns (and statement) as the decks and cards
  const troopsOfG = troopIds.length ? `
    UNION ALL SELECT 'x', json_object(${troopIds.map(id => `'n${id}', SUM(${unpack(`q${id}`, 0)}), 'w${id}', SUM(${unpack(`q${id}`, 1)}), 't${id}', SUM(${unpack(`q${id}`, 2)})`).join(', ')}),
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM g` : '';
  // Calibration for the skill adjustment: games and wins per rating gap bucket over every deck
  const gapsOfG = `
    UNION ALL SELECT 'z', json_array(${gapVals(v => `SUM(${v})`).join(', ')}),
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM g`;
  const troopsOfDeck = troopIds.length ? `json_array(${troopIds.map(id => [0, 1, 2].map(i => unpack(`q${id}`, i)).join(', ')).join(', ')})` : 'NULL';
  // MIN / MAX read one row each off the primary key; match counts come from the
  // card tally (every match is 2 decks × 8 cards) instead of another scan
  // One at a time with a pause (D1_PAUSE), not as a batch: D1 runs a batch as one job
  const results = [];
  for (const q of [
    env.DB.prepare(`SELECT (SELECT MIN(time) FROM matches WHERE time >= ?1) AS first,
                           (SELECT MAX(time) FROM matches) AS last`).bind(since),
    // top decks and every card in one statement, off one grouping
    env.DB.prepare(`${grouped(true)}
      SELECT * FROM (SELECT 'd' AS kind, deck AS k, n, w, d, t, p, dealt, taken, hn, leak, ln, ${troopsOfDeck} AS tr, ${bandsOf('bd')} AS bd,
                            ${counters ? `${cardArray('o')} AS cn, ${cardArray('v')} AS cw` : 'NULL AS cn, NULL AS cw'}, ${extraOf} AS ex
                     FROM g ORDER BY n DESC LIMIT ?3)
      UNION ALL SELECT * FROM (${cardsOfG}) ${troopsOfG} ${gapsOfG}`).bind(since, until, TOP_DECKS),
  ]) {
    step(['range', 'grouping'][results.length]);
    results.push(await q.all());
  }
  const [range, both] = results;
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
  const tx = JSON.parse(both.results.find(r => r.kind === 'x')?.k || '{}'), names = JSON.parse(st.troop_names || '{}');
  const avg = (sum, n) => n ? Math.round(sum / n * 10) / 10 : null;
  const bandsOfRow = r => (JSON.parse(r.bd || 'null') || []).concat([0, 0, 0, 0]).slice(0, 4).map(v => v || 0);
  const troopsOfRow = r => {
    const a = JSON.parse(r.tr || '[]');
    return troopIds.map((id, i) => [id, a[3 * i] || 0, a[3 * i + 1] || 0, a[3 * i + 2] || 0]).filter(x => x[1] > 0);
  };
  // Skill adjustment: the win rate at each rating gap, from every deck played
  const zr = JSON.parse(both.results.find(r => r.kind === 'z')?.k || '[]');
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
    troops: troopIds.map(id => [id, names[id]?.[0] || null, names[id]?.[1] || null, tx[`n${id}`] || 0, tx[`w${id}`] || 0, tx[`t${id}`] || 0])
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
    ...(counterJSON ? { counters: counterJSON } : {}), ...(seed ? { activity: JSON.stringify(act) } : {}) });
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
  // Archived days come from player_days ([its first day, archive_to)); the rest of the
  // window — today and yesterday, and the days before player_days began — from the matches
  const first = await env.DB.prepare(`SELECT MIN(start) AS s FROM player_days`).first();   // one row, by the key
  const pdTo = Math.floor((+st.archive_to || 0) / 1000), pdFrom = Math.min(first?.s ?? pdTo, pdTo);
  const [res, pairs, kept] = await env.DB.batch([env.DB.prepare(`
    WITH s AS (
      SELECT tag, deck, n, w FROM player_days WHERE start >= max(?1, ?5) AND start < ?6
      UNION ALL
      /* two ranges, each its own index range (an OR would scan the whole week) */
      SELECT pa, da, 1, ca > cb FROM matches WHERE time >= ?1 AND time < ?5
      UNION ALL SELECT pb, db, 1, cb > ca FROM matches WHERE time >= ?1 AND time < ?5
      UNION ALL SELECT pa, da, 1, ca > cb FROM matches WHERE time >= max(?1, ?6)
      UNION ALL SELECT pb, db, 1, cb > ca FROM matches WHERE time >= max(?1, ?6)),
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
    ...(fresh ? { rivals: JSON.stringify(rivals), rivals_at: now, rivals_reads: rowsRead([pairs]) } : {}) });
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
  step('archive decks');
  const dayRes = await env.DB.prepare(`
    INSERT OR REPLACE INTO day_decks (start, deck, n, w, d, t, tr)
    SELECT ?1, deck, SUM(n), SUM(w), SUM(d), SUM(t), json_group_array(json_array(tr, n, w, t)) FROM (
      SELECT deck, tr, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d, SUM(t) AS t FROM (
        SELECT da AS deck, ta AS tr, ca > cb AS w, ca = cb AS d, ca > cb AND ca = 3 AS t FROM matches WHERE time >= ?1 AND time < ?2
        UNION ALL SELECT db, tb, cb > ca, ca = cb, cb > ca AND cb = 3 FROM matches WHERE time >= ?1 AND time < ?2)
      GROUP BY deck, tr)
    GROUP BY deck`).bind(a, b).run();
  step('archive totals');
  const batch = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR REPLACE INTO card_days (start, card, n, w, d, t)
      SELECT ?1, j.value, SUM(n), SUM(w), SUM(d), SUM(t) FROM day_decks, json_each('["' || replace(deck, ',', '","') || '"]') AS j
      WHERE start = ?1 GROUP BY j.value
      UNION ALL SELECT ?1, '_', COALESCE(SUM(n), 0) / 2, 0, 0, 0 FROM day_decks WHERE start = ?1`).bind(a),
    env.DB.prepare(`
      INSERT INTO season_decks (season, deck, n, w, d, t) SELECT ?2, deck, n, w, d, t FROM day_decks WHERE start = ?1
      ON CONFLICT (season, deck) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, d = d + excluded.d, t = t + excluded.t`).bind(a, season),
    env.DB.prepare(`
      INSERT INTO season_cards (season, card, n, w, d, t) SELECT ?2, card, n, w, d, t FROM card_days WHERE start = ?1 AND card != '_'
      ON CONFLICT (season, card) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, d = d + excluded.d, t = t + excluded.t`).bind(a, season),
    env.DB.prepare(`
      INSERT INTO season_troops (season, troop, n, w, t)
      SELECT ?2, j.value ->> 0 AS troop, SUM(j.value ->> 1), SUM(j.value ->> 2), SUM(j.value ->> 3)
      FROM day_decks, json_each(day_decks.tr) AS j WHERE start = ?1 AND j.value ->> 0 IS NOT NULL GROUP BY troop
      ON CONFLICT (season, troop) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, t = t + excluded.t`).bind(a, season),
    env.DB.prepare(`INSERT OR REPLACE INTO periods (start, end, season, matches) SELECT ?1, ?2, ?3, COALESCE(SUM(n), 0) / 2 FROM day_decks WHERE start = ?1`).bind(a, b, season),
    // Per tracked player and deck, for /top: a week of these is ~30k rows instead
    // of re-reading the week's matches (~1M rows with the grouping, Nov 2026)
    env.DB.prepare(`
      INSERT OR REPLACE INTO player_days (start, tag, deck, n, w)
      SELECT ?1, tag, deck, COUNT(*), SUM(w) FROM (
        SELECT pa AS tag, da AS deck, ca > cb AS w FROM matches WHERE time >= ?1 AND time < ?2
        UNION ALL SELECT pb, db, cb > ca FROM matches WHERE time >= ?1 AND time < ?2)
      WHERE tag IN (SELECT tag FROM players) GROUP BY tag, deck`).bind(a, b),
    env.DB.prepare(`INSERT INTO state (k, v) VALUES ('archive_to', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(endMs)),
  ]);
  let reads = rowsRead([dayRes]) + rowsRead(batch);
  // The season's stats are rebuilt when the archive is caught up, or at a season's last period during a backlog
  // (and at least every 6 h, so a long backlog still shows its progress)
  const caughtUp = periodEnd(endMs) > now - ARCHIVE_LAG, seasonDone = endMs >= nextSeasonStart(startMs);
  const build = caughtUp || seasonDone || now - (+st.season_built_at || 0) > 6 * HOUR;
  if (build) { step('archive season'); reads += await buildSeason(env, now, season); }
  await countReads(env, 'archive', now, reads, { archive_at: now, ...(build ? { season_built_at: now } : {}) });
  step('');
}

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
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM matches WHERE time < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM player_days WHERE start < ?1`).bind(Math.floor((now - PLAYER_DAYS_KEEP * DAY) / 1000)),
    // Off the leaderboard for a week: stop tracking
    // (last season's top 1,000 are kept while the new board is short)
    env.DB.prepare(`DELETE FROM players WHERE seen_at < ?1`).bind(Math.min(now - 7 * DAY, pollFrom(st))),
  ]);
  await setState(env, { prune_at: now });
}

async function getState(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM state WHERE k NOT IN ('meta', 'top', 'history', 'counters', 'deck_days', 'season_list', 'rivals')`).all();
  return Object.fromEntries(results.map(r => [r.k, r.v]));
}
async function setState(env, values) {
  await env.DB.prepare(`
    INSERT INTO state (k, v) SELECT key, value FROM json_each(?1) WHERE true
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(values)).run();
}
