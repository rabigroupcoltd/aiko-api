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

/**
 * Idempotent: safe to re-run. Creates the first admin (the API refuses to make
 * one through public registration), the per-vehicle pricing rules, the global
 * pricing settings (fare rounding, the road-distance fallback factor), and the
 * Minna gazetteer that address search falls back on.
 */
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

  // Only the types Aiko actually dispatches — a pre-existing loop over the
  // full VehicleType enum would have upserted CAR/TRUCK/BICYCLE rows too,
  // defaulting to isActive: true and 0 for every fare column, since every
  // column on PricingRule has a Prisma default. PricingService.ensureDefaults
  // deactivates those on the app's first boot, but there's no reason to seed
  // a live $0 car fare even for the few seconds until that runs.
  for (const vehicleType of SUPPORTED_VEHICLE_TYPES) {
    await prisma.pricingRule.upsert({
      where: { vehicleType },
      create: { vehicleType, ...DEFAULT_PRICING[vehicleType] },
      update: {},
    });
  }
  console.log(`Pricing rules ready for: ${SUPPORTED_VEHICLE_TYPES.join(', ')}`);

  await seedPlatformSettings();
  await seedMinnaLandmarks();
}

/**
 * The global numeric knobs pricing reads through PlatformSettingsService —
 * FARE_ROUNDING_STEP, ROAD_DISTANCE_FACTOR. Each `default` already resolves
 * the matching env var if one is set, so this seeds whatever this deployment
 * would otherwise have gotten from the env, but as an editable row.
 *
 * `update: {}` — never overwrites a value an admin already changed through
 * `PATCH /api/settings`. Re-running this seed must not undo that.
 */
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

/**
 * Warms `place_cache` with the local gazetteer.
 *
 * This is what makes address search useful before GOOGLE_MAPS_API_KEY exists:
 * the search checks the cache first and only calls the Places API on a miss, so
 * with these rows present the common Minna destinations resolve locally and the
 * remote tier is never reached.
 *
 * Upserted on the namespaced placeId rather than created, so re-running after
 * an edit to the list updates the rows instead of failing on the unique
 * address. `searchCount` is deliberately left alone on update — it is real
 * usage data and re-seeding must not reset the ordering.
 */
async function seedMinnaLandmarks() {
  for (const landmark of MINNA_LANDMARKS) {
    const fields = {
      name: landmark.name,
      address: landmarkAddress(landmark),
      latitude: landmark.lat,
      longitude: landmark.lng,
      category: landmark.category,
      searchText: landmarkSearchText(landmark),
    };

    await prisma.placeCache.upsert({
      where: { placeId: seededPlaceId(landmark.id) },
      create: { placeId: seededPlaceId(landmark.id), ...fields },
      update: fields,
    });
  }

  console.log(`Minna landmarks ready: ${MINNA_LANDMARKS.length} places cached`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
