# KinoX+ Multi-Profile — Design Doc

> Status: **Draft, awaiting Abraham's sign-off** before implementation.
> Author: backend. Reviewers: product (Abraham), frontend (Samuel).

Netflix-style multi-profile support: one account can have many profiles ("Ada," "Ada's Kids," "Guests"). Each profile has its own watch history, recommendations, avatar, and maturity rating; subscription and payment stay on the account.

## Why now

Every real streaming app has profiles because **one account per household is the norm** — kids need their own experience, adults don't want their recommendations polluted by kids' shows, guests don't want their taste tracked. Retrofitting profiles after launch is 10× more painful than doing it now (because every read query has to change).

## Netflix's model (target)

- **Account** — the paying entity. Has email, password, subscription, payment method. That's what our `User` model is today.
- **Profile** — the *identity you watch as*. Has display name, avatar, `isKid` flag, maturity ceiling, preferred genres, watch history. **Every "user-facing" thing hangs off a profile, not an account.**
- **Session = account + profile pair.** You log in as an account, pick a profile, everything else runs in that profile's context.

## Product decisions I need you to confirm

1. **Rename `User` → `Account`?** Cleaner mental model long-term, but touches every `userId` in the codebase. Or keep `User` and treat "account" as an alias in docs. **Recommendation: keep `User`** — spend the churn on real features, not renames.

2. **How many profiles per account?** Netflix caps at 5 on their standard plan. **Recommendation: 5**, enforced server-side.

3. **Are profiles PIN-protected?** Netflix lets adult profiles have an optional PIN so kids can't switch. **Recommendation: defer.** Add later when a user actually asks.

4. **Watch Rooms — who joins?** The account or the profile? Netflix's "Watch Party" (their room feature) uses the *profile* identity — you see friends by their profile names/avatars. **Recommendation: profile.** Room ownership + membership are per-profile. If you switch profiles, you're a different person in the room.

5. **Kid profiles' maturity ceiling** — a `maturityRating` int (0–18) that filters what catalog titles they can see. **Recommendation: yes.** Simple to add now, hard to add later.

6. **Signup wizard change** — does registration create one profile automatically, or does the user pick a name/avatar for the first profile as part of the wizard? **Recommendation: auto-create a profile at register time** using `displayName` from the wizard. User adds more profiles later from settings. Zero UX friction for solo users.

**Reply here with agree/disagree per point and I'll finalize.**

## Schema changes

```prisma
model User {
  // ...existing account-level fields:
  //   email, phone, username, passwordHash, dateOfBirth, role,
  //   emailVerified, phoneVerified, twoFactor*, refreshTokens,
  //   subscription, devices
  // MOVED to Profile (see below):
  //   displayName, avatarUrl, avatarColor, bio, preferredGenres
  profiles      Profile[]
}

model Profile {
  id             String   @id @default(cuid())
  accountId      String   // FK to User; renamed only conceptually
  account        User     @relation(fields: [accountId], references: [id], onDelete: Cascade)
  name           String
  avatarUrl      String?
  avatarColor    String?
  bio            String?
  preferredGenres String[] @default([])
  isKid          Boolean  @default(false)
  maturityRating Int?     // 0-18; null = no ceiling (adult profile)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Everything scoped to this identity moves here:
  ownedRooms     Room[]         @relation("RoomHost")
  memberships    RoomMember[]
  chatMessages   ChatMessage[]
  watchHistory   WatchHistory[]

  @@index([accountId])
}
```

Migration strategy for existing users:
- For each existing `User` row, create one `Profile` with `name = user.displayName`, `avatarUrl = user.avatarUrl`, `avatarColor = user.avatarColor`, `bio = user.bio`, `preferredGenres = user.preferredGenres`.
- Repoint every `WatchHistory.userId` / `RoomMember.userId` / `ChatMessage.userId` / `Room.hostId` to the new `Profile.id`.
- Drop the moved columns from `User`.

Zero data loss. Existing users experience the change as "you now have one profile — you can add more."

## API changes

### JWT payload
Add `pid` (profile ID) alongside `sub` (account ID):

```json
{ "sub": "acc_abc", "pid": "prf_xyz", "role": "USER" }
```

Access tokens now carry the *current* profile. Switching profiles mints a new token pair. Refresh tokens are per-*session-and-profile* (so switching profile creates a new refresh row too — sessions list shows "Ada on Samuel's iPhone" as a distinct row from "Ada's Kids on Samuel's iPhone").

Alternative: keep JWT with just `sub`, put profile in a header (`X-Profile-Id`). Less clean but easier to migrate to. **Recommendation: put `pid` in the JWT.**

