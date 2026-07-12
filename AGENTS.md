# GRAFLIX — Backend Scaffold & Architecture Guide

> Digital entertainment platform. Core differentiator: **synced Watch Rooms** (watch together, in perfect sync, with voice + text chat).
> This document is the single source of truth for scaffolding and building the backend. It doubles as an `AGENTS.md`-style context file for a coding assistant.

**Stack:** TypeScript · NestJS (on Express) · Prisma 7 · PostgreSQL · Redis · Socket.io · LiveKit · Cloudflare Stream · BullMQ · Paystack/Flutterwave

---

## 0. Read this first — scope discipline

GRAFLIX as fully specified (Netflix + Zoom + WhatsApp + AI recs across iOS/Android/Web/Admin) is **four products in one**. This scaffold is architected for the full vision but you build in the MVP order below. Do **not** scaffold every module in sprint one.

**MVP (build first):** Auth · Users · Catalog · **Watch Rooms (sync + voice + text)** · Subscriptions (single tier) · Notifications.

**Post-MVP (structure now, build later — clearly marked `[POST-MVP]`):** Live video calling · full Messaging/DM platform · AI Recommendations · Analytics dashboard · advanced admin tooling.

**Two hard constraints that live outside your code — confirm with the client in writing:**
1. **Content licensing is the client's responsibility.** You build the ingest/stream pipeline; the client supplies content that is *legally cleared* with proof of chain-of-title. If premium licensed content is involved, the contract will likely mandate **DRM**, which pushes video from Cloudflare Stream → Mux.
2. **Store billing (Apple/Google) generally requires in-app purchase for mobile digital subscriptions** (15–30% cut). Paystack/Flutterwave handle the **web** flow. Decide this before wiring payments.

**FX flag:** every third-party service here is USD-billed. Model naira→USD exposure before quoting.

---

## 1. Architecture principles

1. **Modular monolith.** One deployable NestJS app, split into strong feature modules with clear boundaries. Do **not** start with microservices/Kubernetes — premature distribution kills small teams. The module structure below makes future extraction cheap if ever needed.
2. **Three-plane separation for Watch Rooms** — the most important design rule:
   - **Playback plane** — each client independently pulls the same HLS stream from the CDN. Video **never** touches your server or the realtime layer. This is what makes rooms scale.
   - **Control plane** — admin `play/pause/seek/heartbeat` events broadcast over **Socket.io**. Tiny messages. Server-authoritative (never trust a client claiming to be admin).
   - **Voice plane** — WebRTC via **LiveKit** SFU. Text chat rides Socket.io.
3. **Stateless API.** No session state in process memory. All room/presence/session state in **Redis** so you can run N API instances behind a load balancer.
4. **Validate at the boundary.** Every inbound payload (HTTP + WebSocket) is validated before it touches business logic. Payments and room control flow through here — trust nothing.
5. **Thin controllers, fat services, isolated integrations.** Third-party SDKs (LiveKit, Cloudflare, Paystack) live behind provider modules so they're swappable and testable.

---

## 2. Tech stack (locked)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | `strict: true`, no implicit any |
| Framework | NestJS 11 (Express adapter) | Modules/DI give structure a multi-feature app needs |
| ORM | Prisma 7 (driver-adapter) | `@prisma/adapter-pg` |
| Database | PostgreSQL 16 | Render/Neon/Supabase for MVP |
| Cache / PubSub / Presence | Redis 7 | Upstash for MVP |
| Realtime (control + chat) | Socket.io 4 + `@socket.io/redis-adapter` | Redis adapter = multi-instance rooms |
| Realtime (voice/video) | LiveKit (Cloud, free tier for MVP) | Apache-2.0; self-host later |
| Video (VOD) | Cloudflare Stream | Swap → Mux if DRM required |
| Object storage | Cloudflare R2 / S3 | thumbnails, avatars |
| Background jobs | BullMQ (on Redis) | webhooks, emails, transcode polling |
| Email | Brevo / Resend | transactional + OTP |
| SMS OTP | Termii | cheaper for NG numbers than Twilio |
| Payments (web) | Paystack / Flutterwave | recurring billing + webhooks |
| Payments (mobile) | Store IAP | digital subs per store policy |
| Push | Firebase Cloud Messaging | iOS + Android |
| Auth | JWT (access+refresh) + Argon2 | own it in-app |
| Validation | `class-validator` + `class-transformer` (Nest-native) or Zod | pick one, be consistent |
| Logging | `nestjs-pino` | structured logs from day one |
| Errors | Sentry | day one |
| Testing | Jest + Supertest | unit + e2e |
| Containerization | Docker + docker-compose | local parity |
| CI/CD | GitHub Actions | lint/test/build/deploy |

