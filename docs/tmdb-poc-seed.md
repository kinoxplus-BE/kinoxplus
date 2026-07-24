# TMDB POC Catalog Seed

Use this only for prototype catalog data. TMDB supplies metadata and images; the
temporary playback URLs are public demo/open sample streams. Replace them with
properly licensed Cloudflare Stream videos before production.

## Env

Add this to `.env` locally or Render when seeding against Render Postgres:

```env
TMDB_READ_ACCESS_TOKEN=your_tmdb_read_access_token
TMDB_SEED_LIMIT=100
TMDB_LANGUAGE=en-US
```

The script also accepts `TMDB_TOKEN` as a fallback, but
`TMDB_READ_ACCESS_TOKEN` is clearer.

## Run Locally

```bash
npm run prisma:deploy
npm run prisma:generate
npm run db:seed
npm run db:seed:tmdb
```

`db:seed` creates the plan and canonical genres. `db:seed:tmdb` then pulls
popular movies from TMDB and upserts READY `Title` rows by `tmdbId`.

## Run On Render

After the commit is deployed, open the `kinoxplus-api` Shell on Render and run:

```bash
node dist/scripts/seed-tmdb.js
```

The Render `preDeployCommand` already runs `npx prisma migrate deploy`, so the
new columns should exist before the seed runs.

## What Gets Written

- `Title.tmdbId` for idempotent re-runs.
- `Title.posterUrl` and `Title.backdropUrl` from TMDB image config.
- `Title.name`, `description`, `year`, `durationSec`, and genres.
- `Title.pocPlaybackUrl` with one of the public demo/open streams.
- `Title.streamVideoId` stays empty until real Cloudflare Stream ingest.

Playback remains behind:

```text
GET /streaming/titles/:titleId/playback
```

For POC titles the endpoint returns:

```json
{ "url": "https://...", "provider": "poc-hls" }
```

For future Cloudflare titles it returns:

```json
{ "url": "https://...", "provider": "cloudflare-stream" }
```

## Attribution

Add this to the mobile app settings/about screen before any public demo:

```text
This product uses the TMDB API but is not endorsed or certified by TMDB.
```
