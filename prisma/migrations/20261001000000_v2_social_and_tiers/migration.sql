-- CreateEnum
CREATE TYPE "FriendRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PLUS', 'PREMIUM');

-- CreateTable
CREATE TABLE "FriendRequest" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "status" "FriendRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FriendRequest_senderId_receiverId_key"
    ON "FriendRequest"("senderId", "receiverId");

-- CreateIndex
CREATE INDEX "FriendRequest_receiverId_status_idx"
    ON "FriendRequest"("receiverId", "status");

-- CreateIndex
CREATE INDEX "FriendRequest_senderId_status_idx"
    ON "FriendRequest"("senderId", "status");

-- AddForeignKey
ALTER TABLE "FriendRequest"
    ADD CONSTRAINT "FriendRequest_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendRequest"
    ADD CONSTRAINT "FriendRequest_receiverId_fkey"
    FOREIGN KEY ("receiverId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_titleId_key"
    ON "WatchlistItem"("userId", "titleId");

-- CreateIndex
CREATE INDEX "WatchlistItem_userId_createdAt_idx"
    ON "WatchlistItem"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "WatchlistItem"
    ADD CONSTRAINT "WatchlistItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem"
    ADD CONSTRAINT "WatchlistItem_titleId_fkey"
    FOREIGN KEY ("titleId") REFERENCES "Title"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Plan"
    ADD COLUMN "tier" "PlanTier" NOT NULL DEFAULT 'FREE',
    ADD COLUMN "maxRoomMembers" INTEGER NOT NULL DEFAULT 4,
    ADD COLUMN "maxVideoHeight" INTEGER NOT NULL DEFAULT 720,
    ADD COLUMN "maxSessionMinutes" INTEGER,
    ADD COLUMN "canHDScreenShare" BOOLEAN NOT NULL DEFAULT false;
