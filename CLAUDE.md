# Clash Calc Pro — Project Handoff

## What this project is
A standalone single-file web app (`index.html`) for Clash Royale players. It replaces a Replit-hosted Node.js/Express backend + Android app. No build step, no dependencies, no server needed. Deployable to GitHub Pages for free.

**Live URL (after deployment):** `https://jellybean2560.github.io/Clash-Royale-Optimizer/`
**GitHub repo:** `https://github.com/Jellybean2560/Clash-Royale-Optimizer`

---

## Tech stack
- Pure HTML + CSS + vanilla JS, single file (`index.html`)
- Fonts: Google Fonts — Rajdhani (headings), Inter (body)
- No npm, no framework, no build step
- API calls go through `corsproxy.io` as a CORS proxy (the official Clash Royale API blocks direct browser requests)
- API key stored in `localStorage`
- GitHub Actions workflow (`.github/workflows/deploy.yml`) auto-deploys to GitHub Pages on every push to `main`

---

## Files in the repo

```
index.html                        ← entire app (HTML + CSS + JS)
.github/workflows/deploy.yml      ← GitHub Pages auto-deploy workflow
README.md                         ← setup instructions
```

---

## Data sources
- **Official Clash Royale API** (`https://api.clashroyale.com/v1`) — requires a free API key from developer.clashroyale.com, tied to a whitelisted IP address. Tip: use RoyaleAPI's proxy IP `45.79.218.79` as the allowed IP so it works from any network.
- **No third-party data API** — RoyaleAPI shut down their public developer API in March 2020. Their website (royaleapi.com) is still live but has no programmatic access.
- **Card upgrade data** is hardcoded in JS based on the official wiki (levels 1–16, all 5 rarities: common, rare, epic, legendary, champion)

---

## App structure — screens (bottom nav)

| Nav item    | Screen ID       | Description |
|-------------|-----------------|-------------|
| Home        | `screen-home`   | API key setup + navigation cards |
| Calculator  | `screen-calc`   | Offline upgrade cost calculator |
| Lookup      | `screen-lookup` | Player profile lookup by tag |
| Clan        | `screen-clan`   | Clan lookup by tag |

---

## Player profile — tabs (after loading a player tag)

| Tab          | ID                  | Data source |
|--------------|---------------------|-------------|
| Overview     | `tab-overview`      | `/players/{tag}` — upgrade insights, battle stats, donations, league stats, favourite card |
| Cards        | `tab-cards`         | `/players/{tag}` — full card collection with filters (status, rarity, sort) |
| Battles      | `tab-battles`       | `/players/{tag}/battlelog` — last ~25 battles with decks, crowns, trophy change |
| Decks        | `tab-decks`         | Derived from battle log — win rates per unique deck, mode filter, copy button |
| Achievements | `tab-achievements`  | `/players/{tag}` — all achievements with star rating and progress bars |

---

## Key JS functions

| Function | What it does |
|---|---|
| `loadPlayer()` | Fetches `/players/{tag}` and `/battlelog` in parallel, calls `renderProfile()` |
| `renderProfile(data, battles)` | Renders all profile tabs |
| `renderCards()` | Re-renders card list with current filters/sort |
| `renderBattles(battles)` | Renders battle log tab |
| `renderDeckBuilder(battles)` | Aggregates decks from battles, stores in `window._deckMapData` |
| `_renderDeckList(deckMap, battles)` | Re-renders deck tab (called by filter changes too) |
| `setDeckFilter(mode)` | Filters deck list by game mode |
| `renderAchievements(achievements)` | Renders achievements tab |
| `loadClan()` | Fetches `/clans/{tag}`, calls `renderClan()` |
| `renderClan(data)` | Renders clan header + member list |
| `renderMembers(members)` | Re-renders member list with current sort |
| `setClanSort(by)` | Sorts member list by rank/trophies/donations/role |
| `maybeLoadCards()` | Fetches `/cards` once and caches in `allCards` (for calc card picker) |
| `onCardSearch(query)` | Filters card list and shows dropdown |
| `selectCard(id)` | Picks a card, auto-fills rarity in calculator |
| `copyDeckLink(cardNames, btnEl)` | Copies card names to clipboard |
| `calcUpdate()` | Recomputes upgrade calculator results |
| `computeUpgrade(rarity, currentLevel, currentCount, targetLevel)` | Core upgrade math |
| `apiGet(path)` | Wraps corsproxy.io + fetch with auth header |
| `goTo(name)` | Switches between main screens |
| `switchTab(name)` | Switches between profile tabs |
| `formatBattleTime(ts)` | Converts API timestamp to relative time ("2h ago") |