---

## 3. Directory structure

```
graflix-backend/
├── src/
│   ├── main.ts                     # bootstrap, global pipes, Redis IO adapter
│   ├── app.module.ts
│   ├── common/                     # cross-cutting
│   │   ├── decorators/             # @CurrentUser, @Roles, @Public
│   │   ├── guards/                 # JwtAuthGuard, RolesGuard, SubscriptionGuard
│   │   ├── interceptors/           # response envelope, logging
│   │   ├── filters/                # global exception filter
│   │   ├── pipes/                  # validation
│   │   └── dto/                    # shared DTOs (pagination, etc.)
│   ├── config/                     # typed config (env schema validated at boot)
│   ├── prisma/                     # PrismaService + module
│   ├── redis/                      # RedisService (ioredis) + module
│   ├── modules/
│   │   ├── auth/                   # login, register, refresh, OTP
│   │   ├── users/                  # profiles, devices (FCM tokens)
│   │   ├── catalog/                # titles, genres, search
│   │   ├── rooms/                  # ⭐ Watch Rooms: gateway + service
│   │   ├── streaming/              # Cloudflare Stream provider (upload/playback)
│   │   ├── livekit/                # token minting, mute control, webhooks
│   │   ├── subscriptions/          # plans, entitlements
│   │   ├── payments/               # Paystack/Flutterwave + webhooks
│   │   ├── notifications/          # FCM + in-app
│   │   ├── chat/                   # room text chat (+ [POST-MVP] DMs)
│   │   ├── admin/                  # admin-only endpoints
│   │   ├── recommendations/        # [POST-MVP] pgvector-based
│   │   └── analytics/              # [POST-MVP] event ingestion
│   ├── jobs/                       # BullMQ processors
│   └── webhooks/                   # raw-body webhook controllers
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── test/
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── nest-cli.json
├── tsconfig.json
└── package.json
```

---

## 4. Environment variables (`.env.example`)

```env
# Core
NODE_ENV=development
PORT=3000
API_URL=http://localhost:3000
WEB_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://localhost:3000

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/graflix?schema=public

# Redis
REDIS_URL=redis://localhost:6379

# Auth
JWT_ACCESS_SECRET=change_me
JWT_ACCESS_TTL=900            # 15m
JWT_REFRESH_SECRET=change_me
JWT_REFRESH_TTL=2592000       # 30d
ARGON2_MEMORY_COST=19456

# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# Cloudflare Stream
CF_ACCOUNT_ID=
CF_STREAM_API_TOKEN=
CF_STREAM_SIGNING_KEY_ID=
CF_STREAM_SIGNING_KEY_PEM=    # for signed playback URLs

# Cloudflare R2 (or S3)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=graflix-assets

# Payments
PAYSTACK_SECRET_KEY=
PAYSTACK_WEBHOOK_SECRET=
FLUTTERWAVE_SECRET_KEY=
FLUTTERWAVE_WEBHOOK_HASH=

# Email / SMS
BREVO_API_KEY=
TERMII_API_KEY=
TERMII_SENDER_ID=GRAFLIX

# Push
FCM_PROJECT_ID=
FCM_CLIENT_EMAIL=
FCM_PRIVATE_KEY=

# Observability
SENTRY_DSN=
```

> Validate this at boot with a config schema (Zod or Joi). App should **refuse to start** if a required var is missing.

---

## 5. Data model (Prisma schema)

MVP-focused, extensible. `[POST-MVP]` models are stubbed so migrations don't churn later.

