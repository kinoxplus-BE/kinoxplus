import 'dotenv/config';
import { GENRES } from '../src/common/constants/genres';
import {
  PlanTier,
  PrismaClient,
  TitleStatus,
} from '../src/generated/prisma/client';
import { createPrismaPgAdapter } from '../src/prisma/prisma-pg-adapter';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(process.env.DATABASE_URL!),
});

async function main(): Promise<void> {
  // Three tiers for the pivot: FREE sets the baseline co-watching floor,
  // PLUS and PREMIUM lift the caps that users actually feel (room size,
  // session length, screen-share quality). Edit here if product changes
  // the gating; the enforcement reads these values at runtime via
  // SubscriptionsService.getEffectivePlan.
  await prisma.plan.upsert({
    where: { id: 'plan-free' },
    create: {
      id: 'plan-free',
      name: 'Free',
      tier: PlanTier.FREE,
      priceKobo: 0,
      currency: 'NGN',
      intervalDays: 30,
      maxRoomMembers: 4,
      maxVideoHeight: 720,
      maxSessionMinutes: 60,
      canHDScreenShare: false,
    },
    update: {
      maxRoomMembers: 4,
      maxVideoHeight: 720,
      maxSessionMinutes: 60,
      canHDScreenShare: false,
    },
  });
  await prisma.plan.upsert({
    where: { id: 'plan-plus' },
    create: {
      id: 'plan-plus',
      name: 'Plus',
      tier: PlanTier.PLUS,
      priceKobo: 250_000, // ₦2,500
      currency: 'NGN',
      intervalDays: 30,
      maxRoomMembers: 10,
      maxVideoHeight: 1080,
      maxSessionMinutes: null,
      canHDScreenShare: false,
    },
    update: {
      maxRoomMembers: 10,
      maxVideoHeight: 1080,
      maxSessionMinutes: null,
      canHDScreenShare: false,
    },
  });
  await prisma.plan.upsert({
    where: { id: 'plan-premium' },
    create: {
      id: 'plan-premium',
      name: 'Premium',
      tier: PlanTier.PREMIUM,
      priceKobo: 500_000, // ₦5,000
      currency: 'NGN',
      intervalDays: 30,
      maxRoomMembers: 20,
      maxVideoHeight: 1080,
      maxSessionMinutes: null,
      canHDScreenShare: true,
    },
    update: {
      maxRoomMembers: 20,
      maxVideoHeight: 1080,
      maxSessionMinutes: null,
      canHDScreenShare: true,
    },
  });
  // Grandfather the pre-pivot "Standard" plan so anyone already subscribed
  // keeps the room capacity they paid for. We hide it from the pricing
  // surface (isActive=false) and mirror the Plus caps onto it, so a legacy
  // subscriber's effective plan is unchanged by the migration. Fresh signups
  // only ever see Free/Plus/Premium.
  await prisma.plan.updateMany({
    where: { id: 'plan-standard' },
    data: {
      isActive: false,
      tier: PlanTier.PLUS,
      maxRoomMembers: 10,
      maxVideoHeight: 1080,
      maxSessionMinutes: null,
      canHDScreenShare: false,
    },
  });

  // Canonical genres — same list the signup wizard chips and register
  // validation use, so GET /catalog/genres can never drift from them.
  for (const name of GENRES) {
    await prisma.genre.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }

  // Dev-only playable title so rooms can be exercised before real ingest.
  const drama = await prisma.genre.findUniqueOrThrow({
    where: { name: 'Drama' },
  });
  await prisma.title.upsert({
    where: { slug: 'demo-title' },
    create: {
      slug: 'demo-title',
      name: 'Demo Title',
      description:
        'Seed data for local development — replace with licensed content.',
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
    `Seed complete: 3 plans (Free/Plus/Premium), ${GENRES.length} genres, 1 demo title.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
