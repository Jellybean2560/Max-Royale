# Clash Calc Pro

A single-file web app for Clash Royale players. No backend, no build step — runs entirely in the browser.

**Live app:** https://jellybean2560.github.io/Max-Royale/

## Features
- **Upgrade Calculator** — offline, works without an API key
- **Player Lookup** — profile, cards, battles, decks, achievements
- **Clan Lookup** — sortable member list
- **Installable on Android** as a PWA

## Setup

### 1. Get an API key
1. Go to [developer.clashroyale.com](https://developer.clashroyale.com) and sign up
2. Create a new key — use IP `45.79.218.79` as the allowed IP (works from any network)
3. Copy the token

### 2. Enter the key in the app
Open the app → Home tab → paste your API key → Save.

## Install on Android
Open the live URL in Chrome → three-dot menu → **Add to Home Screen**.

## Deploy your own copy
1. Fork this repo
2. Go to Settings → Pages → Source: **GitHub Actions**
3. Push any change to `main` — the app deploys automatically