```prisma
// prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ---------- Identity ----------
model User {
  id             String    @id @default(cuid())
  email          String?   @unique
  phone          String?   @unique
  passwordHash   String?
  displayName    String
  avatarUrl      String?
  role           Role      @default(USER)
  emailVerified  Boolean   @default(false)
  phoneVerified  Boolean   @default(false)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  devices        Device[]
  refreshTokens  RefreshToken[]
  subscription   Subscription?
  ownedRooms     Room[]         @relation("RoomHost")
  memberships    RoomMember[]
  chatMessages   ChatMessage[]
  watchHistory   WatchHistory[]

  @@index([role])
}

enum Role {
  USER
  ADMIN
  SUPPORT
}

model Device {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  fcmToken  String   @unique
  platform  String   // ios | android | web
  createdAt DateTime @default(now())

  @@index([userId])
}

model RefreshToken {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String   @unique
  expiresAt  DateTime
  revokedAt  DateTime?
  createdAt  DateTime @default(now())

  @@index([userId])
}

model OtpChallenge {
  id         String   @id @default(cuid())
  identifier String   // email or phone
  codeHash   String
  purpose    String   // login | verify | reset
  expiresAt  DateTime
  consumedAt DateTime?
  attempts   Int      @default(0)
  createdAt  DateTime @default(now())

  @@index([identifier])
}

// ---------- Catalog ----------
model Title {
  id            String    @id @default(cuid())
  slug          String    @unique
  name          String
  description   String?
  type          TitleType @default(MOVIE)
  year          Int?
  durationSec   Int?
  posterUrl     String?
  // Cloudflare Stream video id (null until ingested & ready)
  streamVideoId String?   @unique
  status        TitleStatus @default(DRAFT)
  // licensing metadata — proof the client cleared rights
  licenseSource String?
  licenseExpiry DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  genres        GenreOnTitle[]
  rooms         Room[]
  watchHistory  WatchHistory[]

  @@index([status])
  @@index([type])
}

enum TitleType { MOVIE, SERIES, EPISODE }
enum TitleStatus { DRAFT, PROCESSING, READY, ARCHIVED }

model Genre {
  id     String @id @default(cuid())
  name   String @unique
  titles GenreOnTitle[]
}

model GenreOnTitle {
  titleId String
  genreId String
  title   Title @relation(fields: [titleId], references: [id], onDelete: Cascade)
  genre   Genre @relation(fields: [genreId], references: [id], onDelete: Cascade)
  @@id([titleId, genreId])
}

// ---------- Watch Rooms (⭐ core) ----------
model Room {
  id           String     @id @default(cuid())
  code         String     @unique          // shareable invite code
  hostId       String
  host         User       @relation("RoomHost", fields: [hostId], references: [id])
  titleId      String
  title        Title      @relation(fields: [titleId], references: [id])
  status       RoomStatus @default(LOBBY)
  isPrivate    Boolean    @default(true)
  maxMembers   Int        @default(20)
  // authoritative playback state (also cached in Redis for hot reads)
  positionSec  Float      @default(0)
  isPlaying    Boolean    @default(false)
  lastSyncAt   DateTime   @default(now())
  createdAt    DateTime   @default(now())
  endedAt      DateTime?

  members      RoomMember[]
  messages     ChatMessage[]

  @@index([hostId])
  @@index([status])
}

enum RoomStatus { LOBBY, PLAYING, PAUSED, ENDED }

model RoomMember {
  id        String   @id @default(cuid())
  roomId    String
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  isMuted   Boolean  @default(false)   // admin-controlled voice mute
  joinedAt  DateTime @default(now())
  leftAt    DateTime?

  @@unique([roomId, userId])
  @@index([roomId])
}

model ChatMessage {
  id        String   @id @default(cuid())
  roomId    String
  room      Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  body      String
  createdAt DateTime @default(now())

  @@index([roomId, createdAt])
}

// ---------- Subscriptions & Payments ----------
model Plan {
  id            String   @id @default(cuid())
  name          String
  priceKobo     Int      // store minor units (kobo). Naira * 100
  currency      String   @default("NGN")
  intervalDays  Int      @default(30)
  isActive      Boolean  @default(true)
  subscriptions Subscription[]
}

model Subscription {
  id          String   @id @default(cuid())
  userId      String   @unique
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  planId      String
  plan        Plan     @relation(fields: [planId], references: [id])
  status      SubStatus @default(INACTIVE)
  provider    String    // paystack | flutterwave | apple | google
  providerRef String?
  currentPeriodEnd DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  payments    Payment[]
}

enum SubStatus { INACTIVE, ACTIVE, PAST_DUE, CANCELLED }

model Payment {
  id             String   @id @default(cuid())
  subscriptionId String?
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id])
  provider       String
  providerRef    String   @unique
  amountKobo     Int
  currency       String   @default("NGN")
  status         PayStatus @default(PENDING)
  rawPayload     Json?
  createdAt      DateTime @default(now())

  @@index([status])
}

enum PayStatus { PENDING, SUCCESS, FAILED, REFUNDED }

// ---------- History / [POST-MVP] ----------
model WatchHistory {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  titleId     String
  title       Title    @relation(fields: [titleId], references: [id], onDelete: Cascade)
  positionSec Float    @default(0)
  completed   Boolean  @default(false)
  updatedAt   DateTime @updatedAt

  @@unique([userId, titleId])
  @@index([userId])
}
```

