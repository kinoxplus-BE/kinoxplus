-- Device management: attach client metadata to each refresh token so the
-- user can see + revoke individual sessions (Netflix's "Sign out other
-- devices" UX). See src/modules/users/sessions.controller.ts.

-- AlterTable
ALTER TABLE "RefreshToken"
  ADD COLUMN "deviceName"  TEXT,
  ADD COLUMN "deviceModel" TEXT,
  ADD COLUMN "platform"    TEXT,
  ADD COLUMN "osVersion"   TEXT,
  ADD COLUMN "appVersion"  TEXT,
  ADD COLUMN "lastUsedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastUsedIp"  TEXT;

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_expiresAt_idx"
  ON "RefreshToken"("userId", "revokedAt", "expiresAt");
