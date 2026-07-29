# KinoX+ Watch Room Frontend Integration Guide

This file is the frontend handoff for the current Watch Room implementation.
It covers the HTTP APIs, Socket.io events, room lifecycle, lobby mode, current
title swapping, playback sync, chat, voice, invitations, and moderation.

Swagger is available at:

```http
GET /api/docs
```

Swagger documents HTTP endpoints only. Socket.io events are documented in this
file.

## Core Model

A Watch Room is a persistent hangout. A room can exist with or without a movie.

- Room exists first.
- Members join the room.
- Chat and LiveKit voice work even when no movie is selected.
- The host can pick, change, or clear the current movie.
- Video playback is never streamed through the backend.
- Each client gets its own HLS playback URL and streams directly from the video provider/CDN.
- Socket.io only carries room control events, chat, and member updates.

Current title states:

- `room.title === null`: lobby mode, no movie picked.
- `room.title !== null`: a movie is selected and clients may fetch playback.

Playback controls are valid only when a title is selected. If the frontend sends
playback control events while the room has no title, the backend emits:

```json
{
  "code": "NO_TITLE_SELECTED",
  "message": "Pick a movie for the room before controlling playback (title:change)."
}
```

## Auth And Envelopes

Catalog browsing is public. Room, user, streaming, voice, and invitation APIs
require:

```http
Authorization: Bearer <access_token>
```

HTTP success responses use:

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
    "message": "Readable message"
  }
}
```

Socket errors are emitted on the `error` event:

```json
{
  "code": "ERROR_CODE",
  "message": "Readable message"
}
```

## Public Catalog Flow

Use the catalog to show movies the host can pick before or inside a room.

Home rows:

```http
GET /catalog/home?limitPerGenre=10
```

List titles:

```http
GET /catalog/titles?limit=20&cursor=<optional>&genre=<optional>
```

Title detail by slug:

```http
GET /catalog/titles/:slug
```

Genre list:

```http
GET /catalog/genres
```

Only use catalog titles with `status: "READY"` for room title selection. The
backend also validates this on room create and `title:change`.

## Main User Flows

### Flow A: Empty Lobby First

Use this when the host wants to invite friends before choosing a movie.

1. Host creates a room without `titleId`.
2. Host invites friends or shares the room code.
3. Members join the room.
4. Chat and voice can begin.
5. Host opens catalog picker.
6. Host emits `title:change`.
7. Everyone receives `title:changed`.
8. Each client fetches the playback URL for the new title.
9. Host presses play.

### Flow B: Room From Movie Page

Use this when the host starts from a movie detail page.

1. Host selects a movie.
2. Host creates a room with `titleId`.
3. Members join.
4. Each client fetches playback for that title.
5. Host controls playback.

### Flow C: Invite Mid-Watch

Use this when a room is already active.

1. Host invites users or shares code.
2. New user resolves code or opens invitation.
3. New user joins via socket.
4. Join response includes current playback state.
5. New user fetches playback for `room.title.id`.
6. New user seeks to the current synced position.

### Flow D: Change Movie Mid-Session

Use this when the host swaps the current movie while everyone stays in the room.

1. Host opens catalog picker.
2. Host emits `title:change`.
3. Backend verifies host and title readiness.
4. Backend sets `positionSec = 0`, `isPlaying = false`, and `status = "LOBBY"`.
5. Everyone receives `title:changed`.
6. Clients stop old playback, fetch the new playback URL, load the new source,
   and seek to 0.
7. Host presses play again.

### Flow E: Clear Movie Back To Lobby

Use this when the host removes the current movie.

1. Host emits `title:clear`.
2. Backend clears `room.titleId`.
3. Playback resets to 0 and paused.
4. Everyone receives `title:changed` with `title: null`.
5. Clients unload/hide the video player and show lobby UI.

## Create Room

Endpoint:

```http
POST /rooms
Content-Type: application/json
Authorization: Bearer <access_token>
```

Create empty lobby:

```json
{
  "isPrivate": true,
  "maxMembers": 20
}
```

Create room with pre-selected movie:

```json
{
  "titleId": "<title_id>",
  "isPrivate": true,
  "maxMembers": 20
}
```

If the user may already be in another active room, use:

```http
POST /rooms?force=true
```

`force=true` auto-leaves any other active room first. The old room receives:

```ts
member:left -> { userId }
```

Example response data for empty lobby:

```json
{
  "id": "<room_id>",
  "code": "Q7M4RD",
  "hostId": "<host_user_id>",
  "titleId": null,
  "status": "LOBBY",
  "isPrivate": true,
  "maxMembers": 20,
  "positionSec": 0,
  "isPlaying": false,
  "title": null
}
```

Example response data with a selected movie:

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

```text
TITLE_NOT_FOUND
ALREADY_IN_ROOM
```

Frontend behavior for `ALREADY_IN_ROOM`:

1. Show a confirmation prompt.
2. If user confirms, retry the same action with `force=true`.

## Resolve Room Code

Use this when a user opens `/join/:code` or enters a code manually.

```http
GET /rooms/code/:code
Authorization: Bearer <access_token>
```

Example:

```http
GET /rooms/code/Q7M4RD
```

Response data:

```json
{
  "id": "<room_id>",
  "code": "Q7M4RD",
  "hostId": "<host_user_id>",
  "titleId": null,
  "status": "LOBBY",
  "isPrivate": true,
  "maxMembers": 20,
  "title": null
}
```

or, if a movie is selected:

```json
{
  "id": "<room_id>",
  "code": "Q7M4RD",
  "hostId": "<host_user_id>",
  "titleId": "<title_id>",
  "status": "PLAYING",
  "isPrivate": true,
  "maxMembers": 20,
  "title": {
    "id": "<title_id>",
    "name": "Movie Name",
    "slug": "movie-name"
  }
}
```

Resolving a code does not make the user a live member. They must still connect
to the socket and emit `room:join`.

## Socket Connection

Namespace:

```ts
/rooms
```

Connection:

```ts
import { io } from "socket.io-client";

