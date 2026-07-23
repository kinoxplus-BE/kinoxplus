-- TOTP 2FA: opt-in second factor on the login flow.
-- Flow: /auth/2fa/setup (secret + QR) → /auth/2fa/enable (verify TOTP,
-- returns 10 backup codes) → login now returns a challenge instead of
-- tokens → /auth/2fa/challenge (TOTP or backup code → tokens).

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "twoFactorSecret"  TEXT;

-- CreateTable
CREATE TABLE "TwoFactorBackupCode" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorBackupCode_codeHash_key"
  ON "TwoFactorBackupCode"("codeHash");
CREATE INDEX "TwoFactorBackupCode_userId_idx"
  ON "TwoFactorBackupCode"("userId");

-- AddForeignKey
ALTER TABLE "TwoFactorBackupCode"
  ADD CONSTRAINT "TwoFactorBackupCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
