import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedPlatform, type PlatformSeedInput, type SeedNamedEntry } from '@marinoscar/platform-db/seed';

// =============================================================================
// Seed (RETRO-B2, issue #611)
// =============================================================================
//
// The roles, permissions and their default grants are no longer written here.
// Each is declared once (`src/app-registrations/`, the identity and settings
// slices of @marinoscar/platform-api), registered, and rendered into the
// committed catalog `prisma/catalog/permissions.json`
// (`npm run catalog:permissions --workspace=api`); `seedPlatform` of
// `@marinoscar/platform-db/seed` writes it. UPSERTS ONLY: it never deletes a
// grant and never overwrites an administrator's edit, so this script runs on
// every install AND every update (`infra/deploy/update.sh`), which is how a new
// permission reaches an existing database now that the boot-time RBAC reconcile
// is gone.
//
// This file stays standalone: it runs under `ts-node --transpile-only` in an
// image that carries `prisma/` but not `src/`. Import nothing from `src/`.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run this script via `npm run prisma:seed` ' +
      '(or export DATABASE_URL) so Prisma can connect to the database.',
  );
}

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

interface PermissionCatalogFile {
  roles: SeedNamedEntry[];
  permissions: SeedNamedEntry[];
  rolePermissions: Record<string, string[]>;
}

// Default system settings
const DEFAULT_SYSTEM_SETTINGS = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
  ai: {
    features: {
      search: { provider: null, model: null },
    },
    conversations: {
      archiveAfterDays: 30,
      deleteAfterArchiveDays: 30,
    },
  },
  storage: {
    activeProvider: process.env.STORAGE_PROVIDER || 's3',
    insights: {
      refreshIntervalHours: 4,
    },
  },
};


function seedInput(): PlatformSeedInput {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, 'catalog', 'permissions.json'), 'utf8'),
  ) as PermissionCatalogFile;
  return {
    roles: catalog.roles,
    permissions: catalog.permissions,
    roleGrants: catalog.rolePermissions,
    systemSettingsDefaults: DEFAULT_SYSTEM_SETTINGS,
    // The initial administrator is allowlisted so the first sign-in is admitted;
    // INITIAL_ADMIN_EMAIL also bypasses the allowlist at sign-in.
    ...(process.env.INITIAL_ADMIN_EMAIL ? { initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL } : {}),
  };
}

// Starter vocabulary for AI auto-tagging (global, no circleId)
const TAG_LABELS = [
  'Beach',
  'Pool',
  'Playground',
  'Backyard',
  'Restaurant',
  'Airport',
  'Road Trip',
  'Mountains',
  'Sports Field',
  'Swimming',
  'Eating Together',
  'Cooking',
  'Playing Sports',
  'Opening Gifts',
  'Playing Games',
  'Dancing',
  'Reading',
  'Group Photo',
  'Hugging',
  'Laughing',
  'Celebration',
  'Sunset',
  'Screenshot',
  'Document',
  'Receipt',
  'Meme',
  'Food Photo',
  'Product Photo',
  'Work Image',
  'Blurry',
  'No People',
] as const;

async function seedTagLabels() {
  console.log('Seeding tag labels...');

  for (const name of TAG_LABELS) {
    await prisma.tagLabel.upsert({
      where: { name },
      create: { name, enabled: true },
      update: {},
    });
  }

  console.log(`✓ Seeded ${TAG_LABELS.length} tag labels`);
}

// =============================================================================
// Main Seed Function
// =============================================================================

async function main() {
  console.log('Starting database seed...\n');

  await seedPlatform(prisma, seedInput(), { info: (msg: string) => console.log(msg) });
  await seedTagLabels();

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
