-- Room invitations: host invites specific users (in-app + push) or email
-- addresses (email with universal link). Powers the "invited-only visibility"
-- rule for the dashboard.

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "RoomInvitation" (
    "id"             TEXT NOT NULL,
    "roomId"         TEXT NOT NULL,
    "invitedUserId"  TEXT,
    "invitedEmail"   TEXT,
    "invitedById"    TEXT NOT NULL,
    "status"         "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomInvitation_invitedUserId_status_idx" ON "RoomInvitation"("invitedUserId", "status");
CREATE INDEX "RoomInvitation_invitedEmail_status_idx"  ON "RoomInvitation"("invitedEmail",  "status");
CREATE INDEX "RoomInvitation_roomId_idx"               ON "RoomInvitation"("roomId");

-- AddForeignKey
ALTER TABLE "RoomInvitation"
  ADD CONSTRAINT "RoomInvitation_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoomInvitation"
  ADD CONSTRAINT "RoomInvitation_invitedUserId_fkey"
  FOREIGN KEY ("invitedUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoomInvitation"
  ADD CONSTRAINT "RoomInvitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
