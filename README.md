# GRAFLIX Backend

Digital entertainment platform. Core differentiator: **synced Watch Rooms** — watch together, in perfect sync, with voice + text chat.

> **Read [AGENTS.md](./AGENTS.md) first.** It is the single source of truth for architecture, the Socket.io event contract, the build order, and scope discipline.

**Stack:** TypeScript · NestJS 11 (Express) · Prisma 7 · PostgreSQL 16 · Redis 7 · Socket.io · LiveKit · Cloudflare Stream · BullMQ · Paystack/Flutterwave

## Quickstart

```bash
# 1. Infra (Postgres + Redis)
docker compose up -d

# 2. Env
cp .env.example .env          # dev defaults already work with docker-compose

# 3. Install, migrate, seed
npm install
npx prisma migrate dev --name init
npm run db:seed

# 4. Run
npm run start:dev             # http://localhost:3000/health
```

## Layout

```
src/
├── common/          # decorators, guards, interceptors, filters, shared DTOs
├── config/          # zod-validated env (app refuses to boot if invalid)
├── prisma/          # PrismaService (pg driver adapter)
├── redis/           # RedisService + Socket.io Redis adapter
├── modules/
│   ├── auth/        # [sprint 2] JWT + refresh rotation + OTP
│   ├── users/       # profiles, FCM devices
│   ├── catalog/     # titles, genres (public browse)
│   ├── rooms/       # ⭐ Watch Rooms — gateway + control plane (LIVE)
│   ├── streaming/   # [sprint 3] Cloudflare Stream behind VideoProvider seam
│   ├── livekit/     # voice tokens + server-side mute enforcement
│   ├── subscriptions/ payments/ notifications/ chat/ admin/
│   └── recommendations/ analytics/   # [POST-MVP] structure only
├── jobs/            # BullMQ queues + processors
└── webhooks/        # raw-body controllers (Paystack, Flutterwave, Stream, LiveKit)
```

## Status vs. build order (AGENTS.md §14)

1. ✅ Bootstrap — config validation, Prisma, Redis, health, pipes/filters/interceptors
2. ⬜ Auth + Users (stubs in place, throttled routes wired)
3. ⬜ Catalog + Streaming (catalog live; Stream provider stubbed behind interface)
4. ✅ **Watch Rooms — control plane** (gateway, host authority, sync + heartbeat, chat)
5. 🟡 Watch Rooms — voice plane (token minting + mute enforcement done; webhooks reconcile pending)
6. ⬜ Subscriptions + Payments (entitlement checks live; checkout/webhook processing pending)
7. ⬜ Notifications + Admin + hardening
8. ⬜ [POST-MVP] Recommendations, Analytics, live video, DMs
