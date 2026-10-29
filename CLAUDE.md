# Max Royale — Project Handoff

## What this project is
A standalone single-file web app (`index.html`) for Clash Royale players. It replaces a Replit-hosted Node.js/Express backend + Android app. No build step, no dependencies, no server needed. Deployed to GitHub Pages.

**Live URL:** `https://jellybean2560.github.io/Max-Royale/`
**GitHub repo:** `https://github.com/Jellybean2560/Max-Royale`

---

## Tech stack
- Pure HTML + CSS + vanilla JS, single file (`index.html`)
- Fonts: Google Fonts — Rajdhani (headings), Inter (body)
- Themes: dark (the `:root` variables) and light (`:root[data-theme="light"]`, and under `prefers-color-scheme: light` unless `data-theme="dark"`). Auto / Light / Dark in the Accounts menu (`setTheme()`, `cr_theme`, set before first paint by the script in `<head>`). Use the variables (incl. `--badge-*` backgrounds) — a hardcoded dark colour breaks the light theme
- No npm, no framework, no build step
- API calls go through a **Cloudflare Worker** (`https://quiet-frost-f9f0.jellevandenwouwer.workers.dev`) that holds the Clash Royale API key server-side and adds CORS headers. The browser sends **no** auth header and needs no key.
- Installable PWA — `manifest.json` (with `shortcuts`: long-press the icon for Meta / Calculator / Friends / Clan, opened as `?screen=<name>` by `takeStartScreen()`) + `sw.js` (shell cache `max-royale-v6`, bump to force a shell refresh; card art in `max-royale-img-v1`, which survives app updates — see *Image cache*)
- GitHub Actions workflow (`.github/workflows/deploy.yml`) auto-deploys to GitHub Pages on every push to `main`

---

## Files in the repo

```
index.html                        ← entire app (HTML + CSS + JS)
manifest.json                     ← PWA manifest (scope /Max-Royale/)
sw.js                             ← service worker, offline app shell
icon.png / icon.svg               ← PWA icons
cards-icon.webp                   ← section icons used in the UI
evo-hero-icon.webp
tower-troop-icon.webp
.github/workflows/deploy.yml      ← GitHub Pages auto-deploy workflow
README.md                         ← setup instructions
collector/                        ← meta collector Worker (not part of the app; see *Meta collector*)
```

---

## Data sources
- **Official Clash Royale API** (`https://api.clashroyale.com/v1`), reached via the Cloudflare Worker above. The underlying key is IP-locked to RoyaleAPI's proxy IP `45.79.218.79`, which is why it works from any network.
- **`RoyaleAPI/cr-api-assets`** (GitHub raw) — clan badge images, mapped by `CLAN_BADGES` in `clanBadgeUrl()`.
- **`RoyaleAPI/cr-api-data`** — *not* fetched at runtime. Used offline as the reference for Supercell's internal card names (`sc_key`) when building `MASTERY_NAME_OVERRIDES`.
- **No third-party live data API** — RoyaleAPI shut down their public developer API in March 2020.
- **Card upgrade data** is hardcoded in JS based on the official wiki (levels 1–16, all 5 rarities).

---

## App structure — screens (bottom nav)

