-- Signup wizard fields: username handle, DOB, bio, avatar color, and
-- preferred genres (step 2 chips) on User.

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "avatarColor" TEXT,
  ADD COLUMN "bio" TEXT,
  ADD COLUMN "dateOfBirth" TIMESTAMP(3),
  ADD COLUMN "preferredGenres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
