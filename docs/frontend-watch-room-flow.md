# KinoX+ Watch Room Frontend Flow

This is the implementation handoff for the frontend Watch Room feature. The backend separates the feature into three planes:

- Playback plane: every client streams the HLS video directly from the playback URL.
- Control plane: Socket.io sync events keep everyone at the same play/pause/seek position.
- Voice plane: LiveKit handles room voice; the backend only mints room-scoped tokens.

HTTP responses use the global envelope:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

HTTP errors use:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message."
  }
}
```

Socket errors are emitted as:

```json
{
  "code": "ERROR_CODE",
  "message": "Human readable message."
}
```

All room HTTP endpoints require:

```http
Authorization: Bearer <access_token>
```

## Current Backend Behavior

Users can only be active in one non-ended room at a time.

If the user is already in another room and tries to create or join a different room without `force=true`, the backend returns `ALREADY_IN_ROOM`.

If the user passes `force=true`, the backend marks them left in their old room first. The event-emitter fix now broadcasts this to the old room over Socket.io:

```ts
member:left -> { userId }
```

The gateway also removes the user's socket from the old Socket.io room, so the old live member list no longer stays stale.

## 1. Browse Titles

Use the catalog to let the host pick something to watch.

```http
GET /catalog/home
```

or:

```http
GET /catalog/titles?limit=20&cursor=<optional>&genre=<optional>
```

Use only titles returned by these endpoints. Room creation requires the title to be `READY`.

## 2. Create A Room

Host creates the room:

```http
POST /rooms
Content-Type: application/json

{
  "titleId": "<title_id>",
  "isPrivate": true,
  "maxMembers": 20
}
```

If the user might already be in another room, call:

```http
POST /rooms?force=true
Content-Type: application/json

{
  "titleId": "<title_id>",
  "isPrivate": true,
  "maxMembers": 20
}
```

Expected response data:

```json
{
  "id": "<room_id>",
  "code": "Q7M4RD",
  "hostId": "<host_user_id>",
  "titleId": "<title_id>",
  "status": "LOBBY",
  "isPrivate": true,
  "maxMembers": 20,
  "positionSec": 0,
  "isPlaying": false,
  "title": {
    "id": "<title_id>",
    "name": "Movie Name",
    "slug": "movie-name"
  }
}
```

Important errors:

```json
{ "code": "TITLE_NOT_FOUND", "message": "Title not found or not ready for playback." }
{ "code": "ALREADY_IN_ROOM", "message": "You're already in a room (...). Leave it first or pass force=true to auto-leave." }
```

If `ALREADY_IN_ROOM` happens, show a confirmation modal like:

```text
You are already in another Watch Room. Leave it and continue?
```

On confirm, retry with `?force=true`.

## 3. Share Or Resolve An Invite Code

Room creation returns `code`. Use it for share links, for example:

```text
https://your-frontend.com/join/Q7M4RD
```

When a guest opens a code/link:

```http
GET /rooms/code/:code
```

Example:

```http
GET /rooms/code/Q7M4RD
```

Expected response data:

```json
{
  "id": "<room_id>",
  "code": "Q7M4RD",
  "hostId": "<host_user_id>",
  "titleId": "<title_id>",
  "status": "LOBBY",
  "isPrivate": true,
  "maxMembers": 20,
  "title": {
    "id": "<title_id>",
    "name": "Movie Name",
    "slug": "movie-name"
  }
}
```

This endpoint only resolves the room. The user is not a live member until the socket `room:join` succeeds.

## 4. Connect To The Room Socket

Namespace:

```ts
/rooms
```

Connect with the access token:

```ts
import { io } from "socket.io-client";