| Nav item     | Screen ID        | Description |
|--------------|------------------|-------------|
| Player       | `screen-lookup`  | Player profile. A compact header (name ▾, trophies, refresh; King/CL/league line) sits above the tabs; tapping the name opens the Accounts menu (switch, edit, add/look up by tag). The tag box (`#lookup-start`) only shows with no profile on screen: first run or a failed lookup. On a war day, a note under the header says how many war decks the loaded profile has left today (`warReminder()`, from their clan's `/currentriverrace` via `loadClanWar`; the day's end is a guess, `WAR_DAY_END_UTC` ≈ 09:45 UTC); tap → `openClanWar()`, the Clan screen's River Race tab. Profile only, not the modal. Under it, an upgrade-ready note (`readyNote()`, `cr_ready_v1`: per tag the ready-to-upgrade card ids now and before the set last changed) lists cards that became ready since last time — tap → Cards filtered Upgradable, ✕ dismisses |
| Calculator   | `screen-calc`    | Offline upgrade cost calculator with card picker; a Calculator / Drop Rates switch (`setCalcView()`). **Drop Rates** (`renderDropRates()`): Supercell's published chest odds for the loaded profile's arena — see *Drop rates* |
| Deck Upgrade | `screen-deckup`  | Cost to upgrade a whole 8-card deck; the current 1v1 and 2v2 decks are the first choices (1v1 is the default). **⚖️ Compare** (`deckCompareHTML()`): two of the decks in use, tracked decks and saved decks side by side — elixir, archetype (`META_WIN_CONS`), your record, top players' record with the exact deck (from the cached `/meta`), your average level, gold to the target, cards not unlocked; the better side in green. Custom Deck takes a pasted deck link (the game's share link or a RoyaleAPI deck URL); a deck shared to the installed app (manifest `share_target`) opens here too. **⭐ Saved** (`savedDecksHTML()`): decks starred with ☆ (`starBtnHTML()` — Decks tab, profile modal's Decks tab and Meta decks) in `cr_saved_decks` (max 40, cards in slot order with forms, where it came from), with Copy Deck, Upgrade Cost and remove; cards you haven't unlocked are named |
| Meta         | `screen-meta`    | Top-player stats from the meta collector (`META_URL` → `/meta`), five views. **Decks**: top 300, 30 at a time (Show more), search by card names — several separated by `,` or `+` find decks with all of them (e.g. to finish a half-built deck); a full card name matches that card only ("Giant" not Goblin Giant), anything else is a substring (only `#meta-list` re-renders, so the box keeps focus), sort most played / best win rate / most 3-crown wins (10+ games); each shows share, games, avg elixir, 3-crown wins, players, win rate, average tower damage dealt / taken and elixir leaked per game (`metaTowersLineHTML()`, "from N of M games" while older games lack it), Copy Deck + Upgrade Cost, and a fold-out (`toggleMetaDeck()` / `metaDeckMoreHTML()`, open keys in `_metaDeckOpen`, works wherever a deck item shows): its record per tower troop, per rating band (`#1–100 level` / `#101–1000` / lower, a rate from 10+ games), its 5 hardest and easiest opponent cards from `/counters` (cards in 4%+ of its games, 8+) and the top players whose main deck it is (from `/top`; both fetched when first needed). **Cards**: share of decks + win rate per form, filter All / Evolutions / Heroes, sort most used / win rate / 3-crown rate (2%+ of decks) / Trending (share change vs the week before — only offered once `/meta` has `prev`). **Stats** (`metaStatsHTML()`): popularity vs win rate scatter, one dot per card form in 1%+ of decks (tap → readout + Decks →); Archetypes — share and win rate per win condition (`META_WIN_CONS`, from the card tally, so over all decks; tap → its decks); Archetype matchups (`metaArchMatchupsHTML()`) — a grid of the 8 most played win conditions, row decks' win rate against decks with the column's card, from `/counters` (· under 30 games; tap a cell for the readout); Counters (`metaCountersHTML()`) — pick a card: the opponent cards that win most / least against decks with it, summed over the `/counters` decks holding it (`cr_meta_counters_cache`, 30 min); Card pairs (`metaPairsHTML()`) — a card's most common partners and their win rate together, plus the best-winning pairs overall, worked out in the app from the top 300 decks; Win rate by rating (`metaRatingHTML()`) — cards that win more / less at #1–100 rating than below it (cards in 2%+ of decks, 50+ games each side); Tower troops (`metaTroopsHTML()`) — pick rate, 3-crown rate and win rate per tower troop; Elixir curve — games and win rate by average elixir, from the top 300 decks only (the only decks with a known cost; the card says what share of decks that covers); When top players play (`metaActivityHTML()`) — matches per hour of the day and per weekday in local time, from `/meta`'s hourly tally (full UTC days from the day after collection began); Card trends — a card's share of decks, or (Win rate toggle, `setMetaTrendMode()`) the win rate of decks with it, per day from the collector's `/history` (`cr_meta_history_cache`, 30 min), starting on the card that moved most; Evo vs Hero vs plain — per card, each form's share of its games and win rate (forms with 30+ games and 2%+ of the card's games; 10 shown, Show all); Month vs month (`metaMonthHTML()`, `_metaMonthMode`) — the last 4 weeks against the 4 before, biggest changes in share or win rate, from `/history` points a week apart (each a 7-day tally, so four add up to 28 days; ready about 24 Nov 2026). **Players**: a picker (`setMetaCountry()`, saved in `cr_meta_country`; game-mode boards are `lb:<id>` and show score, global PoL rank and where your accounts / friends stand (`metaModeRankHTML()`), no deck; first time, the loaded profile's clan's country when the Clan screen has that clan cached) between the global top 1,000 and a country's Path of Legends leaderboard straight from the API (`metaCountryHTML()`: `/locations/{id}/pathoflegend/players?limit=1000`, kept 30 min in memory; country list from `/locations` in `cr_locations_cache`, 30 days) — rank, rating, clan, plus global rank, record and main deck for players in `/top`, and where the loaded profile stands in that country; a country without a board says so. The global list: the top 1,000 from `/top` (fetched when the view opens, ~190 KB, cached in `cr_meta_top_cache`): rank, rating, clan, ranked games and win rate, and their main deck (most played ranked deck in the window); search by player or clan name, sort Rank / Climbing today / Climbing this week / Falling this week (rating against the collector's daily leaderboard snapshot, ▲▼ shown next to the rating; `new` = not on the board a day ago), 30 at a time, your accounts / saved friends labelled, tap → profile modal; on top, where the loaded profile stands (`metaYourRankHTML()`: its rank if listed, else where its Ultimate Champion rating would place it or how far below the #1000 cutoff it is — only league 7 has a rating). **You**: the loaded profile's 1v1 deck card by card against the meta (exact-deck stats if top players run it; `currentDeck` a card short is completed from the latest 1v1 battle holding the rest), your games with those eight cards from the battle log against the top players' (`metaYourGamesHTML()`: win rate, 3-crown wins, elixir leaked, and tower damage from Path of Legends games only — elsewhere tower HP depends on your levels; against the exact deck, else all top decks), One-card swaps (`metaSwapsHTML()`: top decks with seven of your cards, grouped by the swap, 20+ games, win rate and the change against your eight cards' own record with top players; tap → Decks searched for that deck's cards), your deck's hardest matchups (`metaYourCountersHTML()`: the 8 opponent cards top players with your eight cards — any forms — lose to most, from `/counters`, next to your own record against them from `cr_matchups_v1`, over all your decks), the 3 closest top decks with the swap, the 5 best top decks for your cards (`bestDecksForYouHTML()`: winning decks with 20+ games whose cards you've all unlocked, ranked by evo/hero forms you lack, then gold to bring every card to your current deck's average level, then win rate; one per card set), the 10 most-used top cards the player hasn't maxed (gold to max; tap → Calculator), and the Deck finisher (`deckFinisherHTML()`: pick up to 4 cards, `_finishIds`; top decks with 10+ games holding them all in any form, ranked by cards not unlocked, evo / hero forms lacking, gold to bring the rest to your picks' highest level, then win rate; only `#finish-sugg` / `#finish-box` redraw). Cached in `cr_meta_cache`, refetched after 30 min; decoded once per `/meta` (`metaParsed()`) |
| Clan         | `screen-clan`    | A Clan / Tournament switch (`setClanView()`). **Tournament**: a tag opens it (`openTournament()`: status, time left, players, type, level cap, length, creator, standings — tap a player to open them); anything else searches open tournaments by name (`/tournaments?name=`, private ones are only found by tag). Tournament battles in the battle log link to it from their details (`b.tournamentTag`). **Clan**: lookup by tag; tabs Members (sortable), River Race (live standings — tap a rival clan to scout it (`rivalScoutHTML()`: decks used today and this week by its players who took part, top attackers, Open → `openClanWar()`) — a Forecast on war days — see *River Race forecast* — and each member's decks used today), War History (War MVPs on top — `warMvpHTML()`: current members by average fame per race played, fame per deck, last 3 races vs the ones before, most improved — then the last 10 races, fold-out standings + member contributions). **Clan tools** (`cr_clan_tools`, all off by default, switched on in the 🛠 panel under the clan header): Decks Left Today on River Race (war days only, copyable list), War Participation on War History (decks used / 16 per race each member was in, over the last 10), Inactive members on Members (💤 marks from a user-set number of days away — `awayAfter`, default 3, typed under the switch, 1–180; red at twice that — and an away filter N+ / 2N+ / 4N+). Clan screen only — the profile modal's Clan tab doesn't use them |
| Friends      | `screen-friends` | Up to 50 saved friends (`MAX_FRIENDS`) with trophies, clan and last battle, sortable (last played / trophies / name / added) + Suggested Friends; on top, What's new (`friendsFeedHTML()`: friends' upgrades, unlocks, King Tower, league, rating and trophy milestones and clan changes over 14 days, from consecutive Progress snapshots of them); the profile modal (also opened for clan members) has the same tabs as the profile plus Compare |

There is no `screen-home`; the app opens on the Player screen.

---

## Player profile — tabs (after loading a player tag)

| Tab          | ID                 | Data source |
|--------------|--------------------|-------------|
| Overview     | `tab-overview`     | `/players/{tag}` — card insights, collection level, suggested upgrades, upgrade planner, Gold Budget (`goldBudgetHTML()` / `goldBudgetPlan()`: the gold you have — remembered in `cr_budget_gold` — spent one level at a time on cards with enough copies; focus current deck / a saved deck (lowest card first) or most collection levels (cheapest first)). Card Insights numbers (›) open the list they count via `ovGo()`: Cards filtered by status (rarity/search cleared, so the count matches), Tower Troops, Evolutions/Heroes on Unlocked |
| Cards        | `tab-cards`        | `/players/{tag}` + `/cards` — full collection with filters (status, rarity, level, sort); cards not yet unlocked are synthesised from the catalog and shown greyed out at the bottom |
| Evolutions   | `tab-evolutions`   | `/cards` catalog filtered by `hasEvoForm()`, matched against player cards with `ownsEvo()` (see *Evolution / hero slots*) |
| Heroes       | `tab-heroes`       | `/cards` catalog filtered by `hasHeroForm()`, owned via `ownsHero()` |
| Tower Troops | `tab-towerTroops`  | `data.supportCards` from `/players/{tag}` |
| Decks        | `tab-decks`        | Battle log + persisted history — the equipped 1v1 deck is listed even with no games yet (`equippedDeckEntry()`, "No games with it yet", no delete) — W/L/D per unique deck (card set + which cards were played as evo/hero), last played, sort (most played — decks in use pinned first, marked "In use · 1v1" / "· 2v2" — / best win rate, 3+ games first / recently played), mode filter, Copy Deck + Upgrade Cost (opens it as a custom deck in Deck Upgrade, costed with *your* cards — also from a friend's deck), delete |
| Battles      | `tab-battles`      | Toggle between **Battle Log** (`/battlelog` — grouped by day with a W/L/trophy summary per day, Wins/Losses toggle + mode filter; every player name except the log's owner opens their profile; decks with evo/hero tiles and average elixir (💧), crowns, trophy change; each battle folds out details: towers left, elixir leaked, trophies, global rank, tower troop, clan, boat stats; 2v2 also the opponents' decks) and **Battle Stats** (lifetime W/L, streak, est. playtime, recent W/L per mode, Opponent Cards — toughest / best-against cards, Against Archetypes (`archetypeRecordHTML()`: the Opponent Cards tally read for `META_WIN_CONS`), Level Advantage (`levelAdvantageHTML()`: W/L with higher / even / lower average card level than the opponent, ±0.5, 1v1 Trophy Road and Path of Legends only, kept as `lv` in `cr_matchups_v1`), Momentum (`momentumHTML()`: win rate in the next game within 30 min after a win vs after a loss, from the log), When You Play Best (`playTimesHTML()`: win rate per 4-hour block and weekday, local time, from `cr_play_v1`), Path of Legends, old trophy road, challenges). With 3+ losses in a row the Battle Log opens with a note (`streakNoteHTML()`) |
| Badges       | `tab-badges`       | `data.badges` — earned badges + synthesised locked card masteries; sort Most progress / Closest to next level (`badgeNextShare()`); achievements show progress / target, bars turn green at 90%+ |
| Account      | `tab-account`      | Progress card on top (see *Progress*), Goals (`goalsHTML()`: per tag in `cr_goals_v1`, max 12 — trophies, ranked rating (counts from Ultimate Champion), King Tower / collection / XP level, a card's level; progress bar from the value when set, what's left, a card's cards + gold to go via `computeUpgrade`, and an ETA from the last week's pace in the Progress snapshots), Season recap (see *Season recap*), Trophy History graph (see *Trophy history*), then `/players/{tag}` — XP level, account age, star points, favourite card, Collection (found / total per kind — cards, evolutions, heroes, tower troops — via `cardsFoundCounts()`); tapping the Cards count folds out a bar chart of cards per level split by rarity (`cardLevelChartHTML()`); tapping a bar opens Cards filtered to that level (`openCardsAtLevel()`), donations, clan wars |

The friend/clan-member modal has the same tab set (`data-ftab`): Overview, Compare, Cards, Evolutions, Heroes, Tower Troops, Decks, Battles, Badges, Account, Clan. **Clan** (only when they're in a clan you aren't already looking at — not your own clan, the clan on the Clan screen you opened them from, or the clan of the modal profile you came from; `showClanTab()`) shows the clan header and members — tap one to open them — and a button into the Clan screen for River Race / War History. **Compare** (only when a profile is loaded and it's someone else) opens with **Head-to-Head** (see *Suggested friends*), then puts the loaded profile next to them: account stats with the higher value highlighted, then every card's level, filterable by who's ahead. Its Decks tab keeps their deck W/L history on this device like yours (same `cr_deck_history_v1`, under their tag, with delete); its battle details label the sides by name instead of "You".

**Profile/modal parity (user rule):** every change to a profile tab goes into the modal's copy of that tab too — friends, clan members and anyone else opened there — unless it truly can't apply (e.g. deleting from your own deck history). That includes on-device history: `recordHistory(data, battles, at)` records Progress, Trophy History, Opponent Cards and deck history for the loaded profile (`loadPlayer`, cached render), every profile opened in the modal (`viewFriend`) and every friend the Friends list refreshes (`refreshFriendStats`). `pruneHistoryTags()` keeps those four stores to your accounts, saved friends, the loaded profile and the 10 (`HISTORY_OTHERS`) most recently seen others.

**Modal history:** every profile opened in the modal pushes a history entry (`_modalStack`, `state.modal` = depth, plus `state.modalSession` — entries left over from an earlier page load, e.g. an update reload with a profile open, count as depth 0 via `modalDepth()`), so Android Back / the ← button steps back through profiles (restoring the tab each was on, from `_modalProfiles` without refetching) and finally closes the modal instead of leaving the app. `closeFriendModal()` unwinds those entries; `hideFriendModal()` is the actual close — don't hide the modal any other way or the history gets out of step.

**Friends list stats:** each saved friend in `cr_friends` carries a snapshot (`trophies`, `clan`, `lastBattle`, `statsAt`). Opening the Friends screen refreshes snapshots older than 15 min, four requests at a time (`refreshFriendStats()`); 🔄 refreshes all; opening a friend's profile updates theirs.

**Header age:** the profile header's info line ends in "updated 12 min ago" (`updateProfileAge()`, ticks every 30 s, gold after an hour, "↻ updating…" during a quiet refresh). It reads `window._currentProfile.savedAt`.

**Backup:** the Accounts menu (and the start card, for a fresh device) saves / restores one JSON file of `BACKUP_KEYS` — accounts, friends, deck history, matchups, co-players, trophy history, progress snapshots, clan tool switches, play tally, goals, saved decks. Caches are left out. With the ⚙️ on, the menu also exports the loaded profile as CSV (`exportCSV()`: battle log, deck history, opponent cards) — semicolons and decimal commas when the device's locale writes `1,5`, else commas and points (`CSV_SEP`), with a BOM. Restoring replaces those keys and reloads the profile.

**Suggested friends:** the API has no friends list. `recordCoPlayers()` accumulates who you play *with* per profile tag (`cr_coplayers_v1`, deduped by `battleTime`); a 2v2 teammate seen in 2+ games or anyone from a Friendly battle is suggested (random matchmade teammates almost never repeat). Saved friends, your accounts and dismissed players are left out. `viewFriend()` also fetches the friend's battle log, for the Overview's recent-battle stats and head-to-head (a failure there is ignored).

**Head-to-head:** `recordCoPlayers()` also keeps `[wins, losses, draws]` per co-player — `vs` (friendly battles against them) and `tm` (any battle on your side, i.e. 2v2 together) — deduped by its own `hseen` list, so battles counted before results existed still got tallied once. It's fed from your log *and* from friends' logs (`viewFriend`, `refreshFriendStats`): any log with the loaded profile's tag in it, same `battleTime` dedupe. `headToHead(tag)` reads it for the loaded profile; shown on the modal's Compare tab (`headToHeadHTML`) and as "⚔️ 5–3 · 🤝 12–8" in the Friends list (`h2hLine`). Saved friends are exempt from the 300-co-player cap.

---

## Key JS functions

| Function | What it does |
|---|---|
| `apiGet(path)` | Fetches `<worker>{path}`; no auth header. Retries a 5xx twice (the proxy chain hiccups with nginx 500s and Cloudflare 52x), then throws a friendly message |
| `normalizeTag(raw)` | Uppercases, strips spaces/`#`, O→0 — the API 404s on lowercase tags. Every tag input goes through it |
| `loadPlayer(tagOverride, opts)` | Fetches `/players/{tag}`, `/battlelog` and the card catalog in parallel, calls `renderProfile()`. `opts.quiet` refreshes in place: no spinner, keeps the active tab, keeps the old view on error. A failed lookup puts the previous profile back with the error above it, and `cr_player_tag` is only written on success — a mistyped tag must never become the account the app reopens on |
| `lookupErrorText(e, what, tag)` | "No player/clan found with tag …" for a 404 (`apiGet` errors carry `.status`), the real message otherwise |
| `isInstalledApp()` | True when launched as an installed PWA rather than a browser tab |
| `autoRefreshProfile()` | Installed-app background refresh of the cached profile, throttled to 2 min |
| `renderProfile(data, battles)` | Renders the header + every profile tab |
| `renderOverview(data, battles)` | Account + battle stats, card insights, collection level — shared by the profile and friend Overview |
| `accountStatsHTML()` / `battleStatsHTML()` | The Overview's Account and Battle Stats cards |
| `makePlanCtx(scope, data, decks)` / `planDeckOptions()` | Per-Overview state for Suggested Upgrades + Upgrade Planner (`'p'` profile, `'f'` friend modal) |
| `syncClanToProfile(data, opts)` | Clan screen follows the loaded profile's clan unless the user looked up another one |
| `polLeagueName(r)` / `polLeagueDetail(r)` / `polLeagueText(r)` | Path of Legends season result → league name, rank/trophies |
| `renderCardsPane(data)` / `renderCards()` | Card collection pane; `renderCards()` re-renders on filter/sort change |
| `renderEvolutionsPane()` / `loadEvolutionsGrid()` | Evolutions tab (lazy-loaded on tab click) |
| `renderHeroesPane()` / `loadHeroesGrid()` | Heroes tab (lazy) |
| `renderTowerTroopsPane(data)` / `loadTowerTroopsGrid()` | Tower troops tab (lazy) |
| `renderBadgesPane(data)` / `loadBadgesGrid()` | Badges tab (lazy); builds earned + locked-mastery entries |
| `_masteryCardFor(badgeName)` | Maps a `Mastery<InternalName>` badge to its catalog card |
| `setBadgeFilter(val)` | Badge filter: `all` / `mastery` / `other` |
| `renderBattles(battles, data, scope)` / `setBattleView(scope, v)` / `setBattleFilter(scope, mode)` | Battles tab: log/stats toggle + mode filter; state in `_battleState[scope]` |
| `renderDeckBuilder(battles, data, scope)` / `setDeckFilter(scope, mode)` | Decks tab; state in `_deckState[scope]` |
| `recordCoPlayers(tag, battles)` / `suggestedFriendsHTML()` | Suggested friends from 2v2 teammates and friendly battles |
| `battleDetailsHTML(b, team, opp)` | A battle's fold-out details table |
| `recordMatchups(tag, battles)` / `matchupsHTML(data, battles, scope)` | Win rate per opponent card (`cr_matchups_v1`); saved for every profile seen (`recordHistory`), falling back to the current log |
| `recordTrophies(data, battles, at)` / `trophyHistoryHTML(data, battles, scope)` / `setTrophySeries()` / `setTrophyRange()` | Trophy History card; state per scope in `_trophyState` |
| `profileLevels(data)` | King level, collection level, evolution and hero counts |
| `compareHTML(me, them)` / `setCompareFilter(v)` | Friend modal Compare tab |
| `friendClanTab()` / `clanHeaderHTML(data)` / `memberRowsHTML(members, sort, highlightTag)` | Friend modal Clan tab; header and member rows shared with the Clan screen |
| `refreshFriendStats(force)` / `saveFriendStats()` / `sortedFriends()` | Friends list snapshots and sorting |
| `parseDeckLinkIds(text)` / `importDeckLink(text)` / `takeSharedDeck()` | Deck links into Deck Upgrade's Custom Deck; shared decks on launch |
| `exportBackup()` / `importBackup(input)` | Backup file |
| `updateProfileAge()` | The header's "updated X ago" |
| `currentDeckKey(data, battles)` / `currentDeckVariants()` / `latest2v2Deck()` | Keys of the decks in use, for the "In use · 1v1 / 2v2" marks |
| `renderSavedAccounts()` / `menuLookup()` / `showLookupStart(on)` | Accounts menu (opened from the header name) and the start card's account chips |
| `clanTab(name)` / `loadClanWar(tag)` / `riverRaceHTML()` / `warHistoryHTML()` | Clan screen tabs; war data fetched on tab open, cached 1 min per clan |
| `buildDeckMapFromBattles(battles, playerTag)` | Merges new battles into persisted deck history, returns the deck map |
| `cardVariant(c)` / `deckKeyOf(cards)` | Battle-log card → `'evo'` / `'hero'` / `''`; deck identity including those forms |
| `buildCardArtMap(battles)` / `deckTileHTML(name, variant, art, cls)` | Card art (plain/evo/hero) by name; one deck tile with evo/hero ring + tag and art fallback |
| `loadDeckHistory(tag)` / `saveDeckHistory(tag, h)` | Per-tag deck W/L history in `localStorage` |
| `deleteDeck(key)` | Removes one deck + its history (confirm prompt) |
| `copyDeckLink(names, btn)` | Opens the deck via Supercell's `link.clashroyale.com` deep link; clipboard fallback |
| `renderUpgradePlanner(data, battles)` | "Suggested upgrades", scoped by account or deck |
| `renderDeckUpgradeScreen()` / `buildDeckUpSuggestions()` | Deck Upgrade screen |
| `maybeLoadCards()` | Fetches `/cards` once into `allCards`, cached in `localStorage` with monthly expiry; a cache hit is revalidated in the background |
| `revalidateCards()` | Background `/cards` refresh; redraws the profile only if the catalog actually changed |
| `redrawForCatalogChange()` | Re-renders the open profile in place, keeping the active tab |
| `_firstTuesdayOfMonth()` / `_mostRecentMonthlyCacheCutoff()` | Card-cache expiry timed to CR's monthly update |
| `loadClan()` / `renderClan(data)` / `renderMembers()` / `setClanSort(by)` | Clan screen. `refreshClanIfStale()` refetches the shown clan in place when the screen opens and it's over 10 min old (`_clanShownAt`) — the cached clan at startup can be days old, which made Last Seen and the away marks wrong |
| `renderFriends()` / `addFriend()` / `viewFriend(tag)` / `friendTab(name)` | Friends screen |
| `computeUpgrade(rarity, level, count, target)` | Core upgrade math |
| `toDisplayLevel(rarity, apiLevel)` | Converts API relative level → display level (1–16) |
| `openInCalculator(cardId, scope)` | A card's fold-out button: loads it into the Calculator (switching off Drop Rates) at the player's level and count — scope `'f'` uses the modal's player ("Loaded Jelle's …") and closes the modal |
| `goTo(name)` / `switchTab(name)` | Screen / tab switching. `switchTab` owns pane visibility and lazy loads — every path that shows a profile tab must go through it. `goTo` remembers each screen's scroll position; re-tapping the active bottom button scrolls to the top |
| `revealTab(btn)` / `updateTabFade(bar)` / `attachTabSwipe()` | Keep the selected tab fully in view, edge fades on tab bars, swipe between profile tabs |
| `formatBattleTime(ts)` | API timestamp → relative time ("2h ago") |

---

## API endpoints used

| Endpoint | Used for |
|---|---|
| `GET /players/{tag}` | Profile, cards, support cards, badges, stats |
| `GET /players/{tag}/battlelog` | Recent battles |
| `GET /clans/{tag}` | Clan info + member list |
| `GET /cards` | Full catalog — `items` (deck cards) and `supportItems` (tower troops) |
| `GET /clans/{tag}/currentriverrace` | Live River Race: the 5 clans' fame, our participants (`decksUsedToday` max 4, `decksUsed`, `fame`, `boatAttacks`). Members who haven't played have no entry at all |
| `GET /locations` | Country list for Meta → Players |
| `GET /locations/{id}/pathoflegend/players` | A country's Path of Legends leaderboard (Meta → Players). Continents answer 404 "Rankings not found"; a country's board lists its Ultimate Champion players (Belgium: 677, Oct 2026) |
| `GET /leaderboards` / `/leaderboard/{id}` | Game-mode boards in Meta → Players (2v2 League, Merge Tactics, Touchdown, Mega Draft, …: `[tag, name, rank, score, clan]`). The list holds past seasons of the same mode too and many unnamed boards; the app keeps the highest id per name (`loadLeaderboards()`, `cr_leaderboards_cache`, a day) |
| `GET /tournaments/{tag}` / `/tournaments?name=` | Tournament lookup on the Clan screen. Detail has `membersList` (rank, score = wins, clan), `startedTime`; search results don't have `startedTime` |
| `GET /clans/{tag}/riverracelog` | Past races: per race all 5 clans' rank, trophy change, fame and participants |

### Endpoints available but NOT yet implemented

| Endpoint | Could be used for |
|---|---|
| `GET /locations/{id}/rankings/clans` | Clan leaderboard |
| `GET /locations/{id}/rankings/clanwars` | Clan war leaderboard |

> `GET /locations/{id}/rankings/players` returned an empty `items` array when tested (Aug 2026) — likely season-dependent. Prefer the `pathoflegend` variant.
>
> Dead ends (Oct 2026): `/clans/{tag}/warlog` is "temporarily disabled" by Supercell (use `riverracelog`), `/challenges` 404s, `/globaltournaments` is empty, and `/players/{tag}/upcomingchests` still answers with chest names although chests are gone from the game.

---

## localStorage keys

| Key | Holds |
|---|---|
| `cr_player_tag` | Last successfully loaded player tag |
| `cr_saved_accounts` | Saved account list (name + tag) |
| `cr_friends` | Saved friends (max 50): `{ tag, name, trophies, clan, lastBattle, statsAt }` |
| `cr_friends_sort` | Friends list sort: `recent` / `trophies` / `name` / `added` |
| `cr_profile_cache` | Last profile + battles, for instant render on open |
| `cr_clan_cache` | Last clan lookup |
| `cr_cards_cache_v7` | `{ items, savedAt }` card catalog, monthly expiry + background revalidation |
| `cr_meta_top_cache` | `{ data, savedAt }` — the last `/top` (the Meta screen's Players view) |
| `cr_meta_counters_cache` | `{ data, savedAt }` — the last `/counters` (deck fold-outs, Stats → Counters), refetched after 30 min |
| `cr_play_v1` | Per-tag play tally: `{ seen, hours: [24 × [w,l,d]] (local), days: [7 × [w,l,d]] (getDay), seasons: { 'YYYY-MM-DD' start: { first, g, r (ranked), peak, three, decks: { deck key: [w,l,d] }, opp: { card: [w,l,d] } } } }`, last 4 seasons; friendlies and boat battles skipped. Tags kept by `pruneHistoryTags()` |
| `cr_goals_v1` | Per-tag goals: `[{ type, target, card?, from, at }]` |
| `cr_saved_decks` | Saved decks: `[{ key, cards: [{ name, form }], from, at }]`, newest first |
| `cr_budget_gold` | The Gold Budget amount last typed |
| `cr_leaderboards_cache` | `{ items: [{ id, name }], savedAt }` — newest board per game mode |
| `cr_meta_country` | Meta → Players board: a location id, `''` = global top 1,000 |
| `cr_locations_cache` | `{ items: [{ id, name, countryCode }], savedAt }` — countries from `/locations`, 30 days |
| `cr_meta_history_cache` | `{ data, savedAt }` — the last `/history` (Meta → Stats → Card trends), refetched after 30 min |
| `cr_meta_cache` | `{ data, savedAt }` — the last `/meta` from the collector, so the Meta screen opens instantly and offline; refetched after 30 min or once `data.next` has passed (`metaStale()`) |
| `cr_coplayers_v1` | Per-tag co-players for Suggested Friends and head-to-head: `{ seen, hseen, players: { tag: { name, clan, mates, friendlies, last, vs: [w,l,d], tm: [w,l,d] } }, dismissed }` |
| `cr_matchups_v1` | Per-tag opponent-card tally: `{ since, at, battles, seen, cards: { name: [wins, losses, draws] }, lv: { seen, n, sum, ahead, even, behind } }` (`lv`: level advantage, its own seen list so battles tallied before it existed count once); friendlies and boat battles skipped. Tags kept by `pruneHistoryTags()` |
| `cr_trophy_history_v1` | Per-tag `{ road: [[ms, trophies]], pol: [[ms, rating]] }`, oldest first, max 1000 points per series. Tags kept by `pruneHistoryTags()` |
| `cr_progress_v1` | Per-tag list of compact profile snapshots for the Progress card, oldest first; after the first, `d: 1` snapshots hold only the cards/troops that changed — see *Progress*. Tags kept by `pruneHistoryTags()` |
| `cr_clan_tools` | `{ decksLeft, participation, inactive }` booleans for the optional Clan tools, plus `awayAfter` (days before the inactive mark, 1–`AWAY_MAX` = 180) |
| `cr_deck_history_v1` | Per-tag deck W/L/D history (+ `last` played battleTime, `at` last saved), deduped by `battleTime`; tags kept by `pruneHistoryTags()`. Keys are sorted names with `[evo]`/`[hero]` suffixes; entries without `variants` predate that and are adopted by the first matching card set played again |

---

## Meta collector (`collector/`)
A separate Cloudflare Worker, **`max-royale-meta`** (`https://max-royale-meta.jellevandenwouwer.workers.dev`), with a D1 database `max-royale-meta`. It collects the **ranked (Path of Legends) matches of the global top 1,000** so the app can show top-player deck and card win rates — data no public API offers. Deploy with `cd collector && npx wrangler deploy` (wrangler is logged in on this PC); nothing deploys on push. Schema: `collector/schema.sql` (`npx wrangler d1 execute max-royale-meta --remote --file=schema.sql`).

- **API access:** through a *service binding* to the app's proxy Worker `quiet-frost-f9f0` (`env.CR.fetch('https://cr/<path>')`), so the collector never holds the API key. A plain fetch of the proxy's workers.dev URL from another Worker on the same account would fail.
- **Schedule:** a cron every minute; each run does one job — leaderboard refresh (every 6 h), stats and top players' main decks (as often as their cost allows: every 24 h × last run's reads / their daily share — 1.1M stats, 0.45M top — kept within 1–24 h; `/meta` and `/top` carry `next`), prune (daily, matches > 30 days), else poll the 5 most overdue players' battle logs. A job is scheduled off its last *attempt* (`<job>_try_at`) as well as its last success, so a failing one retries every 30 min, not every minute — a stats run reads ~400k rows, so retrying it each minute would exhaust the free 5M reads within the hour. A failed battle log is retried after 30 min, not 12 h; the proxy chain throws the occasional 520. A player is polled again at half the time their last 30 battles span (all modes fill the log), clamped to 30 min – 12 h, so their log can't roll over unseen.
- **Storage:** `matches` holds one row per ranked match (kept 90 days — `KEEP_DAYS`; only storage, the stats read a 7-day window), `WITHOUT ROWID` with key `(time, both tags sorted)` — that dedupes a match between two top players and doubles as the time index. Decks are sorted card ids with `e` / `h` for a card played as evolution / hero. Since 28 Oct 2026 each side also has its tower troop id (`ta`/`tb`), king tower HP left (`ka`/`kb`, 0 = destroyed), princess towers' HP left summed (`sa`/`sb`) and elixir leaked (`la`/`lb`); older rows have nulls.
- **Tower damage:** full HP minus what's left. King HP in ranked is 7,728; a princess pair's full HP depends on the tower troop, so `computeStats` learns it per troop as the highest left standing in the newest `TOWER_SAMPLE` (3,000) matches — reading them costs 3,000 rows — never below the last run's (`meta.towers`). The troop ids and HP go into the SQL as a `CASE` (numbers only): a `json_each` lookup per row would count as rows read. Tower troop totals come out of the same deck grouping (per-troop `SUM`s packed into one `json_object` row), so the new figures cost no extra scan — checked: 403,811 rows read before and after. Troop names and art come from the battle logs into `state.troop_names`.
- **Counters, rating bands, troops per deck:** computed in the same grouping, at no extra rows read (checked on a 3-hour window: 6,394 rows vs 6,376 for the old query). D1 allows **100 columns in a result (a CTE too) and 127 arguments to a function** — tested — so per-deck counts are packed four to an integer column, 15 bits each (`BITS`, a deck stays far below 32,767 games a week), and unpacked with shifts in the final select. Each top deck of *last* run (`oldMeta.decks`, keys checked against `^[0-9eh,]+$` before going into the SQL) gets its opponent's deck as `cx`; per card id seen, `instr(cx, ',<id>')` counts games against it and wins — a json_each per match would cost ~1M rows. The statement is ~64 KB (D1's limit is 100 KB). Rating bands are a side's rating at the match against today's #100 and #1000 ratings, read inside SQLite with `json_extract` from the `top` state (parsing 140 KB in the Worker would eat its 10 ms CPU), saved as `meta.bands`. The counters JSON is spliced from SQLite's text, not parsed.
- **Rating snapshots:** `ratings (day, tag, rating)` — each UTC day's first leaderboard refresh inserts everyone's rating (`INSERT OR IGNORE`), kept `RATING_DAYS` = 9 (pruned daily). `computeTop` looks up a day and a week ago per player (~2k rows read). Added 28 Oct 2026 and seeded that day.
- **Activity:** the match insert uses `RETURNING time`, so only newly saved matches (not one seen again from the opponent's log) are tallied per UTC hour into `state.activity` (`{ from, seeded, days: { YYYY-MM-DD: [24] } }`, kept `ACTIVITY_DAYS` = 35). Matches saved before `from` were counted once by the first stats run after it (`seeded`, one ~90k-row read).
- **Pause switch:** `[vars] PAUSED = "1"` in `wrangler.toml` makes `scheduled()` return before touching D1 (removing the cron alone kept firing for minutes); `/meta` and `/top` keep serving the last stats. Used once, 24 Oct 2026, when Cloudflare mailed at 93% of the daily 5M reads (mostly the pre-fix stats runs and testing); resumed 25 Oct with the 2M cap below. After a deploy that re-adds the cron, it takes a few minutes to start firing.
- **Parked players:** players who fall off the leaderboard get `next_poll = PARKED` (9e15) in `refreshBoard`, and the next board refresh that lists them again wakes them. Before (until 27 Oct 2026) their overdue `next_poll` stayed in the poll index's range, so every poll walked ~700 stale rows — ~1M reads a day, which pushed the day past the 2M cap.
- **Read budget:** every query's `rows_read` — heavy jobs and polling (~175 a poll, ~250k a day) — is added to `reads_count` for the UTC day (`reads_day`), and each heavy job remembers what it read last time (`stats_reads`, `top_reads`). A heavy job that would push the day past `READ_BUDGET − POLL_RESERVE` (2M − 250k; the user asked for a 2M cap — Cloudflare mails warnings from 80% of the free 5M) waits for tomorrow. **D1 counts every row a query touches, including each card `json_each` unpacks**: unpacking every deck played cost ~950k rows a stats run; grouping by deck first (`g AS MATERIALIZED`) and unpacking only the few thousand distinct decks costs ~200k. Likewise the first `/top` query read the matches twice (300k). Write new queries to read the matches once and derive the rest, and check `rows_read` in `wrangler d1 execute --json` before deploying.
- **Free-plan limits drive the design:** 10 ms CPU and 50 subrequests a run; D1 allows only 100 bound parameters, so bulk inserts/updates pass rows as one JSON parameter through `json_each`; D1's free 100k rows written / 5M read a day is why stats are precomputed every 6 h into `state.meta` instead of per request, and why match counts come from the card tally rather than another scan.
- **Endpoints:** `GET /meta` (the stats over 7 days: `decks` — top 300 — `[key, games, wins, draws, different players, 3-crown wins]`, `cards: [id+form, decks, wins, draws, 3-crown wins]`, deck rows also carry `[…, avg damage dealt, avg taken, avg elixir leaked, games with tower data]`, `troops: [id, name, art, games, wins, 3-crown wins]`, `towers: { king, princess: { troop id: full pair HP } }`, `matches`, `started` (collection start), `prev: { matches, cards: [id+form, decks, wins] }` for the week before — `null` until collection has run two weeks, so the stats job doesn't read a half-collected week; CORS open, cached 10 min) deck rows then `[…, [[tower troop id, games, wins, 3-crown wins]], [games, wins at #1–100 rating, games, wins at #101–1000]]` and card rows `[…, the same bands]` (from 29 Oct 2026), `bands: { hi, lo }` (the #100 and #1000 ratings), `activity: [[YYYY-MM-DD, [matches per UTC hour]]]` for the last 4 weeks; `GET /counters` (`cards: [card id]`, `decks: [[key, [[games against each card]], [[wins]]]]` — the inner arrays 100 cards each — for last run's top decks; ~200 KB) `GET /history` (`days: [[time, matches, { card id + form: decks }, { card id + form: wins }]]` — wins from 28 Oct 2026, one per UTC day — each stats run's 7-day card tally, the day's last run replacing earlier ones, kept 63 days (`HISTORY_DAYS`, two 4-week blocks for month vs month); costs no extra scan; the first run seeded a point from the previous `/meta`) `GET /top` (`players: [tag, name, clan, rank, rating, main deck key, games with it, ranked games, wins, wins with the main deck, rating a day ago, a week ago]`, `rating_days` (the snapshot days), the current leaderboard only) and `GET /status` (progress counters, reads used today, last error).
- Testing a change: `npx wrangler dev --remote --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"` runs one tick against the live database and binding.

## Upgrade data (hardcoded)
Stored in `LEVEL_DATA` — arrays of `{cards, gold}` per level transition for each rarity. Index 0 = upgrade from level 1→2, index 14 = 15→16.

`MIN_LEVEL` maps rarity to starting display level: common=1, rare=3, epic=6, legendary=9, champion=11. `MAX_LEVEL` is 16.

The API returns relative levels (e.g. legendary starts at 1 in the API). `toDisplayLevel()` converts to display level (1–16).

---

## Trophy history (gotcha)
The API only has today's trophies, so `cr_trophy_history_v1` is built up on the device (`recordTrophies()` in `loadPlayer` and on the cached render, dated to the data's `savedAt`): a point when a refresh finds a new value, plus one per battle still in the log — `startingTrophies + trophyChange`, back-dated to the battle, and the oldest battle's `startingTrophies` too. **`pathOfLegend` battles carry the ranked rating (~2,800), not Trophy Road trophies**, so they're a separate series; only 1v1 Trophy Road battles feed Trophy Road (`isTrophyRoadBattle()`: **type `trail` with a `Ladder…` game mode** — `trail` is the API's coarse type for most matchmade modes, 2v2 and events included; `PvP` was the old name, and checking only for it left the graph without any battle points until Oct 2026). Other types lie too: tournament battles report wins (1, 2, 3…) as `startingTrophies`, friendlies/boat battles the unchanged road trophies. Trophy Road barely moves for high players, so the card opens on Path of Legends when that's the series that moves. Friends and other players get the same saved graph, from their battle log each time their profile is loaded (`recordHistory`).

## Progress (gotcha)
The Account tab's Progress card ("what changed today / in 7 / 30 days") has no API behind it: `recordProgress()` (next to `recordTrophies()` in `loadPlayer` and the cached render, dated to the data's `savedAt`) keeps one compact snapshot per tag per **local day** — the day's last refresh replaces the day's entry — plus the very first snapshot ever seen, which stays put so there's a baseline on day one (it's usually the cached profile from the last visit). Snapshots: XP / King Tower / collection level, trophies, PoL rating + league, last season's result (`lastSeason`), battles, wins, mastery and other badge levels summed, clan name, and per card id `displayLevel × 4 + owned-form bits`. The card compares the profile against the last snapshot at or before the range start (else the oldest) and says "Since <that time>". "Gold on Upgrades" is the upgrade table's gold for the level-ups found (`computeUpgrade`), so it's approximate. **Season resets:** the API has no season id, so a Path of Legends season ending in the range is spotted by `lastPathOfLegendSeasonResult` changing or the league dropping (impossible mid-season); the card then says "New season" with last season's finish instead of a big rating loss. Kept 32 days plus one older baseline. An unchanged state isn't stored. Storage is delta-compacted (`compactProgress()` / `expandProgress()`; read through `progressList(tag)`): the first snapshot has every card, later ones only the changed ones — a full snapshot is ~2 KB and there can be ~60 tags. The friend modal has the same card (`progressHTML(data, scope)`, state per scope), recorded whenever their profile is fetched — opening it or the Friends list refresh.

## Badge progress (gotcha)
Achievement badges (`BattleWins`, `YearsPlayed`, …) report real progress toward their next level in `progress` / `target` (4781 / 5000). **Mastery badges don't**: their `progress` is just the level reached and `target` the next level number (Valkyrie: progress 9, target 10) — the API has no progress on the current mastery task. So "Closest to next level" ranks masteries by levels done of the card's total, and only achievements show numbers.

## Card mastery badges (gotcha)
Badges in `data.badges` are named `Mastery<InternalName>` using **Supercell's internal card names**, which for 27 cards differ from the display name — `MasteryAxeMan` is Executioner, `MasteryRageBarbarian` is Lumberjack, `MasteryZapMachine` is Sparky. `MASTERY_NAME_OVERRIDES` maps every current mismatch; unlisted names fall back to a normalized display-name match, so new cards keep working if their internal name matches.

The API **only returns masteries a player has already started** — there are no level-0 entries — so locked masteries are synthesised from the `/cards` catalog. Verified Aug 2026 across four accounts: 122 mastery badges mapped 1:1 onto all 122 catalog cards then; a new card is only covered once it has a mastery badge, and falls back to a normalized display-name match.

---

## Evolution / hero slots (gotcha)
The first three deck slots are special: **slot 1 only activates an evolution, slot 2 a hero or champion, slot 3 any of the three**; slots 4–8 are plain. A plain card may still sit in the first three (common in 2v2). Where a deck has no slot order of its own — Meta decks (sorted ids) and Decks-tab entries saved alphabetically before Oct 2026 — `slotOrder()` / `deckSlotNames()` rebuild it; an order that already fits (battle log, `currentDeck`) is kept. It matters beyond looks: Copy Deck sends the cards in this order, which sets the in-game slots. Deck tiles (`deckTileHTML()`) mark champions like heroes — gold ring — with a CHAMP tag. Battle-log decks list cards **in slot order**, and each card's `evolutionLevel` says which form it was *played* in — `1` = evolution, `2` = hero (`3` only appears in Boat Battle defences). No `evolutionLevel` means the plain card, even if the player owns its evolution. Checked Oct 2026: in 8-card decks it only appears on slots 0–2.

On `/players/{tag}` cards and `currentDeck`, `evolutionLevel` means something else — what the player *owns*, as the same bits (1 = evo, 2 = hero, 3 = both) — so don't reuse `cardVariant()` there; use `ownsEvo()` / `ownsHero()`. Checked Oct 2026 across ~500 cards: evolution-only cards read 1, hero-only 2, dual cards 2 or 3. An older rule read dual cards as "evolution only at max, hero at anything > 0" — same answers for today's four dual cards, wrong the day an evolution card gains a hero form (an owned evo would count as the hero).

Which cards *have* an evolution / hero form comes from the catalog's own `maxEvolutionLevel` (same bits) via `hasEvoForm()` / `hasHeroForm()`, not from the form's art: art can lag weeks behind a new form, and counting by art left it out of every count and tab. A form without art shows the plain card art (`evoImg()` / `heroImg()`). `currentDeckVariants()` derives the equipped form from the slot instead; only a both-forms card in slot 3 is ambiguous, and the battle log settles it when it can. `currentDeck` can be short a card the API doesn't know yet (seen Oct 2026: 7 cards). It is **only the 1v1 deck slot** — there's no 2v2 equivalent, so the 2v2 deck in use is taken from the latest 2v2 battle (lags a deck change until the next 2v2 game).

## Path of Legends leagues (gotcha)
`leagueNumber` now runs **1–7**: Master I–III, Champion, Grand Champion, Royal Champion, Ultimate Champion. Supercell dropped the three Challenger leagues; checked Oct 2026, the global #1 and #2 are both league 7. Values 8–10 only appear in results from the old 10-league system (10 = Ultimate Champion), e.g. an old best season. Global rank is only meaningful in Ultimate Champion.

## Drop rates (gotcha)
Hardcoded from Supercell's support page (`DROPS_URL`, October 2026 — the Shocktober article; it covers all chests, only the Snippet odds are event-only and left out). Update the tables by hand when Supercell changes them. Shown for the loaded profile's arena, no picker:
- **Arena number:** the API gives none. `arenaNumber(data)` reads `arena.rawName`: `Arena1`–`Arena14` by name (`Arena_L` = 10, `Arena_Electric` = 11, `Arena_T` = 12), then `Arena_L{n}` = Arena 14 + n (`Arena_L14` Summit of Heroes = 28, `Arena_L18` Spirit Square = 32; checked against players Oct 2026 — the road has 32 arenas since March 2026, ending at 14,000). An unknown name falls back to `ARENA_TROPHIES` (best trophies).
- **Chest level:** `chestLevelFor()`; Supercell's table stops at Arena 28 = level 16 (written before arenas 29–32), so those are level 16 too. Lightning Chest rows stop at Arena 28 as well.
- **Chances** per final star are only published for chest level 13+; below that the card says to treat them as a guide. Reward types the arena hasn't unlocked (`DROP_TYPES[k][1]`) are left out. "On average" = Σ final-star chance × reward chance × amount, from a 1-star start; under 1 is written "1 per N chests".
- The page's possible banners and emotes are images only, so the app links to it ("which ones →") instead of listing them.

## Season recap (gotcha)
The API has no season stats, so `recordPlay()` (in `recordHistory`, for every profile seen) tallies battles per Path of Legends season. A season starts the **first Monday of the month at 09:00 UTC** (`seasonStartOf()`; RoyaleAPI's figure, Supercell publishes no hour). The Account tab's Season card (`seasonRecapHTML()`, chips for each season on the device) shows dates and time left, record, ranked record, peak rating (`startingTrophies + trophyChange` of ranked battles — only Ultimate Champion battles carry a rating), the finish (current result for this season, `lastPathOfLegendSeasonResult` for the one before), 3-crown wins, most played and best 1v1 deck (5+ games, only when it beats the most played) and the toughest / easiest opponent card (`MATCHUP_MIN_GAMES`+). Only battles this device saw count — the log holds ~30 — so the card says since when.

## River Race forecast (gotcha)
During a war day `clans[].fame` is the boat's progress at the **start** of the day (it only moves when the day ends) and `periodPoints` the medals earned so far today. When the day ends clans are ranked by medals and get placement progress — 3000 / 1800 / 1000 / 600 / 400, read from `periodLogs` (`progressEarned` by `endOfDayRank`) — plus defense progress (`progressEndOfDay − progressStartOfDay − progressEarned`); a clan that played nothing gets no placement. `periodLogs` has every finished day of this race and last week's (`pointsEarned` = medals). `raceForecast()`: a clan's expected day is max(medals so far, its average day this week — else last week's), capped by 200 decks at today's medals per deck; placed by that; later days add its average daily progress; finish at 10,000. War days are `periodIndex % 7` 3–6. Checked on last week's race replayed from war day 3: it called both finishers and the other two clans' end progress exactly. Colosseum shows today's order and the decks-to-pass line only. Today (training) can't be tested live.

## Derived stats (no API field)
- **Account age** — the `YearsPlayed` badge's `progress` is days played.
- **Estimated playtime** — `battleCount × 4 min` (split by `tournamentBattleCount`), the same assumption deckai.app uses.
- **Classic / Grand 12-win challenges** — `progress` of the `Classic12Wins` / `Grand12Wins` badges; absent badge = 0.

---

## Profile vs friend modal (gotcha)
The friend modal (friends **and** clan members) renders the same Overview as the profile, and both are in the DOM at once. Anything the Overview, Decks or Battles tab renders needs per-scope state and element ids (`renderOverview(data, battles, scope)`, ids like `${scope}-plan-output`) — a fixed id makes the friend's control drive the profile's hidden copy. Friend deck maps are saved under the friend's own tag (`buildDeckMapFromBattles(battles, tag)`), so they never mix with yours; `deleteDeck(scope, key)` deletes from whichever profile it's shown in.

`loadPlayer`, `viewFriend` and `loadClan` each take a sequence ticket and drop responses that are no longer the latest, so a slow request (e.g. the installed-app background refresh) can't overwrite a newer one.

## Scrolling (gotcha)
The page itself never scrolls: `html, body` are `overflow: hidden` and **`#content` is the scroller**. Use `document.getElementById('content').scrollTop`, never `window.scrollY` / `window.scrollTo` (both silently do nothing). The profile header + tab bar (`.ph-sticky`) and the friend modal's tab bar (`.ftab-sticky`; the modal card uses `overflow: clip`, not `hidden`, so sticky works) stay pinned. Programmatic scrolls are instant on purpose — `behavior: 'smooth'` never ran in testing.

## Image cache (gotcha)
Card / evo / hero art (`api-assets.clashroyale.com`) and badge art (`raw.githubusercontent.com`) are 300px PNGs of ~160 KB with no Cache-Control, so the browser cache dropped them and reopening the app re-downloaded them. `sw.js` now serves them **cache-first** from `max-royale-img-v1`:
- **Changed art:** new art at a new URL is just a new entry (the catalog's background revalidation brings the new URL in). Art replaced at the *same* URL is caught by a background re-check every `IMG_RECHECK_MS` (3 days), using `cache: 'no-cache'` so the server can answer 304 cheaply.
- **Bookkeeping:** `./__img-meta` in the same cache holds `{ url: { fetched, used } }`. Entries unused for 60 days, or beyond 1000, are pruned.
- **Opaque responses:** those hosts send no CORS headers, so the worker can't see a 404. The page's capture-phase `error` listener posts `img-broken` and the worker deletes that copy, so missing art (e.g. a new evo) is fetched again on the next view. Keep that listener.
- The page also asks for `navigator.storage.persist()`. A lazy image still loading after 150 ms shows a placeholder tile and fades in when it arrives (`.ld-fade`, decided by a capture-phase `load` listener); images that load faster, i.e. stored ones, just appear. Fading every image made tab switches flash — don't go back to that.

## Known limitations / things to be aware of
- The Clash Royale API only returns the last **~25–30 battles**. Deck stats work around this by accumulating history in `localStorage` (not retroactive — it only counts battles seen since the feature shipped).
- Deck history is per-browser/per-device and never leaves the device, so different users of the deployed app never see each other's stats.
- **In a browser tab the profile never auto-refreshes** — the app renders the cached snapshot on open and waits for the Refresh button, so stats can look stale. Installed as an app it refreshes in the background on launch and on foreground. Deliberate: a tab is often left open for a long time, an installed app is expected to be current.
- New cards often reach the API **before their icon art does** (Ronin, Elite Barbarians evo). Missing icons are expected for a few weeks after a release; the Cards/Decks tabs fall back gracefully, mastery badges fall back to the card's catalog art, and the Evolutions / Heroes tabs show a new form with the plain card art (they go by `maxEvolutionLevel`, not the art).
- The card catalog cache expires on the first Tuesday of the month, matching CR's balance update — but **new cards, heroes and evolutions also ship mid-season**, which used to leave the app showing a stale count (e.g. `122 / 122` after Minion Giant made it 123) for up to five weeks. `maybeLoadCards()` now serves the cache instantly *and* revalidates in the background, redrawing only when the catalog really changed (`_cardsSignature()` covers ids, `maxEvolutionLevel` and form art; the tower troop count too). Because an installed app can stay open for days, every `loadPlayer` (Refresh, background refresh) re-checks too, at most hourly (`recheckCardsIfStale()`). That keeps the Account tab's Collection totals, the Overview counts and the tabs current. Don't reintroduce a cache-only path.
- `/cards` returns `items` (123 deck cards as of Sept 2026) **and** `supportItems` (4 tower troops). `allCards` holds `items` only; the tower troop count is kept as `_towerTroopTotal` (`supportCount` in the card cache) so tower troop totals can show one as missing.
- `upcomingchests` still returns data, but chests were removed from the game — it's stale; don't implement it.
- No real-time meta deck data is available from any public API.

---

## Deployment
Push to `main` — the GitHub Actions workflow deploys to Pages automatically (~1 min). Watch the **Actions** tab for the green ✓.

To undo the Oct 2026 header/accounts redesign, the tag `pre-redesign` marks the last version before it: `git revert --no-edit pre-redesign..HEAD` (or check out files from it) and push.

If a run fails with *"Multiple artifacts named github-pages"*, it's because a failed run was re-run. Don't re-run — push a fresh commit instead (`git commit --allow-empty` works).

No API key setup is needed by end users; the Worker holds it.

### Install on Android (PWA)
Open the Pages URL in Chrome → ⋮ → "Add to Home Screen". Launches fullscreen. The calculator works offline; player/clan lookup needs internet.

---

## ⚠️ Security note — API token exposed in git history
`index.html` used to hardcode a Clash Royale API JWT in `const _API_KEY`, left over from before the Cloudflare Worker existed. It was dead code (`apiGet()` never used it) and was **removed from the working tree** in `57f8332`.

It is **still present in git history** and was served publicly from GitHub Pages for as long as it was committed, so treat the token as compromised. It is IP-locked to `45.79.218.79` (RoyaleAPI's public proxy), which limits but does not eliminate abuse.

**Before revoking it, check whether the Cloudflare Worker uses the same key** — the Worker almost certainly calls the CR API through RoyaleAPI's proxy, which is exactly the IP this key is locked to. If it's the same key, revoking it takes the app down for every user until the Worker is given a new one. Correct order: mint a new key → update the Worker's secret → confirm the app still loads → revoke the old key.

---

## Build history
1. Cloned and analyzed original Replit monorepo (Node.js/Express backend + Kotlin Android app)
2. Extracted card upgrade data and API logic from `artifacts/api-server/src/routes/player.ts`
3. Rebuilt entire app as a single `index.html`
4. Added GitHub Actions deploy workflow
5. Added extra player stats, battle log tab, deck builder tab, clan screen, calculator card picker
6. Split the collection into dedicated Evolutions / Heroes / Tower Troops tabs
7. Added Friends screen and saved-accounts switcher
8. Added Deck Upgrade screen and the Suggested Upgrades planner
9. Moved API access behind a Cloudflare Worker (removed the corsproxy.io + user-supplied-key setup)
10. Made the app an installable PWA (manifest + service worker)
11. Persisted deck W/L history in `localStorage` to beat the ~25-battle API window, with manual delete
12. Auto-expire the card catalog cache on the first Tuesday of each month
13. Added the Badges tab, with card-mastery filtering and locked-mastery display
14. Shared the card filter/sort pipeline between the main and friend card panes
15. Revalidated the card catalog in the background so mid-season cards appear without waiting for the monthly cutoff
16. Auto-refreshed the profile on launch/foreground when running as an installed app
17. Showed not-yet-unlocked cards greyed out at the bottom of the Cards list, and measured Card Insights against the whole catalog
18. Marked evolution and hero tiles in the Battles and Decks tabs, and tracked decks per evo/hero choice
19. Added Account and Battle Stats to both Overviews (deckai.app parity), and moved Path of Legends to the 7-league numbering
20. Moved the stats out of the Overview (Account tab; Battles tab Log/Stats toggle), added per-battle details, and added River Race + War History to the Clan screen
21. Redesign: compact profile header, tag lookup moved into the Accounts menu, current deck pinned on the Decks tab (tagged `pre-redesign` before it)
22. Suggested friends, all profile tabs in the friend/clan-member modal, bigger tab buttons
23. Pinned header + tab bar, swipe between tabs, selected tab kept in view, tab bar edge fades, re-tap a bottom button to scroll up, per-screen scroll memory
24. Replaced the Current Deck card with an "In use" mark in the deck list and a Current deck option in Deck Upgrade
25. Opponent-card matchups, Compare tab, deck links + share target in Deck Upgrade, backup/restore, "updated X ago" header, friends list with trophies/last battle/sorting, API retries
26. Card art stored on the device (cache-first, re-checked every 3 days), image placeholders + fade-in
27. Clan tab in the profile modal; Back steps through modal profiles and closes the modal instead of the app
28. Overview numbers open the matching list; battle log grouped by day with summaries and a Wins/Losses filter; deck sorting, last played and an Upgrade Cost button
29. Badges: "Closest to next level" sort, progress numbers on achievements, green bars when nearly done
30. Full test pass fixes: a mistyped tag keeps your profile (and isn't remembered), clear "not found" messages, the Calculator says when a card is maxed or the target is too low, Deck Upgrade says "at target" instead of "maxed"
31. Trophy History graph (Trophy Road / Path of Legends, 7 / 30 days / all, touch for values) in the Account tab; the equipped 1v1 deck always listed in Decks; modal history survives a reload
32. Average elixir per deck in the battle log; Account tab's Cards Found split into cards / evolutions / heroes / tower troops; tower troop totals from the catalog
33. New cards, evolutions, heroes and tower troops update every count without reopening the app: forms from the catalog's `maxEvolutionLevel` instead of their art, ownership read as bits, hourly catalog re-check on refresh
34. Meta collector Worker (`collector/`) and the Meta screen (6th bottom button): top-1000 ranked deck and card stats
35. Meta: deck search by card, 3-crown rates, Evolutions / Heroes filter, Trending cards (after two weeks), and a You view — your deck against the meta, closest top decks, meta cards to upgrade
36. Meta: Players view — the global top 1,000 with clan, record and main deck, tap to open; collector `/top` and a daily read budget
37. Progress card in the Account tab (upgrades, unlocks, levels, rating since today / 7 / 30 days) and optional Clan tools: decks left today, war participation, inactive members
38. Head-to-head with friends: friendly-battle record against them and 2v2 record together (Compare tab, Friends list), also filled in from their battle logs
39. Bug pass: Trophy History reads Trophy Road battles again (type `trail`, not `PvP`), the Clan screen refreshes a stale clan when opened, Friends list reads head-to-head once per render
40. Meta → You: best top decks for your cards; Progress card: gold spent on upgrades
41. Card level chart, folded out from the Account tab's Cards count
42. Tap players in the battle log to open them; where you'd rank in Meta → Players; Progress handles Path of Legends season resets
43. Cards tab level filter (chart bars open it); Inactive members threshold set by the user
44. Decks in Meta and the Decks tab shown (and copied) in game slot order: evolution, hero/champion, either
45. Meta → Stats: popularity vs win rate, archetypes, elixir curve, card trends (collector `/history`), Evo vs Hero vs plain; collector stops re-reading players who left the leaderboard
46. Drop Rates in the Calculator screen: Magic / Standard Lucky Chest, Evolution Box, Lightning and King's Chest odds and rewards for your arena
47. Friend / clan-member profiles get the same on-device history as your own: Progress card, saved Trophy History and Opponent Cards
48. Friend / clan-member Decks tab keeps their deck win/loss history too, with delete
49. Modal parity: friend Upgrade Planner reads their saved decks, Open in Calculator on friend cards and tower troops (their level), friend tower troop rows match yours, missing evo/hero art placeholder; the Decks mode filter carries over for friends too; Cards / Evolutions / Heroes / Badges filters stay while a modal profile is shown (`resetFriendFilters()` per profile opened and for Overview links)
50. Collector saves tower troops, tower HP left and elixir leaked per match, wins in the daily history, and keeps matches 90 days; Meta shows tower damage per deck, a Tower troops card and win-rate trend lines
51. Meta: counters (per deck and card vs card), card pairs, win rate by rating, best tower troop per deck, top players who main a deck, when top players play, month vs month, and your games with your deck against the top players'; collector packs per-deck counts into the same single scan
52. Meta: multi-card deck search, archetype matchups grid, one-card swaps and your deck's hardest matchups in You, rising / falling players (collector keeps a daily rating snapshot)
53. Country Path of Legends leaderboards in Meta → Players; Battle Stats: record against archetypes, level advantage, momentum after wins / losses and a losing-streak note; River Race forecast; app shortcuts
54. Goals and a season recap in the Account tab, When You Play Best in Battle Stats, saved decks (☆ → Deck Upgrade → Saved), game-mode leaderboards in Meta → Players, tournament lookup on the Clan screen
55. War-deck reminder under the profile header, Gold Budget in the Overview, scouting rival clans in River Race, CSV export (Accounts menu ⚙️)
56. Friends' What's new feed, Deck finisher in Meta → You, Deck compare in Deck Upgrade, War MVPs in War History, upgrade-ready note, light theme
