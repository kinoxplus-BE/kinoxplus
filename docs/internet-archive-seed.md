# Internet Archive Public-Domain Seed

This seed adds genuine playable public-domain/open-license titles without
changing the frontend API contract.

Samuel's frontend keeps using:

```http
GET /catalog/titles
GET /catalog/titles/:slug
GET /streaming/titles/:titleId/playback
```

## What The Seed Does

1. Reads the curated whitelist in `src/scripts/public-domain-archive-catalog.ts`.
2. Fetches each item from `https://archive.org/metadata/:identifier`.
3. Picks a usable MP4 file.
4. Upserts a `Title` row with `status=READY`.
5. Stores the real Archive MP4 in `Title.pocPlaybackUrl`.
6. Stores Archive thumbnail URLs in `posterUrl` and `backdropUrl`.
7. Clears `catalog:*` Redis cache keys.

## Run Locally Against Render

Set Render's Postgres and Redis URLs in your local shell, then run:

```powershell
$env:DATABASE_URL="postgresql://...?sslmode=require"
$env:REDIS_URL="redis://..."
npm run db:seed:archive
```

When running from your laptop, use Render's **external** Postgres URL and keep
`sslmode=require` on the URL. The internal Render database URL can be used by
Render services, but it is not the best choice for local scripts.

Then test:

```powershell
curl.exe "https://kinoxplus.onrender.com/catalog/titles?limit=10"
curl.exe "https://kinoxplus.onrender.com/catalog/titles?genre=Comedy&limit=10"
```

Playback still requires login:

```powershell
curl.exe -H "Authorization: Bearer ACCESS_TOKEN" `
  "https://kinoxplus.onrender.com/streaming/titles/TITLE_ID/playback"
```

## Optional Switches

```env
ARCHIVE_SEED_LIMIT=8
ARCHIVE_SEED_REQUEST_TIMEOUT_MS=30000
ARCHIVE_SEED_MAX_SIZE_BYTES=1500000000
ARCHIVE_SEED_ARCHIVE_TMDB_POC=false
ARCHIVE_SEED_ARCHIVE_DISABLED_TITLES=false
ARCHIVE_SEED_INCLUDE_LEGAL_REVIEW_TITLES=false
```

Use `ARCHIVE_SEED_ARCHIVE_TMDB_POC=true` only when you are ready to hide the old
TMDB demo titles whose metadata did not match the sample playback streams.

Use `ARCHIVE_SEED_ARCHIVE_DISABLED_TITLES=true` to hide curated Archive titles
that were previously seeded but later moved behind legal/source review.

Use `ARCHIVE_SEED_INCLUDE_LEGAL_REVIEW_TITLES=true` only after reviewing titles
marked `requiresLegalReview` in the curated list.

## Cloudflare Stream Later

The current seed plays directly from Archive MP4 URLs. The next production step
is a backend-only migration that copies these public URLs into Cloudflare Stream,
waits for Stream readiness, then switches the same `Title` rows to
`streamVideoId`. Samuel's frontend still does not change.

Source docs:

- Internet Archive metadata API: https://doc-tools.readthedocs.io/en/ia-test-gsod/md-read.html
- Internet Archive search API: https://doc-tools.readthedocs.io/en/ia-test-gsod/item-search-apis.html
- Internet Archive copyright caution: https://archivesupport.zendesk.com/hc/en-us/articles/360017808151-Movies-and-Videos-A-Basic-Guide
