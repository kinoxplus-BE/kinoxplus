import 'dotenv/config';
import { unsafeContentReason } from '../common/content/content-safety';
import { PrismaClient, TitleStatus } from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma/prisma-pg-adapter';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to clean up unsafe POC titles.');
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

async function main(): Promise<void> {
  const titles = await prisma.title.findMany({
    where: {
      status: TitleStatus.READY,
      OR: [{ tmdbId: { not: null } }, { pocPlaybackUrl: { not: null } }],
    },
    select: {
      id: true,
      name: true,
      description: true,
      tmdbId: true,
    },
  });

  const archived: Array<{ name: string; reason: string }> = [];
  for (const title of titles) {
    const reason = unsafeContentReason({
      title: title.name,
      description: title.description,
    });
    if (!reason) continue;

    await prisma.title.update({
      where: { id: title.id },
      data: {
        status: TitleStatus.ARCHIVED,
        licenseSource: `Archived by POC content filter: ${reason}.`,
      },
    });
    archived.push({ name: title.name, reason });
  }

  if (archived.length === 0) {
    console.log('No unsafe READY POC titles found.');
    return;
  }

  console.log(`Archived ${archived.length} unsafe READY POC title(s):`);
  for (const title of archived) {
    console.log(`- ${title.name} (${title.reason})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