**Prisma 7 driver-adapter setup** (`src/prisma/prisma.service.ts`):

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    super({ adapter });
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

---

## 6. ⭐ Watch Room sync — the Socket.io event contract

This is the heart of the product. The **control plane** only. Video is fetched independently by each client; voice is on LiveKit.

### Connection & namespace
- Namespace: `/rooms`
- Auth: client sends JWT in `handshake.auth.token`; a WS guard validates it and attaches `userId`.
- Redis adapter is mandatory so events fan out across instances.

### Authority rules (enforce server-side, every time)
- Only `room.hostId === socket.userId` may emit `control:*` events.
- Server holds authoritative `{ positionSec, isPlaying, lastSyncAt }` in Redis (`room:{id}:state`), periodically flushed to Postgres.
- Late joiners are sent the current authoritative state and seek to it.

### Client → Server events

| Event | Who | Payload | Effect |
|---|---|---|---|
| `room:join` | any member | `{ roomId }` | validate membership → add socket to room → return current state + member list |
| `room:leave` | any member | `{ roomId }` | remove from room, mark `leftAt` |
| `control:play` | host only | `{ roomId, positionSec }` | set `isPlaying=true`, broadcast `sync:state` |
| `control:pause` | host only | `{ roomId, positionSec }` | set `isPlaying=false`, broadcast `sync:state` |
| `control:seek` | host only | `{ roomId, positionSec }` | update position, broadcast `sync:state` |
| `control:heartbeat` | host only | `{ roomId, positionSec, ts }` | authoritative tick every ~2s to correct drift |
| `chat:send` | any member | `{ roomId, body }` | persist + broadcast `chat:message` |
| `member:mute` | host only | `{ roomId, targetUserId, muted }` | set RoomMember.isMuted → call LiveKit mute → broadcast `member:updated` |
| `room:end` | host only | `{ roomId }` | status=ENDED, broadcast `room:ended`, disconnect |

### Server → Client events

| Event | Payload | Meaning |
|---|---|---|
| `sync:state` | `{ positionSec, isPlaying, serverTs }` | authoritative playback state; client reconciles |
| `member:joined` | `{ user }` | someone joined |
| `member:left` | `{ userId }` | someone left |
| `member:updated` | `{ userId, isMuted }` | mute state changed |
| `chat:message` | `{ id, user, body, createdAt }` | new chat line |
| `room:ended` | `{ roomId }` | host ended the room |
| `error` | `{ code, message }` | validation/permission failure |

### Drift correction (client-side contract)
1. On `sync:state`, compute expected position = `positionSec + (now - serverTs)/1000` if `isPlaying`.
2. If `|localPosition - expected| > 1.5s`, hard-seek. Otherwise nudge playbackRate ±5% to converge smoothly.
3. Host emits `control:heartbeat` every ~2s so all clients stay locked.

### Redis keys
```
room:{id}:state        # hash { positionSec, isPlaying, lastSyncAt }
room:{id}:members      # set of userIds present
presence:user:{id}     # socketId + roomId (TTL)
```

