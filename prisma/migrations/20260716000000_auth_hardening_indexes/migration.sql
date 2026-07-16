-- Auth hardening: index the real OTP lookup shape and the cleanup-by-expiry
-- scans (CleanupProcessor prunes RefreshToken/OtpChallenge past retention).

-- DropIndex
DROP INDEX "OtpChallenge_identifier_idx";

-- CreateIndex
CREATE INDEX "OtpChallenge_identifier_purpose_createdAt_idx" ON "OtpChallenge"("identifier", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
