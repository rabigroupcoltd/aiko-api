import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { SUPPORTED_VEHICLE_TYPES } from '../src/common/vehicle-types';
import { DEFAULT_PRICING } from '../src/pricing/pricing.constants';
import { PLATFORM_SETTINGS } from '../src/settings/platform-settings.constants';
import {
  MINNA_LANDMARKS,
  landmarkAddress,
  landmarkSearchText,
  seededPlaceId,
} from './seeds/minna-landmarks';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@aiko.ng';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      password: await bcrypt.hash(password, 10),
      name: 'Platform Admin',
      phone: process.env.SEED_ADMIN_PHONE || '+2348000000000',
      roles: ['ADMIN', 'USER'],
      authProvider: 'PASSWORD',
      emailVerified: true,
      onboardingStep: 'DONE',
      onboardingCompletedAt: new Date(),
    },
    update: {
      roles: ['ADMIN', 'USER'],
      authProvider: 'PASSWORD',
      onboardingStep: 'DONE',
    },
  });
  console.log(`Admin ready: ${admin.email}`);

  for (const vehicleType of SUPPORTED_VEHICLE_TYPES) {
    await prisma.pricingRule.upsert({
      where: { vehicleType },
      create: { vehicleType, ...DEFAULT_PRICING[vehicleType] },
      update: {},
    });
  }
  console.log(`Pricing rules ready for: ${SUPPORTED_VEHICLE_TYPES.join(', ')}`);

  await seedPlatformSettings();
}

async function seedPlatformSettings() {
  for (const [key, definition] of Object.entries(PLATFORM_SETTINGS)) {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value: String(definition.default), description: definition.description },
      update: {},
    });
  }
  console.log(`Platform settings ready: ${Object.keys(PLATFORM_SETTINGS).join(', ')}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
