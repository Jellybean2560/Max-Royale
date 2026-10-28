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
const HISTORY_DAYS = 63;            // /history keeps a card tally per day this long: two 4-week blocks for month vs month
const ACTIVITY_DAYS = 35;           // matches per UTC hour, tallied as they're saved
// D1 allows 100 columns in a result (a CTE too) and 127 arguments to a function,
// so per-deck counts are packed 4 to an integer column, 15 bits each (a deck
// plays far fewer than 32,767 games a week), and unpacked in the final select
const BITS = 15, MASK = (1 << BITS) - 1, CHUNK = 100;
const MIN_REFRESH = HOUR, MAX_REFRESH = 24 * HOUR;
const refreshEvery = (reads, share) => Math.min(MAX_REFRESH, Math.max(MIN_REFRESH, DAY * (reads || 0) / share));
// 2M of D1's free 5M rows read a day (Cloudflare mails warnings from 80%), all
// queries counted; heavy jobs leave POLL_RESERVE for polling (~150k a day),
// the leaderboard, pruning and /status
const READ_BUDGET = 2e6, POLL_RESERVE = 250e3;
// next_poll of players who fell off the leaderboard: past the end of the poll
// index's range, so picking who to poll no longer walks over them (700 stale
// overdue rows were read on every poll — ~1M rows a day — before this)
const PARKED = 9e15;
// Full tower HP in ranked, for damage = full − left. Princess HP depends on the
// tower troop, so each troop's full pair is learnt from the data (the most seen
// left standing in recent matches) and kept as the highest ever seen. These are
// the starting values, from ranked battles Oct 2026 (king 7,728; Tower Princess 4,858 each).
const KING_HP = 7728, PRINCESS_HP = { 159000000: 2 * 4858 };
const TOWER_SAMPLE = 3000;          // recent matches read to learn full tower HP

