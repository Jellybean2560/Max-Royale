# Max Royale — Project Handoff

## What this project is
A standalone single-file web app (`index.html`) for Clash Royale players. It replaces a Replit-hosted Node.js/Express backend + Android app. No build step, no dependencies, no server needed. Deployed to GitHub Pages.

**Live URL:** `https://jellybean2560.github.io/Max-Royale/`
**GitHub repo:** `https://github.com/Jellybean2560/Max-Royale`

---

## Tech stack
- Pure HTML + CSS + vanilla JS, single file (`index.html`)
- Fonts: Google Fonts — Rajdhani (headings), Inter (body)
- No npm, no framework, no build step
- API calls go through a **Cloudflare Worker** (`https://quiet-frost-f9f0.jellevandenwouwer.workers.dev`) that holds the Clash Royale API key server-side and adds CORS headers. The browser sends **no** auth header and needs no key.
- Installable PWA — `manifest.json` + `sw.js` (shell cache `max-royale-v5`, bump to force a shell refresh; card art in `max-royale-img-v1`, which survives app updates — see *Image cache*)
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
| Player       | `screen-lookup`  | Player profile. A compact header (name ▾, trophies, refresh; King/CL/league line) sits above the tabs; tapping the name opens the Accounts menu (switch, edit, add/look up by tag). The tag box (`#lookup-start`) only shows with no profile on screen: first run or a failed lookup |
| Calculator   | `screen-calc`    | Offline upgrade cost calculator with card picker |
| Deck Upgrade | `screen-deckup`  | Cost to upgrade a whole 8-card deck; the current 1v1 and 2v2 decks are the first choices (1v1 is the default). Custom Deck takes a pasted deck link (the game's share link or a RoyaleAPI deck URL); a deck shared to the installed app (manifest `share_target`) opens here too |
| Clan         | `screen-clan`    | Clan lookup by tag; tabs Members (sortable), River Race (live standings + each member's decks used today), War History (last 10 races, fold-out standings + member contributions) |
| Friends      | `screen-friends` | Up to 50 saved friends (`MAX_FRIENDS`) with trophies, clan and last battle, sortable (last played / trophies / name / added) + Suggested Friends; the profile modal (also opened for clan members) has the same tabs as the profile plus Compare |

There is no `screen-home`; the app opens on the Player screen.

---

## Player profile — tabs (after loading a player tag)

| Tab          | ID                 | Data source |
|--------------|--------------------|-------------|
| Overview     | `tab-overview`     | `/players/{tag}` — card insights, collection level, suggested upgrades, upgrade planner. Card Insights numbers (›) open the list they count via `ovGo()`: Cards filtered by status (rarity/search cleared, so the count matches), Tower Troops, Evolutions/Heroes on Unlocked |
| Cards        | `tab-cards`        | `/players/{tag}` + `/cards` — full collection with filters (status, rarity, sort); cards not yet unlocked are synthesised from the catalog and shown greyed out at the bottom |
| Evolutions   | `tab-evolutions`   | `/cards` catalog filtered by `iconUrls.evolutionMedium`, matched against player cards |
| Heroes       | `tab-heroes`       | `/cards` catalog filtered by `iconUrls.heroMedium` |
| Tower Troops | `tab-towerTroops`  | `data.supportCards` from `/players/{tag}` |
| Decks        | `tab-decks`        | Battle log + persisted history — W/L/D per unique deck (card set + which cards were played as evo/hero), last played, sort (most played — decks in use pinned first, marked "In use · 1v1" / "· 2v2" — / best win rate, 3+ games first / recently played), mode filter, Copy Deck + Upgrade Cost (opens it as a custom deck in Deck Upgrade, costed with *your* cards — also from a friend's deck), delete |
| Battles      | `tab-battles`      | Toggle between **Battle Log** (`/battlelog` — grouped by day with a W/L/trophy summary per day, Wins/Losses toggle + mode filter; decks with evo/hero tiles, crowns, trophy change; each battle folds out details: towers left, elixir leaked, trophies, global rank, tower troop, clan, boat stats; 2v2 also the opponents' decks) and **Battle Stats** (lifetime W/L, streak, est. playtime, recent W/L per mode, Opponent Cards — toughest / best-against cards, Path of Legends, old trophy road, challenges) |
| Badges       | `tab-badges`       | `data.badges` — earned badges + synthesised locked card masteries; sort Most progress / Closest to next level (`badgeNextShare()`); achievements show progress / target, bars turn green at 90%+ |
| Account      | `tab-account`      | `/players/{tag}` — XP level, account age, star points, cards found, favourite card, donations, clan wars |

The friend/clan-member modal has the same tab set (`data-ftab`): Overview, Compare, Cards, Evolutions, Heroes, Tower Troops, Decks, Battles, Badges, Account, Clan. **Clan** (only when they're in a clan you aren't already looking at — not your own clan, the clan on the Clan screen you opened them from, or the clan of the modal profile you came from; `showClanTab()`) shows the clan header and members — tap one to open them — and a button into the Clan screen for River Race / War History. **Compare** (only when a profile is loaded and it's someone else) puts the loaded profile next to them: account stats with the higher value highlighted, then every card's level, filterable by who's ahead. Its Decks tab uses only the friend's current battle log (never saved, no delete button); its battle details label the sides by name instead of "You".

**Modal history:** every profile opened in the modal pushes a history entry (`_modalStack`, `state.modal` = depth), so Android Back / the ← button steps back through profiles (restoring the tab each was on, from `_modalProfiles` without refetching) and finally closes the modal instead of leaving the app. `closeFriendModal()` unwinds those entries; `hideFriendModal()` is the actual close — don't hide the modal any other way or the history gets out of step.

**Friends list stats:** each saved friend in `cr_friends` carries a snapshot (`trophies`, `clan`, `lastBattle`, `statsAt`). Opening the Friends screen refreshes snapshots older than 15 min, four requests at a time (`refreshFriendStats()`); 🔄 refreshes all; opening a friend's profile updates theirs.

**Header age:** the profile header's info line ends in "updated 12 min ago" (`updateProfileAge()`, ticks every 30 s, gold after an hour, "↻ updating…" during a quiet refresh). It reads `window._currentProfile.savedAt`.

**Backup:** the Accounts menu (and the start card, for a fresh device) saves / restores one JSON file of `BACKUP_KEYS` — accounts, friends, deck history, matchups, co-players. Caches are left out. Restoring replaces those keys and reloads the profile.

**Suggested friends:** the API has no friends list. `recordCoPlayers()` accumulates who you play *with* per profile tag (`cr_coplayers_v1`, deduped by `battleTime`); a 2v2 teammate seen in 2+ games or anyone from a Friendly battle is suggested (random matchmade teammates almost never repeat). Saved friends, your accounts and dismissed players are left out. `viewFriend()` also fetches the friend's battle log, only for the Overview's recent-battle stats (a failure there is ignored).

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
| `recordMatchups(tag, battles)` / `matchupsHTML(data, battles, scope)` | Win rate per opponent card (`cr_matchups_v1`); the friend modal tallies their current log only |
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
| `loadClan()` / `renderClan(data)` / `renderMembers()` / `setClanSort(by)` | Clan screen |
| `renderFriends()` / `addFriend()` / `viewFriend(tag)` / `friendTab(name)` | Friends screen |
| `computeUpgrade(rarity, level, count, target)` | Core upgrade math |
| `toDisplayLevel(rarity, apiLevel)` | Converts API relative level → display level (1–16) |
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
| `GET /clans/{tag}/riverracelog` | Past races: per race all 5 clans' rank, trophy change, fame and participants |

### Endpoints available but NOT yet implemented

| Endpoint | Could be used for |
|---|---|
| `GET /locations/{id}/pathoflegend/players` | Path of Legends leaderboard (this one returns data) |
| `GET /locations/{id}/rankings/clans` | Clan leaderboard |
| `GET /leaderboards` / `/leaderboard/{id}` | 2v2 League, Merge Tactics, Touchdown, Mega Draft leaderboards |
| `GET /locations/{id}/rankings/clanwars` | Clan war leaderboard |
| `GET /tournaments/{tag}` | Tournament details |

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
| `cr_coplayers_v1` | Per-tag co-players for Suggested Friends: `{ seen, players: { tag: { name, clan, mates, friendlies, last } }, dismissed }` |
| `cr_matchups_v1` | Per-tag opponent-card tally: `{ since, battles, seen, cards: { name: [wins, losses, draws] } }`; friendlies and boat battles skipped |
| `cr_deck_history_v1` | Per-tag deck W/L/D history (+ `last` played battleTime), deduped by `battleTime`. Keys are sorted names with `[evo]`/`[hero]` suffixes; entries without `variants` predate that and are adopted by the first matching card set played again |

---

## Upgrade data (hardcoded)
Stored in `LEVEL_DATA` — arrays of `{cards, gold}` per level transition for each rarity. Index 0 = upgrade from level 1→2, index 14 = 15→16.

`MIN_LEVEL` maps rarity to starting display level: common=1, rare=3, epic=6, legendary=9, champion=11. `MAX_LEVEL` is 16.

The API returns relative levels (e.g. legendary starts at 1 in the API). `toDisplayLevel()` converts to display level (1–16).

---

## Badge progress (gotcha)
Achievement badges (`BattleWins`, `YearsPlayed`, …) report real progress toward their next level in `progress` / `target` (4781 / 5000). **Mastery badges don't**: their `progress` is just the level reached and `target` the next level number (Valkyrie: progress 9, target 10) — the API has no progress on the current mastery task. So "Closest to next level" ranks masteries by levels done of the card's total, and only achievements show numbers.

## Card mastery badges (gotcha)
Badges in `data.badges` are named `Mastery<InternalName>` using **Supercell's internal card names**, which for 27 cards differ from the display name — `MasteryAxeMan` is Executioner, `MasteryRageBarbarian` is Lumberjack, `MasteryZapMachine` is Sparky. `MASTERY_NAME_OVERRIDES` maps every current mismatch; unlisted names fall back to a normalized display-name match, so new cards keep working if their internal name matches.

The API **only returns masteries a player has already started** — there are no level-0 entries — so locked masteries are synthesised from the `/cards` catalog. Verified Aug 2026 across four accounts: 122 mastery badges mapped 1:1 onto all 122 catalog cards then; a new card is only covered once it has a mastery badge, and falls back to a normalized display-name match.

---

## Evolution / hero slots (gotcha)
The first three deck slots are special: evolutions, heroes and champions go there (two evos + one hero/champion, or one evo + two heroes/champions). Battle-log decks list cards **in slot order**, and each card's `evolutionLevel` says which form it was *played* in — `1` = evolution, `2` = hero (`3` only appears in Boat Battle defences). No `evolutionLevel` means the plain card, even if the player owns its evolution. Checked Oct 2026: in 8-card decks it only appears on slots 0–2.

On `/players/{tag}` cards and `currentDeck`, `evolutionLevel` means something else — what the player *owns*, as the same bits (1 = evo, 2 = hero, 3 = both) — so don't reuse `cardVariant()` there. `currentDeckVariants()` derives the equipped form from the slot instead; only a both-forms card in slot 3 is ambiguous, and the battle log settles it when it can. `currentDeck` can be short a card the API doesn't know yet (seen Oct 2026: 7 cards). It is **only the 1v1 deck slot** — there's no 2v2 equivalent, so the 2v2 deck in use is taken from the latest 2v2 battle (lags a deck change until the next 2v2 game).

## Path of Legends leagues (gotcha)
`leagueNumber` now runs **1–7**: Master I–III, Champion, Grand Champion, Royal Champion, Ultimate Champion. Supercell dropped the three Challenger leagues; checked Oct 2026, the global #1 and #2 are both league 7. Values 8–10 only appear in results from the old 10-league system (10 = Ultimate Champion), e.g. an old best season. Global rank is only meaningful in Ultimate Champion.

## Derived stats (no API field)
- **Account age** — the `YearsPlayed` badge's `progress` is days played.
- **Estimated playtime** — `battleCount × 4 min` (split by `tournamentBattleCount`), the same assumption deckai.app uses.
- **Classic / Grand 12-win challenges** — `progress` of the `Classic12Wins` / `Grand12Wins` badges; absent badge = 0.

---

## Profile vs friend modal (gotcha)
The friend modal (friends **and** clan members) renders the same Overview as the profile, and both are in the DOM at once. Anything the Overview, Decks or Battles tab renders needs per-scope state and element ids (`renderOverview(data, battles, scope)`, ids like `${scope}-plan-output`) — a fixed id makes the friend's control drive the profile's hidden copy. Friend deck maps use `buildDeckMapFromBattles(..., { persist: false })` so a friend's decks never enter this device's deck history.

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
- New cards often reach the API **before their icon art does** (Ronin, Elite Barbarians evo). Missing icons are expected for a few weeks after a release; the Cards/Decks tabs fall back gracefully, and mastery badges fall back to the card's catalog art, but the Evolutions tab filters on `iconUrls.evolutionMedium` and so hides an evolution entirely until Supercell publishes it.
- The card catalog cache expires on the first Tuesday of the month, matching CR's balance update — but **new cards, heroes and evolutions also ship mid-season**, which used to leave the app showing a stale count (e.g. `122 / 122` after Minion Giant made it 123) for up to five weeks. `maybeLoadCards()` now serves the cache instantly *and* revalidates in the background, redrawing only when the catalog really changed. Don't reintroduce a cache-only path.
- `/cards` returns `items` (123 deck cards as of Sept 2026) **and** `supportItems` (4 tower troops). `allCards` holds `items` only.
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