### Gateway skeleton (`src/modules/rooms/rooms.gateway.ts`)
```ts
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class RoomsGateway {
  @WebSocketServer() server: Server;

  constructor(
    private rooms: RoomsService,
    private livekit: LivekitService,
  ) {}

  @SubscribeMessage('control:seek')
  async onSeek(@ConnectedSocket() client: Socket, @MessageBody() dto: SeekDto) {
    await this.rooms.assertHost(dto.roomId, client.data.userId); // throws if not host
    const state = await this.rooms.setPosition(dto.roomId, dto.positionSec, client.data.userId);
    this.server.to(dto.roomId).emit('sync:state', { ...state, serverTs: Date.now() });
  }

  @SubscribeMessage('member:mute')
  async onMute(@ConnectedSocket() client: Socket, @MessageBody() dto: MuteDto) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    await this.rooms.setMuted(dto.roomId, dto.targetUserId, dto.muted);
    await this.livekit.setTrackMuted(dto.roomId, dto.targetUserId, dto.muted);
    this.server.to(dto.roomId).emit('member:updated', { userId: dto.targetUserId, isMuted: dto.muted });
  }
}
```

> **Bootstrap note:** in `main.ts`, install the Redis IO adapter so gateway events work across instances:
> ```ts
> const pubClient = createClient({ url: process.env.REDIS_URL });
> const subClient = pubClient.duplicate();
> await Promise.all([pubClient.connect(), subClient.connect()]);
> const adapter = createAdapter(pubClient, subClient);
> // apply via a custom IoAdapter subclass
> ```

---

## 7. LiveKit integration (voice plane)

- **Token minting** (`src/modules/livekit/livekit.service.ts`): backend issues a short-lived JWT scoped to the room. Room name = `graflix-room-{roomId}`. Grant `canPublish`/`canSubscribe`; host also gets `roomAdmin`.
- **Mute control:** use LiveKit server SDK `RoomServiceClient.mutePublishedTrack()` when host mutes a member — this is the server-authoritative enforcement, not just a UI flag.
- **Webhooks:** verify signature; handle `participant_joined/left` to reconcile presence.
- **[POST-MVP] video calling** uses the same room; just enable video tracks.

```ts
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

async mintToken(roomId: string, userId: string, isHost: boolean) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: userId });
  at.addGrant({ roomJoin: true, room: `graflix-room-${roomId}`, canPublish: true, canSubscribe: true, roomAdmin: isHost });
  return at.toJwt();
}
```

---

## 8. Streaming module (Cloudflare Stream)

- **Ingest:** admin uploads a title → create a Stream video (direct-creator upload or URL pull) → store `streamVideoId`, set `Title.status = PROCESSING`.
- **Ready webhook:** Stream calls back when encoding completes → set `status = READY`.
- **Signed playback:** generate signed HLS URLs (time-limited) so only entitled/subscribed users can play. Gate playback URL issuance behind `SubscriptionGuard`.
- **Player:** native HLS on iOS; `hls.js` / ExoPlayer elsewhere.
- **DRM note:** if licensing requires DRM, Cloudflare Stream is insufficient → migrate this module to Mux. Keep the provider behind an interface (`VideoProvider`) so the swap is contained.

---

## 9. Payments module

- **Web:** initialize a Paystack/Flutterwave transaction → redirect/checkout → **verify via webhook** (never trust the client redirect alone).
- **Webhook controller** needs the **raw body** for signature verification — configure a raw-body route (`rawBody: true` in Nest, or `express.raw()` for that path only) before JSON parsing.
- **Idempotency:** dedupe on `providerRef`; a webhook can fire more than once.
- **Entitlement:** on successful payment → upsert `Subscription` to `ACTIVE`, set `currentPeriodEnd`. A `SubscriptionGuard` checks this before serving playback URLs.
- **Mobile:** verify Apple/Google receipts server-side; treat store notifications like webhooks. Keep provider logic isolated.
- **BullMQ:** offload webhook post-processing (emails, entitlement grants) to a queue so the webhook returns `200` fast.

---

## 10. Auth module

- **Register/login:** email+password (Argon2id) or **phone+OTP** (Termii). OTP codes hashed in `OtpChallenge`, rate-limited, short TTL, max attempts.
- **Tokens:** short-lived access JWT (15m) + rotating refresh token (hashed in `RefreshToken`, 30d). Rotate on every refresh; revoke on logout.
- **Guards:** `JwtAuthGuard` (default global, `@Public()` opts out), `RolesGuard` for admin, `SubscriptionGuard` for gated content.
- **Never** log tokens, OTP codes, or password hashes.

---

## 11. Cross-cutting conventions

