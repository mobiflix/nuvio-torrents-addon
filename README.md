# Nuvio Torrents — Cloudflare Worker Addon

Stremio/Nuvio-compatible addon na nagbibigay ng 1080p torrent magnet links mula sa:
- **YTS** — movies
- **EZTV** — series
- **1337x** (via apibay) — series

## Features
- 1080p only
- Minimum 15 seeders
- Sorted by seeders (highest first)
- Auto-detect X265/HDR/Atmos/DTS/5.1

## Deploy sa Cloudflare Workers

### Option A: Wrangler CLI
```bash
npm install
npx wrangler login
npx wrangler deploy
