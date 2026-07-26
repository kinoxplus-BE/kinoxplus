# KinoX+ Frontend Video Playback Integration

This is the implementation handoff for React Native/web playback after the
Cloudflare Stream backend integration. The frontend should not talk to
Cloudflare directly and should not build video URLs by itself.

Base API:

```text
https://kinoxplus.onrender.com
```

Swagger:

```text
https://kinoxplus.onrender.com/api/docs
```

## Core Rule

Use the backend as the source of truth:

```text
Catalog screen -> title.id -> playback endpoint -> video player
```

Do not use `streamVideoId` on the frontend. The backend keeps Cloudflare IDs
private and returns a signed playable HLS URL only when the user is allowed to
watch.

## Response Envelope

Successful responses are wrapped:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Errors are wrapped:

```json
{
  "success": false,
  "error": {
    "code": "SUBSCRIPTION_REQUIRED",
    "message": "An active subscription is required to play content."
  }
}
```

## 1. Auth Requirement

Catalog browsing is public, but playback requires:

```http
Authorization: Bearer ACCESS_TOKEN
```

Use the access token from login/register/refresh. If playback returns `401`,
refresh the token if possible, then retry once.

## 2. Fetch The Home Feed

Recommended first-screen endpoint:

```http
GET /catalog/home?limitPerGenre=12
```

Example:

```ts
const res = await api.get('/catalog/home', {
  params: { limitPerGenre: 12 },
});

const rows = res.data.data.rows;
```

Response shape:

```json
{
  "success": true,
  "data": {
    "rows": [
      {
        "genre": "Drama",
        "titles": [
          {
            "id": "cm...",
            "slug": "movie-title-2026",
            "name": "Movie Title",
            "description": "Short synopsis",
            "type": "MOVIE",
            "year": 2026,
            "durationSec": 7200,
            "posterUrl": "https://...",
            "backdropUrl": "https://...",
            "status": "READY",
            "genres": []
          }
        ]
      }
    ]
  },
  "meta": {}
}
```

Use `posterUrl` for cards and `backdropUrl` for the detail hero.

## 3. Browse All Titles

For a grid/list:

```http
GET /catalog/titles?limit=20
```

For next page:

```http
GET /catalog/titles?limit=20&cursor=NEXT_CURSOR
```

For genre:

```http
GET /catalog/titles?genre=Drama&limit=20
```

Read the next cursor from:

```ts
const nextCursor = res.data.meta.nextCursor;
```

If `nextCursor` is `null`, there is no next page.

## 4. Title Detail

When the user opens a movie detail page:

```http
GET /catalog/titles/:slug
```

Example:

```ts
const res = await api.get(`/catalog/titles/${title.slug}`);
const titleDetail = res.data.data;
```

The detail response still does not include a playable URL. Only request playback
when the user taps Play.

## 5. Get The Playable URL

When the user taps Play:

```http
GET /streaming/titles/:titleId/playback
Authorization: Bearer ACCESS_TOKEN
```

Example:

```ts
async function getPlaybackUrl(titleId: string) {
  const res = await api.get(`/streaming/titles/${titleId}/playback`);
  return res.data.data as {
    url: string;
    provider: 'cloudflare-stream' | 'poc-hls';
  };
}
```

Expected Cloudflare response:

```json
{
  "success": true,
  "data": {
    "url": "https://videodelivery.net/.../manifest/video.m3u8",
    "provider": "cloudflare-stream"
  },
  "meta": {}
}
```

The URL is signed and time-limited. Fetch a fresh playback URL every time the
user starts or resumes a full watch session. Do not persist it as the movie URL.

## 6. React Native Playback

Use an HLS-capable player such as `expo-video` or `react-native-video`.

Pseudo-flow:

```ts
async function onPressPlay(titleId: string) {
  setLoading(true);
  try {
    const playback = await getPlaybackUrl(titleId);
    navigation.navigate('VideoPlayer', {
      titleId,
      playbackUrl: playback.url,
      provider: playback.provider,
    });
  } finally {
    setLoading(false);
  }
}
```

Example with a generic video component:

```tsx
<Video
  source={{ uri: route.params.playbackUrl }}
  controls
  resizeMode="contain"
  paused={false}
  onError={(error) => {
    // Show retry UI. On retry, call playback endpoint again for a fresh URL.
  }}
/>
```

Android needs an ExoPlayer-backed player. iOS plays HLS natively.

## 7. Web Playback

Safari can play HLS directly. Chrome/Firefox usually need `hls.js` or a player
that includes it, such as video.js.

Minimal `hls.js` flow:

```ts
import Hls from 'hls.js';

function attachHls(videoEl: HTMLVideoElement, url: string) {
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
    return;
  }

  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    return () => hls.destroy();
  }

  throw new Error('HLS playback is not supported on this browser.');
}
```

## 8. Loading And Error UX

Handle these playback errors:

```text
401 UNAUTHORIZED
```

User is not logged in or token expired. Refresh token/re-login.

```text
403 SUBSCRIPTION_REQUIRED
```

User does not have an active subscription. Navigate to subscription/payment.

```text
404 TITLE_NOT_PLAYABLE
```

Title is not `READY`, has no playable Cloudflare stream, or has been removed.
Show "This title is not available right now."

```text
502 CLOUDFLARE_STREAM_ERROR
503 CLOUDFLARE_STREAM_UNCONFIGURED
```

Temporary backend/provider issue. Show retry/support message.

## 9. Poor Network Behavior

For mobile users in weak network regions:

- Show poster/backdrop while requesting playback URL.
- Start the player only after the playback URL request succeeds.
- On video error, retry by requesting a fresh playback URL.
- Do not prefetch playback URLs for many movies; signed URLs expire and this
  wastes bandwidth.
- Use catalog `/home` rather than many parallel genre requests on app launch.
- Cache catalog JSON/images locally, but not signed playback URLs.

## 10. End-To-End User Flow

```text
1. App opens.
2. GET /catalog/home?limitPerGenre=12.
3. Render rows of movie cards.
4. User taps a movie.
5. GET /catalog/titles/:slug.
6. User taps Play.
7. GET /streaming/titles/:titleId/playback with Bearer token.
8. Backend returns signed Cloudflare HLS URL.
9. App opens video player with data.url.
10. User watches full video.
```

## 11. Quick Curl Test

Catalog:

```bash
curl "https://kinoxplus.onrender.com/catalog/titles?limit=5"
```

Playback:

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  "https://kinoxplus.onrender.com/streaming/titles/TITLE_ID/playback"
```

If playback is wired to Cloudflare correctly, `data.provider` should be:

```json
"cloudflare-stream"
```
