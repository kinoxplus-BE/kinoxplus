import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { GENRES } from '../src/common/constants/genres';
import { PrismaClient, TitleStatus } from '../src/generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main(): Promise<void> {
  // Single MVP tier (multi-tier plans are POST-MVP).
  await prisma.plan.upsert({
    where: { id: 'plan-standard' },
    create: {
      id: 'plan-standard',
      name: 'Standard',
      priceKobo: 250_000, // ₦2,500 — minor units, never floats for money
      currency: 'NGN',
      intervalDays: 30,
    },
    update: {},
  });

  // Canonical genres — same list the signup wizard chips and register
  // validation use, so GET /catalog/genres can never drift from them.
  for (const name of GENRES) {
    await prisma.genre.upsert({ where: { name }, create: { name }, update: {} });
  }

  // Dev-only playable title so rooms can be exercised before real ingest.
  const drama = await prisma.genre.findUniqueOrThrow({ where: { name: 'Drama' } });
  await prisma.title.upsert({
    where: { slug: 'demo-title' },
    create: {
      slug: 'demo-title',
      name: 'Demo Title',
      description: 'Seed data for local development — replace with licensed content.',
      year: 2026,
      durationSec: 5400,
      pocPlaybackUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      status: TitleStatus.READY,
      licenseSource: 'DEV SEED — not licensed',
      genres: { create: { genreId: drama.id } },
    },
    update: {},
  });

  console.log(
    `Seed complete: 1 plan, ${GENRES.length} genres, 1 demo title.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
