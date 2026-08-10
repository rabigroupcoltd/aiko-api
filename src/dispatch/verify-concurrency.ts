/**
 * Proves the two reservation invariants against a real Postgres.
 *
 *   ONE ORDER  -> ONE DRIVER      (the conditional UPDATE)
 *   ONE DRIVER -> AT MOST N ORDERS (the SELECT … FOR UPDATE on the driver row)
 *
 * Calls the actual `MarketplaceService.reserve()`, not a copy of its SQL, so the
 * transaction under test is the one that ships. Collaborators that would need
 * Redis or object storage are stubbed; nothing that touches the database is.
 *
 * DESTRUCTIVE — it truncates users, drivers and orders. Point it at a throwaway
 * database, never at a shared one:
 *
 *   docker run -d --name aiko-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=aiko_test -p 55432:5432 postgres:16-alpine
 *
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:55432/aiko_test?schema=public" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:55432/aiko_test?schema=public" \
 *     npm run verify:concurrency
 *
 * A plain script rather than a test because the project has no test runner —
 * the same choice `realtime/verify-catalogue.ts` makes.
 */
import { OrderStatus, PrismaClient, VehicleType } from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { RideEventsService } from '../events/ride-events.service';
import { MarketplaceService } from './marketplace.service';
import { OrderCompatibilityService } from './order-compatibility.service';

const prisma = new PrismaClient();

const MINNA = { lat: 9.6139, lng: 6.5569 };
const BOSSO = { lat: 9.6485, lng: 6.5311 };

/** Stands in for Redis-backed position lookup and pricing-derived speed. */
const routes = {
  driverPosition: async () => MINNA,
  activeOrders: (driverId: string) =>
    prisma.order.findMany({
      where: {
        driverId,
        status: {
          in: [
            OrderStatus.RESERVED,
            OrderStatus.DRIVER_ARRIVING_PICKUP,
            OrderStatus.PICKED_UP,
            OrderStatus.IN_TRANSIT,
          ],
        },
      },
    }),
  speedFor: async () => 25,
  planFor: async () => ({
    stops: [],
    totalKm: 0,
    totalMinutes: 0,
    deliveryEtaByOrder: {},
    pickupEtaByOrder: {},
  }),
  customerEta: async () => ({ pickupMinutes: 5, deliveryMinutes: 20 }),
} as any;

const drivers = {
  requireDriverForUser: async (userId: string) => {
    const driver = await prisma.driver.findUnique({ where: { userId } });
    return driver
      ? { error: 0, body: driver }
      : { error: 4, body: 'You do not have a driver profile' };
  },
} as any;

const service = new MarketplaceService(
  prisma as any,
  drivers,
  routes,
  new OrderCompatibilityService(routes),
  new RideEventsService(),
  new ResponsesService(),
);

async function seed() {
  await prisma.driverOrderAction.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.driver.deleteMany({});
  await prisma.user.deleteMany({});

  await prisma.pricingRule.upsert({
    where: { vehicleType: VehicleType.TRICYCLE },
    create: { vehicleType: VehicleType.TRICYCLE, baseFare: 200, perKm: 100, minimumFare: 500 },
    update: {},
  });

  const customer = await prisma.user.create({
    data: { name: 'Ada Obi', phone: '+2348010000000', roles: ['USER'] },
  });

  // A, B, C race for orders. D never takes anything and stays at 0 of 3, so
  // the skip check has a driver whose empty grid can only mean the skip worked.
  const allUsers = await Promise.all(
    ['A', 'B', 'C', 'D'].map((tag) =>
      prisma.user.create({
        data: { name: `Driver ${tag}`, phone: `+23480100000${tag.charCodeAt(0)}`, roles: ['RIDER'] },
      }),
    ),
  );

  await Promise.all(
    allUsers.map((user, index) =>
      prisma.driver.create({
        data: {
          userId: user.id,
          vehicleType: VehicleType.TRICYCLE,
          vehiclePlate: `TEST-${index}`,
          vehicleModel: 'Keke',
          kycStatus: 'APPROVED',
          isAvailable: true,
        },
      }),
    ),
  );

  return { customer, driverUsers: allUsers.slice(0, 3), idleDriver: allUsers[3] };
}

async function makeOrder(customerId: string, label: string) {
  return prisma.order.create({
    data: {
      userId: customerId,
      vehicleType: VehicleType.TRICYCLE,
      pickupLocation: `${label} pickup`,
      dropoffLocation: `${label} dropoff`,
      pickupLat: MINNA.lat,
      pickupLng: MINNA.lng,
      dropoffLat: BOSSO.lat,
      dropoffLng: BOSSO.lng,
      distanceKm: 6.2,
      fare: 2500,
      driverEarnings: 2250,
      platformFee: 250,
      paymentMethod: 'CASH',
      status: OrderStatus.SEARCHING_FOR_DRIVER,
    },
  });
}

/** `error: 0` is success; 1 is 400, 6 is 409. */
function describe(result: { error: number; body: any }): string {
  if (result.error === 0) return 'SUCCESS';
  return `${result.error === 6 ? '409' : '400'} ${typeof result.body === 'string' ? result.body : ''}`;
}