const socket = io(`${API_URL}/rooms`, {
  transports: ["websocket"],
  auth: { token: accessToken }
});
```

Listen for errors:

```ts
socket.on("error", (error) => {
  console.log(error.code, error.message);
});
```

Common error codes:

```text
UNAUTHORIZED
TOKEN_INVALID
ROOM_NOT_FOUND
ROOM_NOT_MEMBER
ROOM_NOT_HOST
ROOM_INVITE_REQUIRED
ROOM_FULL
ALREADY_IN_ROOM
TITLE_NOT_FOUND
NO_TITLE_SELECTED
MEMBER_NOT_FOUND
CANNOT_KICK_HOST
ALREADY_HOST
```

## Join Room

Event:

```ts
room:join
```

Payload shape:

```ts
{
  roomId: string;
  code?: string;
  force?: boolean;
}
```

Host or active member reconnect:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

Guest joining private room by code:

```ts
socket.emit(
  "room:join",
  {
    roomId,
    code: "Q7M4RD"
  },
  onJoined
);
```

Accepting an in-app invitation:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

The backend accepts this without `code` if the user has a pending invitation.

Joining while already in another room:

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

Join response:

```json
{
  "room": {
    "id": "<room_id>",
    "code": "Q7M4RD",
    "hostId": "<host_user_id>",
    "titleId": null,
    "status": "LOBBY",
    "isPrivate": true,
    "maxMembers": 20,
    "title": null
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
      "joinedAt": "2026-07-29T12:00:00.000Z",
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

Frontend after join:

1. Store `room`, `state`, and `members`.
2. If `room.title === null`, show lobby UI and do not fetch playback.
3. If `room.title !== null`, fetch playback for `room.title.id`.
4. Apply `state` to the video player.

Private room access rules:

- New guest needs correct invite code or pending invitation.
- Host can join without code.
- Already-active member can reconnect without code.

## Current Title Events

### Pick Or Change Title

Host-only event:

```ts
socket.emit(
  "title:change",
  {
    roomId,
    titleId
  },
  (response) => {
    // response.title
    // response.state
  }
);
```

Backend behavior:

- Verifies caller is host.
- Verifies title exists and is `READY`.
- Sets room `titleId`.
- Resets `positionSec` to 0.
- Sets `isPlaying` to false.
- Sets status back to `LOBBY`.
- Broadcasts `title:changed`.

Broadcast:

```ts
socket.on("title:changed", ({ title, state }) => {
  // title is { id, name, slug } or null
  // state is reset playback state with serverTs
});
```

Example payload:

```json
{
  "title": {
    "id": "<title_id>",
    "name": "Movie Name",
    "slug": "movie-name"
  },
  "state": {
    "positionSec": 0,
    "isPlaying": false,
    "lastSyncAt": 1780000000000,
    "serverTs": 1780000000000
  }
}
```

Client reaction:

1. Stop old playback.
2. Set current room title to `title`.
3. Fetch `GET /streaming/titles/:titleId/playback`.
4. Load the new playback URL.
5. Seek to `state.positionSec`.
6. Keep paused until host sends `control:play`.

### Clear Title

Host-only event:

```ts
socket.emit(
  "title:clear",
  { roomId },
  (response) => {
    // response.title === null
    // response.state.positionSec === 0
  }
);
```

Broadcast:

```json
{
  "title": null,
  "state": {
    "positionSec": 0,
    "isPlaying": false,
    "lastSyncAt": 1780000000000,
    "serverTs": 1780000000000
  }
}
```

Client reaction:

1. Stop and unload current video.
2. Set `room.title = null`.
3. Hide playback controls.
4. Show lobby UI.
5. Keep chat and voice connected.

## Playback URL

Only call this when a title is selected.

```http
GET /streaming/titles/:titleId/playback
Authorization: Bearer <access_token>
```

Response data for demo/POC titles:

```json
{
  "url": "https://example.com/video.m3u8",
  "provider": "poc-hls"
}
```

Response data for Cloudflare Stream titles:

```json
{
  "url": "https://videodelivery.net/<signed-token>/manifest/video.m3u8",
  "provider": "cloudflare-stream"
}
```

Important errors:

```text
TITLE_NOT_PLAYABLE
SUBSCRIPTION_REQUIRED
```

Client rule:

- If `room.title === null`, do not call playback.
- If `title:changed` provides a title, call playback for that title.
- If `title:changed` provides `null`, unload playback.

## Initial Playback Sync

Use this after `room:join` or after `title:changed`.

```ts
function getExpectedPosition(state: {
  positionSec: number;
  isPlaying: boolean;
  serverTs: number;
}) {
  if (!state.isPlaying) return state.positionSec;
  return state.positionSec + (Date.now() - state.serverTs) / 1000;
}

async function applyPlaybackState(video: HTMLVideoElement, state) {
  video.currentTime = getExpectedPosition(state);

  if (state.isPlaying) {
    await video.play();
  } else {
    video.pause();
  }
}
```

## Host Playback Controls

Show these controls only for the host and only when `room.title !== null`.

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

Heartbeat every about 2 seconds while host is present and a title is selected:

```ts
const heartbeatTimer = setInterval(() => {
  if (!isHost || !room.title) return;

  socket.emit("control:heartbeat", {
    roomId,
    positionSec: video.currentTime,
    ts: Date.now()
  });
}, 2000);
```

All clients listen for sync state:

```ts
socket.on("sync:state", async (state) => {
  if (!room.title) return;

  const expected = state.positionSec +
    (state.isPlaying ? (Date.now() - state.serverTs) / 1000 : 0);

  const drift = Math.abs(video.currentTime - expected);
  if (drift > 1.5) {
    video.currentTime = expected;
  }

  if (state.isPlaying) {
    await video.play();
  } else {
    video.pause();
  }
});
```

Small drift improvement:

- If drift is less than or equal to 1.5 seconds, optionally nudge playbackRate
  between `0.95` and `1.05` until the client converges.
- Reset playbackRate to `1` once synced.

## Member Events

Maintain the live member list with these events:

```ts
socket.on("member:joined", ({ user }) => {});
socket.on("member:left", ({ userId }) => {});
socket.on("member:offline", ({ userId }) => {});
socket.on("member:updated", ({ userId, isMuted }) => {});
socket.on("member:kicked", ({ userId }) => {});
socket.on("you:kicked", ({ roomId }) => {});
socket.on("host:transferred", ({ oldHostId, newHostId }) => {});
socket.on("room:ended", ({ roomId }) => {});
```

Meaning:

- `member:joined`: add or mark member online.
- `member:left`: remove user from active member list.
- `member:offline`: show offline/disconnected but do not remove membership.
- `member:updated`: update mute state.
- `member:kicked`: remove target user from active members.
- `you:kicked`: current user was kicked; leave room UI immediately.
- `host:transferred`: update host controls.
- `room:ended`: close room UI and navigate away.

Force-leave behavior:

- If user A is in Room X and joins/creates Room Y with `force=true`, Room X
  receives `member:left` for user A.
- The gateway removes A's socket from Room X.
- Room Y receives `member:joined` when A joins Room Y.

## Chat

Load message history:

```http
GET /rooms/:roomId/messages?limit=50&cursor=<optional>
Authorization: Bearer <access_token>
```

Send message:

```ts
socket.emit("chat:send", {
  roomId,
  body: "Hello everyone"
});
```

Receive message:

```ts
socket.on("chat:message", (message) => {
  // { id, user, body, createdAt }
});
```

Chat requires active room membership. It does not require a selected movie.

## Live Chat, Audio Call, And Video Call Flow

This is the exact flow the frontend should follow when building the social layer
inside a Watch Room.

### Step 1: Resolve Or Create The Room

If user has a room code:

```http
GET /rooms/code/:code
Authorization: Bearer <access_token>
```

If user is creating a new lobby room:

```http
POST /rooms
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "isPrivate": true,
  "maxMembers": 20
}
```

If user is creating a room from a movie page:

```http
POST /rooms
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "titleId": "<title_id>",
  "isPrivate": true,
  "maxMembers": 20
}
```

### Step 2: Connect To Socket.io

```ts
const socket = io(`${API_URL}/rooms`, {
  transports: ["websocket"],
  auth: { token: accessToken }
});
```

### Step 3: Join The Room

By code:

```ts
socket.emit("room:join", { roomId, code }, onJoined);
```

By pending invite:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

After `room:join` succeeds, the user is allowed to use live chat, audio, and
video.

### Step 4: Live Text Chat

Fetch chat history:

```http
GET /rooms/:roomId/messages?limit=50&cursor=<optional>
Authorization: Bearer <access_token>
```

Send chat message:

```ts
socket.emit("chat:send", {
  roomId,
  body: "Hello everyone"
});
```

Receive chat message:

```ts
socket.on("chat:message", (message) => {
  // { id, user, body, createdAt }
});
```

### Step 5: Get LiveKit Details For Audio/Video

Call this after `room:join` succeeds:

```http
POST /rooms/:roomId/voice-token
Authorization: Bearer <access_token>
```

Response data:

```json
{
  "token": "<livekit_token>",
  "roomName": "kinoxplus-room-<room_id>",
  "livekitUrl": "wss://your-project.livekit.cloud"
}
```

The frontend should pass `livekitUrl` and `token` to the LiveKit client. The
frontend should not hardcode LiveKit project URLs per environment.

### Step 6: Audio Call

Use the LiveKit client SDK:

```ts
await livekitRoom.connect(livekitUrl, token);
await livekitRoom.localParticipant.setMicrophoneEnabled(true);
```

Render/subscribe to remote participant audio tracks through LiveKit SDK events.

Host server-side audio mute:

```ts
socket.emit("member:mute", {
  roomId,
  targetUserId,
  muted: true
});
```

Host mute all:

```ts
socket.emit("member:mute-all", { roomId }, (response) => {
  // { muted: number }
});
```

Everyone should listen for mute state:

```ts
socket.on("member:updated", ({ userId, isMuted }) => {});
```

### Step 7: Video Call

There is no separate backend endpoint for video. Use the same LiveKit response
from:

```http
POST /rooms/:roomId/voice-token
```

The token allows publish and subscribe, so camera tracks are frontend-controlled:

```ts
await livekitRoom.connect(livekitUrl, token);
await livekitRoom.localParticipant.setCameraEnabled(true);
```

Render/subscribe to remote participant video tracks through LiveKit SDK events.

Current backend limitation:

- `member:mute` and `member:mute-all` enforce audio mute only.
- There is not yet a backend event for forcing a member's camera off.
- Users can locally enable/disable camera from the frontend.

## Voice

Get LiveKit token after joining the room:

```http
POST /rooms/:roomId/voice-token
Authorization: Bearer <access_token>
```

Response data:

```json
{
  "token": "<livekit_token>",
  "roomName": "kinoxplus-room-<room_id>",
  "livekitUrl": "wss://your-project.livekit.cloud"
}
```

Use `livekitUrl` and `token` with the LiveKit client SDK. This same endpoint is
used for both audio calls and video calls.

Important error:

```text
LIVEKIT_NOT_CONFIGURED
```

Voice works in lobby mode. It does not require a selected movie.

## Invitations

Host invites users by email or user id:

```http
POST /rooms/:roomId/invitations
Content-Type: application/json
Authorization: Bearer <access_token>

{
  "emails": ["friend@example.com"],
  "userIds": ["<user_id>"]
}
```

Response data:

```json
{
  "invited": 1,
  "skippedAlreadyMembers": 0,
  "skippedAlreadyInvited": 0
}
```

Notes:

- Max 20 invitees per request.
- Duplicates against pending invites are skipped.
- Existing members are skipped.
- A lobby room invitation is valid even when `room.title` is null.

Invitee dashboard:

```http
GET /users/me/invitations
Authorization: Bearer <access_token>
```

Response rows include:

```json
{
  "id": "<invitation_id>",
  "createdAt": "2026-07-29T12:00:00.000Z",
  "expiresAt": "2026-07-30T12:00:00.000Z",
  "room": {
    "id": "<room_id>",
    "code": "Q7M4RD",
    "status": "LOBBY",
    "isPrivate": true,
    "maxMembers": 20,
    "title": null,
    "host": {
      "id": "<host_user_id>",
      "displayName": "Ada",
      "username": "ada",
      "avatarUrl": null,
      "avatarColor": "#3652D9"
    }
  }
}
```

If `room.title` is null, render a lobby invitation state such as:

```text
Ada invited you to a Watch Room. No movie picked yet.
```

Decline invitation:

```http
DELETE /rooms/:roomId/invitations/:invitationId
Authorization: Bearer <access_token>
```

Accept invitation:

```ts
socket.emit("room:join", { roomId }, onJoined);
```

No invite code is required if the user has a pending invitation.

## Host Moderation

Mute or unmute one member:

```ts
socket.emit("member:mute", {
  roomId,
  targetUserId,
  muted: true
});
```

Room receives:

```ts
member:updated -> { userId: targetUserId, isMuted: true }
```

Mute all non-host members:

```ts
socket.emit("member:mute-all", { roomId }, (response) => {
  // { muted: number }
});
```

Kick member:

```ts
socket.emit("member:kick", {
  roomId,
  targetUserId
});
```

Room receives:

```ts
member:kicked -> { userId: targetUserId }
```

Kicked user receives:

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

Room receives:

```ts
host:transferred -> { oldHostId, newHostId }
```

Moderation works in lobby mode. It does not require a selected movie.

## Leave And End Room

User leaves:

```ts
socket.emit("room:leave", { roomId }, (response) => {
  // { left: true }
});
```

Others receive:

```ts
member:left -> { userId }
```

Host ends room:

```ts
socket.emit("room:end", { roomId });
```

Everyone receives:

```ts
room:ended -> { roomId }
```

When a room ends:

- Room status becomes `ENDED`.
- Pending invitations expire.
- Socket.io room membership is cleared.
- Clients should close the room screen.

## UI State Machine

Recommended room UI states:

### Loading

- Resolve code or use known room id.
- Connect socket.
- Emit `room:join`.

### Lobby No Title

Condition:

```ts
room.title === null
```

Show:

- Member list
- Chat
- Voice controls
- Invite button
- Host movie picker

Hide:

- Video player
- Play/pause/seek controls
- Playback URL fetch

### Title Selected But Paused

Condition:

```ts
room.title !== null && state.isPlaying === false
```

Show:

- Video player loaded with playback URL
- Waiting/play prompt
- Host controls if current user is host

### Playing

Condition:

```ts
room.title !== null && state.isPlaying === true
```

Show:

- Video player
- Synced playback state
- Host controls if current user is host

### Ended Or Kicked

Condition:

```ts
room:ended received
```

or:

```ts
you:kicked received
```

Navigate out of the room.

## Suggested Frontend Implementation Order

1. Build catalog picker from `/catalog/home` or `/catalog/titles`.
2. Build create room from movie page using `POST /rooms` with `titleId`.
3. Build create empty lobby using `POST /rooms` without `titleId`.
4. Handle `ALREADY_IN_ROOM` and retry with `force=true` after confirmation.
5. Build join-by-code route using `GET /rooms/code/:code`.
6. Connect to `/rooms` socket with JWT.
7. Emit `room:join` and render returned room/member state.
8. Add lobby UI for `room.title === null`.
9. Add playback URL fetch only when a title exists.
10. Add `title:change` and `title:clear` host flows.
11. Add `title:changed` listener for all clients.
12. Add host playback controls and heartbeat.
13. Add `sync:state` drift correction.
14. Add chat.
15. Add LiveKit voice token and voice controls.
16. Add invite creation, invite dashboard, decline, and accept flows.
17. Add member list events.
18. Add moderation: mute, mute-all, kick, transfer host, end room.

## Quick API/Event Checklist

HTTP:

- `GET /catalog/home`
- `GET /catalog/titles`
- `GET /catalog/titles/:slug`
- `GET /catalog/genres`
- `POST /rooms`
- `POST /rooms?force=true`
- `GET /rooms/code/:code`
- `GET /rooms/:roomId/messages`
- `POST /rooms/:roomId/voice-token`
- `POST /rooms/:roomId/invitations`
- `DELETE /rooms/:roomId/invitations/:invitationId`
- `GET /users/me/invitations`
- `GET /streaming/titles/:titleId/playback`

Socket client-to-server:

- `room:join`
- `room:leave`
- `title:change`
- `title:clear`
- `control:play`
- `control:pause`
- `control:seek`
- `control:heartbeat`
- `chat:send`
- `member:mute`
- `member:mute-all`
- `member:kick`
- `host:transfer`
- `room:end`

Socket server-to-client:

- `title:changed`
- `sync:state`
- `member:joined`
- `member:left`
- `member:offline`
- `member:updated`
- `member:kicked`
- `you:kicked`
- `host:transferred`
- `chat:message`
- `room:ended`
- `error`

## Swagger Coverage

Swagger shows the HTTP side:

- `POST /rooms` has optional `titleId`.
- `POST /rooms` has optional `force` query.
- `RoomInvitationDto.room.title` is nullable.
- Playback URL, invitations, messages, and voice-token endpoints are listed.

Swagger does not show Socket.io events. Use this guide for all socket contracts.
