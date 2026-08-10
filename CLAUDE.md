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
- Installable PWA — `manifest.json` + `sw.js` (cache-named `max-royale-v4`, bump to force a shell refresh)
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
| Player       | `screen-lookup`  | Player profile lookup by tag + saved accounts |
| Calculator   | `screen-calc`    | Offline upgrade cost calculator with card picker |
| Deck Upgrade | `screen-deckup`  | Cost to upgrade a whole 8-card deck |
| Clan         | `screen-clan`    | Clan lookup by tag, sortable member list |
| Friends      | `screen-friends` | Up to 10 saved friends, mini profile viewer |

There is no `screen-home`; the app opens on the Player screen.

---

## Player profile — tabs (after loading a player tag)

| Tab          | ID                 | Data source |
|--------------|--------------------|-------------|
| Overview     | `tab-overview`     | `/players/{tag}` — card insights, battle stats, donations, collection level |
| Cards        | `tab-cards`        | `/players/{tag}` + `/cards` — full collection with filters (status, rarity, sort) |
| Evolutions   | `tab-evolutions`   | `/cards` catalog filtered by `iconUrls.evolutionMedium`, matched against player cards |
| Heroes       | `tab-heroes`       | `/cards` catalog filtered by `iconUrls.heroMedium` |
| Tower Troops | `tab-towerTroops`  | `data.supportCards` from `/players/{tag}` |
| Decks        | `tab-decks`        | Battle log + persisted history — W/L/D per unique deck, mode filter, copy/delete |
| Battles      | `tab-battles`      | `/players/{tag}/battlelog` — recent battles with decks, crowns, trophy change |
| Badges       | `tab-badges`       | `data.badges` — earned badges + synthesised locked card masteries |

The Friends screen has its own parallel tab set (`data-ftab`): Overview, Cards, Evolutions, Heroes, Tower Troops.

---

## Key JS functions

| Function | What it does |
|---|---|
| `apiGet(path)` | Fetches `<worker>{path}`; no auth header. Throws a friendly message on failure. |
| `loadPlayer(tagOverride)` | Fetches `/players/{tag}`, `/battlelog` and the card catalog in parallel, calls `renderProfile()` |
| `renderProfile(data, battles)` | Renders the header + every profile tab |
| `renderOverview(data, battles)` | Card insights, collection level, battle/donation stats |
| `renderCardsPane(data)` / `renderCards()` | Card collection pane; `renderCards()` re-renders on filter/sort change |
| `renderEvolutionsPane()` / `loadEvolutionsGrid()` | Evolutions tab (lazy-loaded on tab click) |
| `renderHeroesPane()` / `loadHeroesGrid()` | Heroes tab (lazy) |
| `renderTowerTroopsPane(data)` / `loadTowerTroopsGrid()` | Tower troops tab (lazy) |
| `renderBadgesPane(data)` / `loadBadgesGrid()` | Badges tab (lazy); builds earned + locked-mastery entries |
| `_masteryCardFor(badgeName)` | Maps a `Mastery<InternalName>` badge to its catalog card |
| `setBadgeFilter(val)` | Badge filter: `all` / `mastery` / `other` |
| `renderBattles(battles)` / `setBattleFilter(mode)` | Battle log tab + mode filter |
| `renderDeckBuilder(battles, playerTag)` | Builds the icon map, delegates to `buildDeckMapFromBattles` |
| `buildDeckMapFromBattles(battles, playerTag)` | Merges new battles into persisted deck history, returns the deck map |
| `loadDeckHistory(tag)` / `saveDeckHistory(tag, h)` | Per-tag deck W/L history in `localStorage` |
| `deleteDeck(key)` | Removes one deck + its history (confirm prompt) |
| `_renderDeckList(deckMap, battles)` / `setDeckFilter(mode)` | Deck tab rendering + mode filter |
| `copyDeckLink(names, btn)` | Opens the deck via Supercell's `link.clashroyale.com` deep link; clipboard fallback |
| `renderUpgradePlanner(data, battles)` | "Suggested upgrades", scoped by account or deck |
| `renderDeckUpgradeScreen()` / `buildDeckUpSuggestions()` | Deck Upgrade screen |
| `maybeLoadCards()` | Fetches `/cards` once into `allCards`, cached in `localStorage` with monthly expiry |
| `_firstTuesdayOfMonth()` / `_mostRecentMonthlyCacheCutoff()` | Card-cache expiry timed to CR's monthly update |
| `loadClan()` / `renderClan(data)` / `renderMembers()` / `setClanSort(by)` | Clan screen |
| `renderFriends()` / `addFriend()` / `viewFriend(tag)` / `friendTab(name)` | Friends screen |
| `computeUpgrade(rarity, level, count, target)` | Core upgrade math |
| `toDisplayLevel(rarity, apiLevel)` | Converts API relative level → display level (1–16) |
| `goTo(name)` / `switchTab(name)` | Screen / tab switching (tab switch triggers lazy loads) |
| `formatBattleTime(ts)` | API timestamp → relative time ("2h ago") |

