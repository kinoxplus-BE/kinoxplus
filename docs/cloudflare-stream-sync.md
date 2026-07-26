# Cloudflare Stream Catalog Sync

This script lists videos already uploaded to Cloudflare Stream and creates or
updates KinoX `Title` rows with the Cloudflare `uid` saved as
`Title.streamVideoId`.

It does not change Samuel's frontend contract:

```http
GET /catalog/titles
GET /catalog/titles/:slug
GET /streaming/titles/:titleId/playback
```

## Run

Use Render's external Postgres URL when running from your laptop:

```powershell
$env:DATABASE_URL="postgresql://...?sslmode=require"
$env:REDIS_URL="redis://..."
$env:CF_ACCOUNT_ID="..."
$env:CF_STREAM_API_TOKEN="..."
$env:CF_STREAM_SYNC_PUBLISH_READY="true"
$env:CF_STREAM_SYNC_LICENSE_SOURCE="Owned/licensed by KinoX+ for internal POC/demo use."
npm run stream:sync-catalog
```

Do not paste real database passwords, Cloudflare tokens, or signing keys into
chat.

## Safety Defaults

By default, videos are synced as `DRAFT` unless publishing is explicitly enabled
and a rights source is provided. This prevents unreviewed uploads from appearing
in the catalog by accident.

The script also blocks obvious unofficial download/release markers such as
`fzmovies`, `WEB-DL`, `WEBRip`, `BluRay`, torrent release markers, and similar
terms.

## Metadata

Cloudflare gives the backend the video `uid`, `meta.name`, `duration`,
`thumbnail`, `readyToStream`, and status. Better KinoX metadata can be added to
Cloudflare's video metadata before syncing:

```json
{
  "name": "Movie Title",
  "title": "Movie Title",
  "description": "Short synopsis",
  "year": "2026",
  "genres": "Drama,Action",
  "posterUrl": "https://...",
  "backdropUrl": "https://...",
  "licenseSource": "Owned/licensed by KinoX+"
}
```

If those fields are absent, the script uses sensible fallbacks and Cloudflare's
thumbnail.

## Options

```env
CF_STREAM_SYNC_LIMIT=1000
CF_STREAM_SYNC_SEARCH=
CF_STREAM_SYNC_STATUS=
CF_STREAM_SYNC_DEFAULT_GENRES=Drama
CF_STREAM_SYNC_PUBLISH_READY=false
CF_STREAM_SYNC_LICENSE_SOURCE=
CF_STREAM_SYNC_REQUIRE_SIGNED_URLS=true
CF_STREAM_SYNC_OVERWRITE_METADATA=false
CF_STREAM_SYNC_DRY_RUN=false
```

- `CF_STREAM_SYNC_PUBLISH_READY=true` publishes ready videos as `READY`, but
  only when a license source is present.
- `CF_STREAM_SYNC_LICENSE_SOURCE` is the fallback rights note when Cloudflare
  metadata does not have `licenseSource`.
- `CF_STREAM_SYNC_REQUIRE_SIGNED_URLS=true` updates Cloudflare videos so playback
  requires signed URLs, matching the backend's existing playback endpoint.
- `CF_STREAM_SYNC_DRY_RUN=true` lists what would change without writing to
  Postgres or Cloudflare.

Source docs:

- Cloudflare list videos API: https://developers.cloudflare.com/api/resources/stream/methods/list/
- Cloudflare search videos guide: https://developers.cloudflare.com/stream/manage-video-library/searching/
- Cloudflare signed URLs: https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
