import { PrismaPg } from '@prisma/adapter-pg';

type PrismaPgConfig = {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
};

export function createPrismaPgAdapter(connectionString: string): PrismaPg {
  return new PrismaPg(buildPrismaPgConfig(connectionString));
}

function buildPrismaPgConfig(connectionString: string): PrismaPgConfig {
  const config: PrismaPgConfig = { connectionString };
  if (shouldUseSsl(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

function shouldUseSsl(connectionString: string): boolean {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
  if (sslMode === 'disable') return false;
  if (sslMode === 'require') return true;

  return (
    url.hostname.endsWith('.render.com') ||
    url.hostname.includes('.oregon-postgres.render.com') ||
    url.hostname.includes('.frankfurt-postgres.render.com')
  );
}