export default {
  async scheduled(event, env, ctx) {
    if (env.PAUSED === '1') return;  // wrangler.toml [vars]: collection paused, no D1 access at all
    ctx.waitUntil(tick(env).catch(e => setState(env, { last_error: `${new Date().toISOString()} ${e.message}` })));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (['/meta', '/top', '/history', '/counters'].includes(url.pathname)) {
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
      rating = excluded.rating, clan = excluded.clan, seen_at = excluded.seen_at,
      next_poll = CASE WHEN players.next_poll >= ${PARKED} THEN excluded.next_poll ELSE players.next_poll END`).bind(JSON.stringify(items), now).run();
  // Players no longer on it are parked until they come back
  await env.DB.prepare(`UPDATE players SET next_poll = ${PARKED} WHERE seen_at < ?1 AND next_poll < ${PARKED}`).bind(now).run();
  await setState(env, { board_at: now, board_size: items.length });
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
    ORDER BY next_poll LIMIT ?3`).bind((+st.board_at || 0) - HOUR, now, PLAYERS_PER_RUN).all();
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
  // Full tower HP: the highest left standing in a recent sample (a match where a
  // side's towers went untouched), never below what earlier runs saw
  const oldMeta = JSON.parse((await env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`).first())?.v || 'null');
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
    SELECT json_extract(v, '$.players[99][4]') AS hi,
           COALESCE(json_extract(v, '$.players[999][4]'), json_extract(v, '$.players[#-1][4]')) AS lo
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
  // full: the current window, with everything; else the week before, for trends (cards only)
  const grouped = full => `
    WITH s AS (
      SELECT pa AS tag, da AS deck, ca > cb AS w, ca = cb AS d, ca > cb AND ca = 3 AS t, ta AS tt,
             ${dmg('tb', 'kb', 'sb')} AS dealt, ${dmg('ta', 'ka', 'sa')} AS taken, la AS leak, ra AS rt, ${full ? cx('a') : 'NULL'} AS cx
        FROM matches WHERE time >= ?1 AND time < ?2
      UNION ALL
      SELECT pb, db, cb > ca, ca = cb, cb > ca AND cb = 3, tb, ${dmg('ta', 'ka', 'sa')}, ${dmg('tb', 'kb', 'sb')}, lb, rb, ${full ? cx('b') : 'NULL'}
        FROM matches WHERE time >= ?1 AND time < ?2),
    g AS MATERIALIZED (
      SELECT deck, COUNT(*) AS n, SUM(w) AS w, SUM(d) AS d, SUM(t) AS t, COUNT(DISTINCT tag) AS p,
             SUM(dealt) AS dealt, SUM(taken) AS taken, COUNT(dealt) AS hn, SUM(leak) AS leak, COUNT(leak) AS ln,
             /* games and wins at #1–100 rating, then at #101–1000 */
             SUM(CASE WHEN rt >= ${bands.hi} THEN 1 + (w << ${BITS}) WHEN rt >= ${bands.lo} THEN (1 << ${2 * BITS}) + (w << ${3 * BITS}) END) AS bd
             /* per tower troop: games, wins, three-crown wins */
             ${troopIds.map(id => `, SUM(CASE WHEN tt = ${id} THEN 1 + (w << ${BITS}) + (t << ${2 * BITS}) END) AS q${id}`).join('')}
             /* per opponent card: games against it (o) and wins (v) */
             ${full && counters ? chunks.map((ids, j) => `, SUM(${packed(ids)}) AS o${j}, SUM(w * (${packed(ids)})) AS v${j}`).join('') : ''}
      FROM s GROUP BY deck)`;
  const cardsOfG = `
    SELECT 'c' AS kind, j.value AS k, SUM(g.n) AS n, SUM(g.w) AS w, SUM(g.d) AS d, SUM(g.t) AS t, NULL AS p,
           NULL AS dealt, NULL AS taken, NULL AS hn, NULL AS leak, NULL AS ln, NULL AS tr,
           json_array(${[0, 1, 2, 3].map(i => `SUM(${unpack('g.bd', i)})`).join(', ')}) AS bd, NULL AS cn, NULL AS cw
    FROM g, json_each('["' || replace(g.deck, ',', '","') || '"]') AS j GROUP BY j.value`;
  // Tower troops: one row off the deck grouping, its totals packed as JSON so it
  // fits the same columns (and statement) as the decks and cards
  const troopsOfG = troopIds.length ? `
    UNION ALL SELECT 'x', json_object(${troopIds.map(id => `'n${id}', SUM(${unpack(`q${id}`, 0)}), 'w${id}', SUM(${unpack(`q${id}`, 1)}), 't${id}', SUM(${unpack(`q${id}`, 2)})`).join(', ')}),
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM g` : '';
  const troopsOfDeck = troopIds.length ? `json_array(${troopIds.map(id => [0, 1, 2].map(i => unpack(`q${id}`, i)).join(', ')).join(', ')})` : 'NULL';
  // MIN / MAX read one row each off the primary key; match counts come from the
  // card tally (every match is 2 decks × 8 cards) instead of another scan
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT (SELECT MIN(time) FROM matches WHERE time >= ?1) AS first,
                           (SELECT MAX(time) FROM matches) AS last`).bind(since),
    // top decks and every card in one statement, off one grouping
    env.DB.prepare(`${grouped(true)}
      SELECT * FROM (SELECT 'd' AS kind, deck AS k, n, w, d, t, p, dealt, taken, hn, leak, ln, ${troopsOfDeck} AS tr, ${bandsOf('bd')} AS bd,
                            ${counters ? `${cardArray('o')} AS cn, ${cardArray('v')} AS cw` : 'NULL AS cn, NULL AS cw'}
                     FROM g ORDER BY n DESC LIMIT ?3)
      UNION ALL SELECT * FROM (${cardsOfG}) ${troopsOfG}`).bind(since, until, TOP_DECKS),
    ...(havePrev ? [env.DB.prepare(`${grouped(false)} ${cardsOfG}`).bind(prevSince, since)] : []),
  ]);
  const [range, both, prev] = results;
  // Trend lines: each run's card tally (a 7-day window) is that day's point — the
  // day's last run replaces earlier ones. Nothing extra is scanned for it. With
  // no history yet, the previous run's stats seed a first point.
  const stored = await env.DB.batch([
    env.DB.prepare(`SELECT v FROM state WHERE k = 'history'`),
    env.DB.prepare(`SELECT v FROM state WHERE k = 'meta'`),
  ]);
  const hist = JSON.parse(stored[0].results[0]?.v || '{"days":[]}');
  if (!hist.days.length) {
    const old = JSON.parse(stored[1].results[0]?.v || 'null');
    if (old?.cards && dayKey(old.updated) !== dayKey(now)) hist.days.push([old.updated, old.matches, Object.fromEntries(old.cards.map(c => [c[0], c[1]]))]);
  }
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
  const meta = {
    updated: now,
    next: now + refreshEvery(reads, STATS_SHARE),  // when these stats are recomputed
    window_days: WINDOW_DAYS,
    started: +st.started_at || null,  // when collection began; older matches came from the first logs
    matches: count(cards),
    first: t.first ? t.first * 1000 : null,
    last: t.last ? t.last * 1000 : null,
    // [deck key, games, wins, draws, different players, three-crown wins,
    //  avg tower damage dealt, avg taken, avg elixir leaked, games with tower data,
    //  [[tower troop id, games, wins, three-crown wins]], rating bands]
    decks: decks.map(r => [r.k, r.n, r.w, r.d, r.p, r.t, avg(r.dealt, r.hn), avg(r.taken, r.hn), avg(r.leak, r.ln), r.hn || 0,
                           troopsOfRow(r), bandsOfRow(r)]),
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
    prev: prev ? { matches: count(prev.results), cards: prev.results.sort((a, b) => b.n - a.n).map(r => [r.k, r.n, r.w]) } : null,
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
  await countReads(env, 'stats', now, reads, { stats_at: now, meta: JSON.stringify(meta), history: JSON.stringify(hist),
    ...(counterJSON ? { counters: counterJSON } : {}), ...(seed ? { activity: JSON.stringify(act) } : {}) });
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
    /* the player's totals come from the same grouping, so the matches are read once */
    r AS (SELECT tag, deck, n, w, ROW_NUMBER() OVER (PARTITION BY tag ORDER BY n DESC) AS rk,
                 SUM(n) OVER (PARTITION BY tag) AS games, SUM(w) OVER (PARTITION BY tag) AS wins FROM g)
    SELECT p.tag, p.name, p.clan, p.rank, p.rating, r.deck, r.n, r.games, r.wins, r.w
    FROM players p LEFT JOIN r ON r.tag = p.tag AND r.rk = 1
    WHERE p.seen_at >= ?2 ORDER BY p.rank`).bind(since, onBoard).all();
  const reads = rowsRead([res]);
  const top = {
    updated: now,
    next: now + refreshEvery(reads, TOP_SHARE),
    window_days: WINDOW_DAYS,
    // [tag, name, clan, rank, rating, main deck key, games with it, ranked games, wins, wins with the main deck]
    players: res.results.map(r => [r.tag, r.name, r.clan, r.rank, r.rating, r.deck, r.n || 0, r.games || 0, r.wins || 0, r.w || 0]),
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
  const { results } = await env.DB.prepare(`SELECT k, v FROM state WHERE k NOT IN ('meta', 'top', 'history', 'counters')`).all();
  return Object.fromEntries(results.map(r => [r.k, r.v]));
}
async function setState(env, values) {
  await env.DB.prepare(`
    INSERT INTO state (k, v) SELECT key, value FROM json_each(?1) WHERE true
    ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(values)).run();
}