const socket = io(`${API_URL}/rooms`, {
  transports: ["websocket"],
  auth: { token: accessToken },
});
```

Listen for auth or validation errors:

```ts
socket.on("error", (error) => {
  console.log(error.code, error.message);
});
```

## 5. Join The Room

Host or active member reconnect:

```ts
socket.emit("room:join", { roomId }, (response) => {
  // response.room
  // response.state
  // response.members
});
```

Guest joining by invite code:

```ts
socket.emit(
  "room:join",
  {
    roomId,
    code: "Q7M4RD"
  },
  (response) => {
    // Use response.state to sync initial playback.
  }
);
```

User accepting an in-app pending invitation can join without the code:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

If the user might already be in another room:

```ts
socket.emit(
  "room:join",
  {
    roomId,
    code: "Q7M4RD",
    force: true
  },
  onJoined
);
```

Expected join response:

```json
{
  "room": {
    "id": "<room_id>",
    "code": "Q7M4RD",
    "hostId": "<host_user_id>",
    "titleId": "<title_id>",
    "status": "LOBBY",
    "isPrivate": true,
    "maxMembers": 20,
    "title": {
      "id": "<title_id>",
      "name": "Movie Name",
      "slug": "movie-name"
    }
  },
  "state": {
    "positionSec": 0,
    "isPlaying": false,
    "lastSyncAt": 1780000000000,
    "serverTs": 1780000000000
  },
  "members": [
    {
      "id": "<room_member_id>",
      "roomId": "<room_id>",
      "userId": "<user_id>",
      "isMuted": false,
      "joinedAt": "2026-07-28T12:00:00.000Z",
      "leftAt": null,
      "user": {
        "id": "<user_id>",
        "displayName": "Sam",
        "avatarUrl": null
      }
    }
  ]
}
```

Important socket error codes:

```text
ROOM_INVITE_REQUIRED
ALREADY_IN_ROOM
ROOM_FULL
ROOM_NOT_FOUND
```

Private room access rules:

- A new guest needs the correct invite code, or a pending invitation.
- The host can join without a code.
- An already-active member can reconnect without a code.

## 6. Get The Playback URL

After the room is resolved or joined, fetch the title playback URL:

```http
GET /streaming/titles/:titleId/playback
```

Expected response data:

```json
{
  "url": "https://example.com/video.m3u8",
  "provider": "poc-hls"
}
```

or:

```json
{
  "url": "https://videodelivery.net/<signed-token>/manifest/video.m3u8",
  "provider": "cloudflare-stream"
}
```

Use the returned URL in the app video player. The backend does not proxy the video stream.

Possible errors:

```text
TITLE_NOT_PLAYABLE
SUBSCRIPTION_REQUIRED
```

## 7. Initial Playback Sync

When `room:join` succeeds, immediately sync the local video player to the returned state:

```ts
function expectedPosition(state) {
  if (!state.isPlaying) return state.positionSec;
  return state.positionSec + (Date.now() - state.serverTs) / 1000;
}

const position = expectedPosition(response.state);
video.currentTime = position;

