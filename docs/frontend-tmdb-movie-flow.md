# Frontend Movie Catalog + Playback Integration

This is the React Native/Web handoff for the current KinoX+ POC movie flow.
The backend may seed either TMDB demo metadata or genuine Internet Archive
public-domain/open-license titles, but the frontend API contract stays the
same.

Important: the frontend must not call TMDB directly and must never receive the
TMDB API token. TMDB is backend-only seed data. The app consumes KinoX+ catalog
and playback APIs.

## Base URLs

```text
API: https://kinoxplus.onrender.com
Swagger: https://kinoxplus.onrender.com/api/docs
OpenAPI JSON: https://kinoxplus.onrender.com/api/docs-json
Socket.io rooms namespace: https://kinoxplus.onrender.com/rooms
```

Every HTTP response is wrapped:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

## 1. Authentication

Users can browse catalog without auth, but playback, room creation, room join,
chat, and voice require a bearer token.

### Login

```http
POST /auth/login
Content-Type: application/json
```

```json
{
  "identifier": "user@example.com",
  "password": "password123",
  "device": {
    "platform": "android",
    "deviceName": "Samsung A54",
    "appVersion": "1.0.0"
  }
}
```

Success:

```ts
const { accessToken, refreshToken, user } = response.data;
```

Store `accessToken` and `refreshToken` securely. On React Native, use Keychain
or Keystore-backed storage, not plain AsyncStorage.

If the response has `requiresTwoFactor: true`, complete:

```http
POST /auth/2fa/challenge
```

```json
{
  "challengeToken": "token-from-login",
  "code": "123456"
}
```

### Refresh

```http
POST /auth/refresh
Content-Type: application/json
```

```json
{
  "refreshToken": "current-refresh-token"
}
```

The backend rotates refresh tokens. Always replace both stored tokens with the
new pair.

## 2. Fetch Genres

Use genres to render category chips/tabs and to filter catalog rows.

```http
GET /catalog/genres
```

Response:

```json
{
  "success": true,
  "data": [
    { "id": "genre-id", "name": "Action" },
    { "id": "genre-id", "name": "Comedy" }
  ],
  "meta": {}
}
```

Use `genre.name` as the filter value for `/catalog/titles?genre=Comedy`.

## 3. Fetch Movies

### Recommended First Screen

Use this for the Netflix-style home screen. It is a single cached backend
request, so it is better for mobile users and poor network regions than firing
many category requests at once.

```http
GET /catalog/home?limitPerGenre=12
```

Response shape:

```json
{
  "success": true,
  "data": {
    "rows": [
      {
        "genre": "Comedy",
        "titles": [
          {
            "id": "title-id",
            "slug": "movie-slug",
            "name": "Movie Name",
            "posterUrl": "https://image.tmdb.org/t/p/w500/...",
            "backdropUrl": "https://image.tmdb.org/t/p/w780/...",
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

### All Movies / Pagination

```http
GET /catalog/titles?limit=20
```

Next page:

```http
GET /catalog/titles?limit=20&cursor=NEXT_CURSOR
```

Response shape:

```json
{
  "success": true,
  "data": [
    {
      "id": "title-id",
      "slug": "movie-slug",
      "name": "Movie Name",
      "description": "Plot summary",
      "type": "MOVIE",
      "year": 2026,
      "durationSec": 7140,
      "posterUrl": "https://image.tmdb.org/t/p/w500/...",
      "backdropUrl": "https://image.tmdb.org/t/p/w780/...",
      "status": "READY",
      "createdAt": "2026-07-24T12:00:00.000Z",
      "updatedAt": "2026-07-24T12:00:00.000Z",
      "genres": [
        {
          "titleId": "title-id",
          "genreId": "genre-id",
          "genre": { "id": "genre-id", "name": "Comedy" }
        }
      ]
    }
  ],
  "meta": {
    "nextCursor": "next-title-id-or-null"
  }
}
```

### Category Rows

To fetch only one category:

```http
GET /catalog/titles?genre=Comedy&limit=20
GET /catalog/titles?genre=Drama&limit=20
GET /catalog/titles?genre=Action&limit=20
```

For extra category pages, call `/catalog/titles?genre=<name>&limit=20` and
paginate with `cursor`.

The backend already filters unsafe/unpleasant POC titles out of catalog
responses.

## 4. Movie Detail

When a user taps a poster:

```http
GET /catalog/titles/:slug
```

Example:

```http
GET /catalog/titles/the-devil-wears-prada-2-2026-tmdb-1314481
```

Use this screen to show:

- `backdropUrl` as hero image.
- `posterUrl` as cover.
- `name`, `year`, `durationSec`, `description`.
- `genres.map(item => item.genre.name)`.
- Buttons: Play, Start Watch Room.

## 5. Playback

Do not play directly from catalog data. Catalog responses intentionally do not
include playback URLs. When the user taps Play:

```http
GET /streaming/titles/:titleId/playback
Authorization: Bearer ACCESS_TOKEN
```

Response:

```json
{
  "success": true,
  "data": {
    "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "provider": "poc-hls"
  },
  "meta": {}
}
```

For the POC, `provider` will usually be `poc-hls`; that value can point to a
public HLS stream or a legal public-domain/open-license MP4 from Internet
Archive. Later, licensed Cloudflare content will return `cloudflare-stream`.

React Native example:

```tsx
<Video
  source={{ uri: playbackUrl }}
  controls
  resizeMode="contain"
  style={{ width: '100%', height: 240 }}