**Response envelope** (global interceptor):
```json
{ "success": true, "data": { }, "meta": { } }
```
**Errors** (global exception filter):
```json
{ "success": false, "error": { "code": "ROOM_NOT_HOST", "message": "Only the host can control playback." } }
```
- **Validation:** global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- **Pagination:** cursor-based (`?cursor=&limit=`) for lists.
- **Rate limiting:** `@nestjs/throttler` on auth + OTP + room-create endpoints.
- **IDs:** `cuid()` everywhere (already in schema).
- **Money:** store minor units (kobo) as integers. Never floats for money.
- **Time:** UTC everywhere; positions in seconds (float ok for sub-second sync).

---

## 12. Background jobs (BullMQ)

| Queue | Job | Trigger |
|---|---|---|
| `emails` | send transactional / OTP | auth, payments |
| `payments` | post-webhook entitlement + receipts | payment webhook |
| `streaming` | poll transcode / handle ready | Stream webhook |
| `notifications` | fan-out FCM push | room invites, etc. |
| `cleanup` | expire OTP, close stale rooms, prune tokens | cron |

---

## 13. Security checklist

- [ ] Helmet + strict CORS (allowlist from `CORS_ORIGINS`)
- [ ] Global validation pipe (whitelist + forbid non-whitelisted)
- [ ] Rate limiting on auth/OTP/room-create
- [ ] Argon2id password hashing; refresh tokens hashed at rest
- [ ] WS auth guard on the `/rooms` namespace; **host authority checked server-side on every `control:*`**
- [ ] Webhook signature verification (Paystack/Flutterwave/LiveKit/Stream) on raw body
- [ ] Idempotent webhook handling
- [ ] Signed, time-limited playback URLs gated by subscription
- [ ] Secrets only in env; app refuses to boot if missing
- [ ] No secrets/tokens/OTP in logs
- [ ] Prisma parameterized queries only (no raw string interpolation)
- [ ] Sentry + structured logs; audit log for admin actions

---

## 14. Setup / scaffold steps

```bash
# 1. Scaffold
npm i -g @nestjs/cli
nest new graflix-backend --package-manager npm --strict

# 2. Core deps
npm i @nestjs/config @nestjs/jwt @nestjs/throttler \
      prisma @prisma/client @prisma/adapter-pg \
      ioredis socket.io @socket.io/redis-adapter redis \
      livekit-server-sdk bullmq \
      argon2 class-validator class-transformer \
      nestjs-pino pino-http @sentry/node

npm i -D @types/node jest supertest ts-jest

# 3. Prisma
npx prisma init
# (paste schema.prisma from section 5)
npx prisma migrate dev --name init
npx prisma generate

# 4. Infra (local)
docker compose up -d   # postgres + redis

# 5. Run
npm run start:dev
```

**Build order (maps to your 1-week sprints):**
1. Bootstrap: config validation, Prisma, Redis, health check, global pipes/filters/interceptors.
2. Auth + Users (email + OTP, JWT refresh rotation, guards).
3. Catalog + Streaming (ingest a test title, signed playback, subscription gate).
4. **Watch Rooms — control plane** (Socket.io gateway, host authority, sync + drift, chat).
5. **Watch Rooms — voice plane** (LiveKit tokens, mute enforcement).
6. Subscriptions + Payments (Paystack web flow, webhooks, entitlement).
7. Notifications (FCM) + Admin endpoints + hardening (rate limits, Sentry, audit).
8. `[POST-MVP]` Recommendations (pgvector), Analytics, live video, DMs.

---

## 15. What is explicitly OUT of the MVP

Live 1:1/group **video** calling, full **DM/messaging** platform, **AI recommendations**, **analytics dashboard**, multi-tier plans, and web+iOS+Android simultaneously. Structure exists (empty modules) but do not build until the Watch Room is validated in production.

---

## 16. Client-owned prerequisites (not your code — get in writing)

1. **Legally cleared content** with proof of chain-of-title for every launch title. If premium/licensed → **DRM required** → video stack becomes Mux.
2. **Store billing decision** for mobile digital subscriptions (Apple/Google IAP vs web Paystack).
3. **Business/KYC** for Paystack/Flutterwave live keys.

---

*Keep this file at the repo root as `AGENTS.md` (or `docs/ARCHITECTURE.md`) so any coding assistant or new dev has full context. Update the build-order checklist as sprints close.*