if (response.state.isPlaying) {
  await video.play();
} else {
  video.pause();
}
```

## 8. Host Playback Controls

Only the host should show active play/pause/seek controls. The backend still enforces host-only authority.

Play:

```ts
socket.emit("control:play", {
  roomId,
  positionSec: video.currentTime
});
```

Pause:

```ts
socket.emit("control:pause", {
  roomId,
  positionSec: video.currentTime
});
```

Seek:

```ts
socket.emit("control:seek", {
  roomId,
  positionSec: nextPositionSec
});
```

Heartbeat every about 2 seconds while the host is in the room:

```ts
setInterval(() => {
  socket.emit("control:heartbeat", {
    roomId,
    positionSec: video.currentTime,
    ts: Date.now()
  });
}, 2000);
```

All clients listen for:

```ts
socket.on("sync:state", (state) => {
  const expected =
    state.positionSec + (state.isPlaying ? (Date.now() - state.serverTs) / 1000 : 0);

  const drift = Math.abs(video.currentTime - expected);
  if (drift > 1.5) {
    video.currentTime = expected;
  }

  if (state.isPlaying) {
    video.play();
  } else {
    video.pause();
  }
});
```

The frontend can later improve this with playbackRate nudging for small drift.

## 9. Member List Events

Maintain the live member list from these socket events:

```ts
socket.on("member:joined", ({ user }) => {});
socket.on("member:left", ({ userId }) => {});
socket.on("member:offline", ({ userId }) => {});
socket.on("member:updated", ({ userId, isMuted }) => {});
socket.on("member:kicked", ({ userId }) => {});
socket.on("host:transferred", ({ oldHostId, newHostId }) => {});
socket.on("room:ended", ({ roomId }) => {});
```

Meaning:

- `member:left`: remove the user from the active member list.
- `member:offline`: show disconnected/offline, but do not remove membership.
- `member:updated`: update mute state.
- `member:kicked`: remove user from the active member list.
- `room:ended`: close the room UI and navigate away.

Force-leave behavior:

- If user A is in Room X and joins or creates Room Y with `force=true`, Room X receives `member:left` for user A immediately.
- User A's socket is removed from Room X by the gateway.
- Room Y then receives `member:joined` when user A joins Room Y.

## 10. Chat

Load history:

```http
GET /rooms/:roomId/messages?limit=50&cursor=<optional>
```

Send:

```ts
socket.emit("chat:send", {
  roomId,
  body: "Hello everyone"
});
```

Receive:

```ts
socket.on("chat:message", (message) => {
  // { id, user, body, createdAt }
});
```

## 11. Voice

After joining the room:

```http
POST /rooms/:roomId/voice-token
```

Expected response data:

```json
{
  "token": "<livekit_token>",
  "roomName": "kinoxplus-room-<room_id>"
}
```

Use the token with the LiveKit client SDK.

If LiveKit env vars are not configured, this endpoint returns:

```text
LIVEKIT_NOT_CONFIGURED
```

## 12. Host Moderation

Mute/unmute one member:

```ts
socket.emit("member:mute", {
  roomId,
  targetUserId,
  muted: true
});
```

Mute all non-host members:

```ts
socket.emit("member:mute-all", { roomId }, (response) => {
  // { muted: number }
});
```

Kick a member:

```ts
socket.emit("member:kick", {
  roomId,
  targetUserId
});
```

The room receives:

```ts
member:kicked -> { userId: targetUserId }
```

The kicked user receives:

```ts
you:kicked -> { roomId }
```

Transfer host:

```ts
socket.emit("host:transfer", {
  roomId,
  targetUserId
});
```

The room receives:

```ts
host:transferred -> { oldHostId, newHostId }
```

## 13. Invitations

Host invites by email or user id:

```http
POST /rooms/:roomId/invitations
Content-Type: application/json

{
  "emails": ["friend@example.com"],
  "userIds": ["<user_id>"]
}
```

Expected response data:

```json
{
  "invited": 1,
  "skippedAlreadyMembers": 0,
  "skippedAlreadyInvited": 0
}
```

Invitee dashboard:

```http
GET /users/me/invitations
```

Decline invitation:

```http
DELETE /rooms/:roomId/invitations/:invitationId
```

Accept invitation:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

The backend accepts this without an invite code if the user has a pending invitation for that room.

## 14. Leave Or End Room

User leaves:

```ts
socket.emit("room:leave", { roomId }, (response) => {
  // { left: true }
});
```

Everyone else receives:

```ts
member:left -> { userId }
```

Host ends the room:

```ts
socket.emit("room:end", { roomId });
```

Everyone receives:

```ts
room:ended -> { roomId }
```

## 15. Recommended Frontend Implementation Order

1. Build the room create screen from catalog title detail.
2. On `ALREADY_IN_ROOM`, show confirm and retry with `force=true`.
3. Build join-by-code route: `/join/:code` calls `GET /rooms/code/:code`.
4. Connect to `/rooms` socket with JWT.
5. Emit `room:join` with `{ roomId, code }`.
6. Fetch playback URL and mount the player.
7. Apply returned `state` before rendering playback controls.
8. Add host-only controls and heartbeat.
9. Add member list listeners.
10. Add chat.
11. Add LiveKit voice token and voice UI.
12. Add invite dashboard and host invite UI.
13. Add moderation: mute, mute-all, kick, transfer host, end room.

## 16. Swagger Coverage

Swagger is available at:

```http
GET /api/docs
```

Swagger covers the HTTP endpoints:

- `GET /catalog/home`
- `GET /catalog/titles`
- `GET /rooms/code/:code`
- `POST /rooms`
- `POST /rooms?force=true`
- `POST /rooms/:roomId/voice-token`
- `GET /rooms/:roomId/messages`
- `POST /rooms/:roomId/invitations`
- `DELETE /rooms/:roomId/invitations/:invitationId`
- `GET /users/me/invitations`
- `GET /streaming/titles/:titleId/playback`

Swagger does not document Socket.io events. Use this file as the socket contract for `room:join`, playback control, chat, member events, moderation, and room end.