---

## API endpoints used

| Endpoint | Used for |
|---|---|
| `GET /players/{tag}` | Profile, cards, support cards, badges, stats |
| `GET /players/{tag}/battlelog` | Recent battles |
| `GET /clans/{tag}` | Clan info + member list |
| `GET /cards` | Full catalog — `items` (deck cards) and `supportItems` (tower troops) |

### Endpoints available but NOT yet implemented

| Endpoint | Could be used for |
|---|---|
| `GET /locations/{id}/pathoflegend/players` | Path of Legends leaderboard (this one returns data) |
| `GET /locations/{id}/rankings/clans` | Clan leaderboard |
| `GET /clans/{tag}/warlog` | Past clan war results |
| `GET /clans/{tag}/currentwar` | Live war state |
| `GET /tournaments/{tag}` | Tournament details |

> `GET /locations/{id}/rankings/players` returned an empty `items` array when tested (Aug 2026) — likely season-dependent. Prefer the `pathoflegend` variant.

---

## localStorage keys

| Key | Holds |
|---|---|
| `cr_player_tag` | Last looked-up player tag |
| `cr_saved_accounts` | Saved account list (name + tag) |
| `cr_friends` | Saved friends (max 10) |
| `cr_profile_cache` | Last profile + battles, for instant render on open |
| `cr_clan_cache` | Last clan lookup |
| `cr_cards_cache_v6` | `{ items, savedAt }` card catalog, monthly expiry |
| `cr_deck_history_v1` | Per-tag deck W/L/D history, deduped by `battleTime` |

---

## Upgrade data (hardcoded)
Stored in `LEVEL_DATA` — arrays of `{cards, gold}` per level transition for each rarity. Index 0 = upgrade from level 1→2, index 14 = 15→16.

`MIN_LEVEL` maps rarity to starting display level: common=1, rare=3, epic=6, legendary=9, champion=11. `MAX_LEVEL` is 16.

The API returns relative levels (e.g. legendary starts at 1 in the API). `toDisplayLevel()` converts to display level (1–16).

---

## Card mastery badges (gotcha)
Badges in `data.badges` are named `Mastery<InternalName>` using **Supercell's internal card names**, which for 27 cards differ from the display name — `MasteryAxeMan` is Executioner, `MasteryRageBarbarian` is Lumberjack, `MasteryZapMachine` is Sparky. `MASTERY_NAME_OVERRIDES` maps every current mismatch; unlisted names fall back to a normalized display-name match, so new cards keep working if their internal name matches.

The API **only returns masteries a player has already started** — there are no level-0 entries — so locked masteries are synthesised from the `/cards` catalog. Verified Aug 2026 across four accounts: 122 mastery badges map 1:1 onto all 122 catalog cards.

---

## Known limitations / things to be aware of
- The Clash Royale API only returns the last **~25–30 battles**. Deck stats work around this by accumulating history in `localStorage` (not retroactive — it only counts battles seen since the feature shipped).
- Deck history is per-browser/per-device and never leaves the device, so different users of the deployed app never see each other's stats.
- New cards often reach the API **before their icon art does** (Ronin, Elite Barbarians evo). Missing icons are expected for a few weeks after a release; the Cards/Decks tabs fall back gracefully, but the Evolutions tab filters on `iconUrls.evolutionMedium` and so hides an evolution entirely until Supercell publishes it.
- `/cards` returns `items` (122 deck cards) **and** `supportItems` (4 tower troops). `allCards` holds `items` only.
- `upcomingchests` exists in the API spec but was removed from the game — don't implement it.
- No real-time meta deck data is available from any public API.

---

## Deployment
Push to `main` — the GitHub Actions workflow deploys to Pages automatically (~1 min). Watch the **Actions** tab for the green ✓.

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