async function main() {
  const { customer, driverUsers, idleDriver } = await seed();
  let failures = 0;

  // -------------------------------------------------- one order, one driver
  console.log('\n=== §51a  three drivers race for order #100 ===');
  const contested = await makeOrder(customer.id, 'Order 100');

  const raced = await Promise.all(
    driverUsers.map((user) => service.reserve(contested.id, user.id)),
  );

  raced.forEach((result, index) =>
    console.log(`  Driver ${'ABC'[index]} -> ${describe(result)}`),
  );

  const winners = raced.filter((result) => result.error === 0).length;
  const conflicts = raced.filter(
    (result) => result.error === 6 && String(result.body).includes('ORDER_ALREADY_RESERVED'),
  ).length;

  console.log(`  winners: ${winners}  conflicts: ${conflicts}`);
  if (winners !== 1 || conflicts !== 2) {
    console.error('  FAIL: expected exactly 1 winner and 2 ORDER_ALREADY_RESERVED');
    failures += 1;
  } else {
    console.log('  PASS');
  }

  // The database must agree, not just the return values.
  const settled = await prisma.order.findUnique({ where: { id: contested.id } });
  const singleOwner = settled?.status === OrderStatus.RESERVED && Boolean(settled.driverId);
  console.log(`  db: status=${settled?.status} driverId=${settled?.driverId ? 'set' : 'null'}`);
  if (!singleOwner) {
    console.error('  FAIL: order row does not show exactly one owner');
    failures += 1;
  }

  // ---------------------------------------------- one driver, many orders
  console.log('\n=== §51b  Driver A takes 101, 102, 103 then 104 (capacity 3) ===');
  const winnerIndex = raced.findIndex((result) => result.error === 0);
  const winner = driverUsers[winnerIndex];

  // The winner already holds #100, so one more fills them to 3 of 3.
  const second = await makeOrder(customer.id, 'Order 101');
  const third = await makeOrder(customer.id, 'Order 102');
  const fourth = await makeOrder(customer.id, 'Order 103');

  for (const [label, order] of [
    ['101', second],
    ['102', third],
    ['103', fourth],
  ] as const) {
    const result = await service.reserve(order.id, winner.id);
    console.log(`  Order ${label} -> ${describe(result)}`);

    // 101 and 102 fill the driver to 3; 103 must be refused.
    const shouldSucceed = label !== '103';
    if (shouldSucceed !== (result.error === 0)) {
      console.error(`  FAIL: order ${label} expected ${shouldSucceed ? 'success' : 'refusal'}`);
      failures += 1;
    }
    if (!shouldSucceed && !String(result.body).includes('MAX_ORDER_CAPACITY_REACHED')) {
      console.error(`  FAIL: order ${label} refused with the wrong reason`);
      failures += 1;
    }
  }

  const held = await prisma.order.count({
    where: {
      driverId: settled?.driverId ?? undefined,
      status: { in: [OrderStatus.RESERVED] },
    },
  });
  console.log(`  db: driver holds ${held} order(s)`);
  if (held !== 3) {
    console.error('  FAIL: expected the driver to hold exactly 3');
    failures += 1;
  } else {
    console.log('  PASS');
  }

  // ------------------------------- capacity holds under a simultaneous burst
  console.log('\n=== §51c  a fresh driver fires 5 accepts at once (capacity 3) ===');
  const eager = driverUsers[(winnerIndex + 1) % driverUsers.length];
  const burst = await Promise.all(
    ['200', '201', '202', '203', '204'].map((label) => makeOrder(customer.id, `Order ${label}`)),
  );

  const burstResults = await Promise.all(
    burst.map((order) => service.reserve(order.id, eager.id)),
  );
  burstResults.forEach((result, index) => console.log(`  #${200 + index} -> ${describe(result)}`));

  const took = burstResults.filter((result) => result.error === 0).length;
  console.log(`  reserved: ${took}`);
  if (took !== 3) {
    console.error('  FAIL: capacity was not enforced under concurrent accepts');
    failures += 1;
  } else {
    console.log('  PASS');
  }

  // --------------------------------------------------------- skip is private
  console.log('\n=== §10  a skip hides the order from one driver only ===');
  const shared = await makeOrder(customer.id, 'Order 300');

  // Both are at 0 of 3, so an empty grid can only mean the skip — not capacity.
  const skipper = idleDriver;
  const otherFree = driverUsers.find(
    (user, index) => index !== winnerIndex && user.id !== eager.id,
  )!;

  await service.skip(shared.id, skipper.id);

  const skipperGrid = await service.available(skipper.id, {});
  const otherGrid = await service.available(otherFree.id, {});

  const skipperSees = skipperGrid.body?.orders?.some((o: any) => o.id === shared.id) ?? false;
  const otherSees = otherGrid.body?.orders?.some((o: any) => o.id === shared.id) ?? false;
  const stillOpen = (await prisma.order.findUnique({ where: { id: shared.id } }))?.status;

  console.log(`  skipper sees it: ${skipperSees}   other free driver sees it: ${otherSees}`);
  console.log(`  order status unchanged: ${stillOpen}`);

  if (skipperSees || !otherSees || stillOpen !== OrderStatus.SEARCHING_FOR_DRIVER) {
    console.error('  FAIL: a skip must hide the order locally and change nothing globally');
    failures += 1;
  } else {
    console.log('  PASS');
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
