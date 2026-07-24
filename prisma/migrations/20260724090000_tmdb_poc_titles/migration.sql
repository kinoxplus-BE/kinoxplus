ALTER TABLE "Title" ADD COLUMN "backdropUrl" TEXT;
ALTER TABLE "Title" ADD COLUMN "tmdbId" INTEGER;
ALTER TABLE "Title" ADD COLUMN "pocPlaybackUrl" TEXT;

CREATE UNIQUE INDEX "Title_tmdbId_key" ON "Title"("tmdbId");