### Login/register responses
Instead of returning `{ user, accessToken, refreshToken }`, return:

```json
{
  "user": { ...account fields... },
  "profiles": [ { "id": "prf_1", "name": "Ada", "avatarUrl": "...", "isKid": false }, ... ],
  "requiresProfilePick": true
}
```

Client shows the profile picker → calls a new `POST /auth/profiles/:id/select` → gets `{ accessToken, refreshToken }`. **Netflix-identical flow.**

**Exception**: if the account has exactly one profile, auto-select it and return tokens directly. Solo users never see a picker they don't need.

### New endpoints

- `GET /accounts/me/profiles` (bearer) — list this account's profiles
- `POST /accounts/me/profiles` (bearer) — create (max 5)
- `PATCH /accounts/me/profiles/:id` (bearer) — edit name / avatar / isKid / maturityRating
- `DELETE /accounts/me/profiles/:id` (bearer) — soft delete or hard? **Recommendation: hard delete but require account password re-confirmation.** Prevents accidental history loss.
- `POST /auth/profiles/:id/select` (bearer, account-level access) — mint tokens scoped to that profile

### Existing endpoints that change

| Endpoint | Change |
|---|---|
| `GET /users/me` | Splits into `GET /accounts/me` (account data) + `GET /profiles/me` (current profile data). Or keep `/users/me` returning both. |
| `PATCH /users/me` | Only edits account fields now (email, phone). Profile edits move to `PATCH /accounts/me/profiles/:id`. |
| `GET /users/me/sessions` | Unchanged shape but each row also shows the `profileName` that was active. |
| Watch Rooms create/join | `hostId` → `hostProfileId`. Joining as a different profile = different membership row. |
| `WatchHistory` | Scoped to `profileId`. |
| Chat messages | Author is `profileId`. |
| Recommendations (post-MVP) | Scoped to `profileId`. |
| Subscription | Stays on account. |

## Files that will change

Bigger blast radius than any change we've made. Not all of these need touching, but here's the impact map:

- `prisma/schema.prisma` + one migration
- `src/modules/auth/auth.service.ts` (login response, JWT payload, `issueTokens` gets `profileId`)
- `src/modules/auth/auth.controller.ts` (profile picker endpoint)
- `src/common/guards/jwt-auth.guard.ts` (attach `profileId` to `request.user`)
- `src/common/types.ts` (`AuthUser` gains `profileId`)
- `src/modules/users/*` → possibly rename to `accounts/*`, or add a new `profiles/` module
- `src/modules/rooms/*` — every query changes `userId` → `profileId`
- `src/modules/chat/*` — same
- `src/modules/streaming/*` (WatchHistory scope)
- All frontend integration docs

## Non-goals (defer to later)

- Profile-level PINs (add when a user asks)
- Per-profile subscription tiers (Netflix doesn't have this)
- Profile transfer between accounts (rare, complex)
- Fine-grained parental controls beyond `maturityRating` (blocked titles list, time limits)

## Rollout plan

**Cannot ship in one deploy** — the API contract changes (JWT payload, login response). Two-phase rollout:

**Phase 1 (~2 days):**
- Add `Profile` table + migration + backfill
- New `/accounts/me/profiles` endpoints
- Login/register still return the old shape; also carry `profiles: [...]` as an additive field
- Frontend can start reading profiles without switching to profile-scoped mode

**Phase 2 (~2 days, after frontend is ready):**
- Add `pid` to JWT
- Login response transitions to the picker shape
- Repoint WatchHistory/Rooms/Chat to `profileId`
- Frontend fully switches to profile-scoped identity
- Drop moved columns from `User`

Total: **~4 days including frontend integration.** Compared to "not doing this now" and refactoring later = probably 2 weeks after launch.

## Alternative: don't do it

If KinoX+ is fundamentally "one user, one profile, one account" (like most social apps — X, Instagram, WhatsApp), then multi-profile is overkill and we should drop it. This is a **product decision** — the question is: do you envision one household sharing a subscription with distinct kids/adult experiences (Netflix-shaped) or one person per account (WhatsApp-shaped)?

If Netflix-shaped → yes, we build this before launch.
If WhatsApp-shaped → skip entirely.

**Recommendation: since Watch Rooms is the flagship feature and rooms are inherently social, Netflix-shaped is the right call.** Kids will absolutely be part of watch parties with cousins/friends and shouldn't be muxed into the parent's account.

## What I need from you before starting

1. Product-decision replies (the 6 numbered questions above)
2. Confirmation of the two-phase rollout (or objection)
3. When Samuel is ready to integrate — Phase 2 can't ship until the frontend handles the picker

Once you sign off, I'll open a `feat/multi-profile` branch and start Phase 1.