---

## API endpoints used

| Endpoint | Used for |
|---|---|
| `GET /players/{tag}` | Player profile, cards, stats, achievements |
| `GET /players/{tag}/battlelog` | Recent battles |
| `GET /clans/{tag}` | Clan info + member list |
| `GET /cards` | Full card list for calculator card picker |

### Endpoints available but NOT yet implemented

| Endpoint | Could be used for |
|---|---|
| `GET /locations/{id}/rankings/players` | Global/local leaderboard |
| `GET /locations/{id}/rankings/clans` | Clan leaderboard |
| `GET /clans/{tag}/warlog` | Past clan war results |
| `GET /clans/{tag}/currentwar` | Live war state |
| `GET /tournaments/{tag}` | Tournament details |

---

## Upgrade data (hardcoded)
Stored in `LEVEL_DATA` object — arrays of `{cards, gold, xp}` per level transition for each rarity. Index 0 = upgrade from level 1→2, index 14 = 15→16.

`MIN_LEVEL` maps rarity to starting display level: common=1, rare=3, epic=6, legendary=9, champion=11.

The API returns relative levels (e.g. legendary starts at 1 in the API). `toDisplayLevel()` converts to display level (1–16).

---

## Known limitations / things to be aware of
- The Clash Royale API only returns the last **~25 battles**, so deck win rate stats are based on a small sample
- The CORS proxy (`corsproxy.io`) is a free public service — occasionally slow or down
- API keys are IP-locked; users on mobile data need a separate key or use the RoyaleAPI proxy IP
- `upcomingchests` endpoint exists in the API spec but was removed from the game — don't implement it
- No real-time meta deck data is available from any public API — RoyaleAPI's developer API shut down in 2020

---

## Deployment — full guide (repo to phone)

### Step 1 — Push files to GitHub
```bash
git clone https://github.com/Jellybean2560/Clash-Royale-Optimizer.git
cd Clash-Royale-Optimizer
```
Copy `index.html`, `.github/workflows/deploy.yml`, and `README.md` into the folder, then:
```bash
git add .
git commit -m "Initial web app"
git push origin main
```

### Step 2 — Enable GitHub Pages
1. Go to the repo on GitHub: `github.com/Jellybean2560/Clash-Royale-Optimizer`
2. Settings → Pages (left sidebar)
3. Under **Source**, select **GitHub Actions**

### Step 3 — Wait for deployment (~1 minute)
Go to the **Actions** tab — watch for "Deploy to GitHub Pages" to show a green ✓. App is then live at:
`https://jellybean2560.github.io/Clash-Royale-Optimizer/`

### Step 4 — Get a Clash Royale API key
1. Go to developer.clashroyale.com and create an account
2. Click username → My Account → Create New Key
3. Google "what is my IP" and paste that IP into the allowed IPs field
4. Copy the generated token — paste it into the app's Home screen

> **Note:** The key is IP-locked. On mobile data you need a second key, or use the RoyaleAPI proxy IP `45.79.218.79` as the allowed IP — it works from any network.

### Step 5 — Install on Android (PWA)
Open Chrome on Android, go to the GitHub Pages URL, then:
1. Tap the three-dot menu (⋮) → "Add to Home Screen"
2. Name it (e.g. Clash Calc Pro) → tap Add

Launches fullscreen with no browser UI. Calculator works fully offline; only player/clan lookup needs internet.

### Optional — Generate a real APK
1. Go to webintoapp.com
2. Enter the GitHub Pages URL, give the app a name and icon
3. Download the APK
4. On Android: Settings → Apps → Special app access → Install unknown apps → allow browser → open APK to install

---

## Build history
1. Cloned and analyzed original Replit monorepo (Node.js/Express backend + Kotlin Android app)
2. Extracted all card upgrade data and API logic from `artifacts/api-server/src/routes/player.ts`
3. Rebuilt entire app as single `index.html` — no backend, CORS proxy via corsproxy.io
4. Added GitHub Actions deploy workflow
5. Added extra player stats (3-crown wins, challenge wins, donations, league stats, favourite card)
6. Added battle log tab — parallel fetch of `/battlelog` alongside player data
7. Added achievements tab with star ratings and progress bars
8. Restructured profile tabs (Overview, Cards, Battles, Decks, Achievements)
9. Added deck builder tab — aggregates decks from battle log, W/L/D per unique deck, win rate bar, avg elixir, mode filter
10. Added clan lookup screen as new nav tab — fetches `/clans/{tag}`, sortable member list
11. Added card picker to calculator — fetches `/cards`, searchable dropdown that auto-fills rarity
12. Added copy deck button to each deck in the Decks tab
