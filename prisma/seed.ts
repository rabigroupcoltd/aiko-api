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
      // Staff sign in with a password and never walk the onboarding stack.
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
  // await seedMinnaLandmarks();
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


// async function seedMinnaLandmarks() {
//   for (const landmark of MINNA_LANDMARKS) {
//     const fields = {
//       name: landmark.name,
//       address: landmarkAddress(landmark),
//       latitude: landmark.lat,
//       longitude: landmark.lng,
//       category: landmark.category,
//       searchText: landmarkSearchText(landmark),
//     };

//     await prisma.placeCache.upsert({
//       where: { placeId: seededPlaceId(landmark.id) },
//       create: { placeId: seededPlaceId(landmark.id), ...fields },
//       update: fields,
//     });
//   }

//   console.log(`Minna landmarks ready: ${MINNA_LANDMARKS.length} places cached`);
// }

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