/>
```

If playback returns `SUBSCRIPTION_REQUIRED`, use an admin account or an account
with an active subscription for testing.

## 6. Create Watch Room

Host selects a title, then:

```http
POST /rooms
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
```

```json
{
  "titleId": "title-id",
  "isPrivate": true,
  "maxMembers": 20
}
```

Response includes room `id`, `code`, `hostId`, `titleId`, and room title info.
Share `code` with invited users.

## 7. Join Watch Room

Guest enters invite code:

```http
GET /rooms/code/:code
Authorization: Bearer ACCESS_TOKEN
```

Then fetch the playable URL for `room.title.id`:

```http
GET /streaming/titles/:titleId/playback
Authorization: Bearer ACCESS_TOKEN
```

Then connect to Socket.io:

```ts
import { io } from 'socket.io-client';

const socket = io('https://kinoxplus.onrender.com/rooms', {
  transports: ['websocket'],
  auth: { token: accessToken },
});
```

Join room:

```ts
socket.emit('room:join', { roomId }, (res) => {
  // res.room
  // res.state.positionSec
  // res.state.isPlaying
  // res.state.serverTs
  // res.members
});
```

## 8. Sync Playback In Room

Listen for authoritative state:

```ts
socket.on('sync:state', ({ positionSec, isPlaying, serverTs }) => {
  const expectedPosition = isPlaying
    ? positionSec + (Date.now() - serverTs) / 1000
    : positionSec;

  // If local video differs by more than about 1.5s, seek to expectedPosition.
  // Otherwise adjust playbackRate slightly to converge.
});
```

Host-only controls:

```ts
socket.emit('control:play', { roomId, positionSec });
socket.emit('control:pause', { roomId, positionSec });
socket.emit('control:seek', { roomId, positionSec });
```

Host heartbeat every about 2 seconds:

```ts
socket.emit('control:heartbeat', {
  roomId,
  positionSec: currentVideoTime,
  ts: Date.now(),
});
```

Other room events:

```ts
socket.on('member:joined', ({ user }) => {});
socket.on('member:left', ({ userId }) => {});
socket.on('member:updated', ({ userId, isMuted }) => {});
socket.on('room:ended', ({ roomId }) => {});
socket.on('error', ({ code, message }) => {});
```

## 9. Room Chat

Send:

```ts
socket.emit('chat:send', {
  roomId,
  body: 'This scene is good',
});
```

Listen:

```ts
socket.on('chat:message', (message) => {
  // message.id
  // message.user
  // message.body
  // message.createdAt
});
```

History:

```http
GET /rooms/:roomId/messages?limit=50
Authorization: Bearer ACCESS_TOKEN
```

## 10. Voice Token

After joining a room:

```http
POST /rooms/:roomId/voice-token
Authorization: Bearer ACCESS_TOKEN
```

Response:

```json
{
  "success": true,
  "data": {
    "token": "livekit-token",
    "roomName": "graflix-room-room-id"
  },
  "meta": {}
}
```

Use the returned token with the LiveKit client SDK.

## 11. Frontend Types

Recommended title type:

```ts
type CatalogTitle = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: 'MOVIE' | 'SERIES' | 'EPISODE';
  year: number | null;
  durationSec: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  status: 'READY';
  genres: Array<{
    titleId: string;
    genreId: string;
    genre: { id: string; name: string };
  }>;
};

type PlaybackResponse = {
  url: string;
  provider: 'poc-hls' | 'cloudflare-stream';
};

type CatalogHomeResponse = {
  rows: Array<{
    genre: string;
    titles: CatalogTitle[];
  }>;
};
```

## 12. POC Legal/Content Notes

- TMDB metadata is for catalog display only.
- Internet Archive seeded titles are genuine public-domain/open-license titles
  where the title and playback file match.
- Old TMDB POC playback URLs are legal demo/open sample streams, not the actual
  TMDB movies.
- Add this attribution in Settings/About:

```text
This product uses the TMDB API but is not endorsed or certified by TMDB.
```

## 13. Quick Manual Test

```bash
curl "https://kinoxplus.onrender.com/catalog/titles?limit=5"
curl "https://kinoxplus.onrender.com/catalog/home?limitPerGenre=6"
curl "https://kinoxplus.onrender.com/catalog/genres"
curl "https://kinoxplus.onrender.com/catalog/titles?genre=Comedy&limit=5"
```

Playback requires an access token:

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  "https://kinoxplus.onrender.com/streaming/titles/TITLE_ID/playback"
```
