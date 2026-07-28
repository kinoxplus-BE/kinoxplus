-- Make Room.titleId nullable so a room can exist in a "lobby" state with
-- no movie picked. Host swaps the current title mid-session via the
-- title:change socket event.

-- DropForeignKey
ALTER TABLE "Room" DROP CONSTRAINT "Room_titleId_fkey";

-- AlterColumn
ALTER TABLE "Room" ALTER COLUMN "titleId" DROP NOT NULL;

-- AddForeignKey (SET NULL so a deleted title just clears the current room's
-- title instead of cascading — rooms outlive individual titles).
ALTER TABLE "Room"
  ADD CONSTRAINT "Room_titleId_fkey"
  FOREIGN KEY ("titleId") REFERENCES "Title"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
