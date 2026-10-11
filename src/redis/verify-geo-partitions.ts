import { VehicleType } from '@prisma/client';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { ALL_GEO_KEYS, geoKey } from './redis.keys';

const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const redis = new RedisService(client);

const MINNA = { lat: 9.6139, lng: 6.5569 };

const near = (km: number) => ({ lat: MINNA.lat + km * 0.009, lng: MINNA.lng });

const IDS = {
  okadaNear: 'test-okada-near',
  okadaFar: 'test-okada-far',
  kekeNear: 'test-keke-near',
};

async function cleanup() {
  const pipeline = client.pipeline();
  Object.values(IDS).forEach((id) => {
    ALL_GEO_KEYS.forEach((key) => pipeline.zrem(key, id));
    pipeline.del(`driver:${id}:meta`);
    pipeline.del(`driver:heartbeat:${id}`);
    Object.values(VehicleType).forEach((type) => pipeline.srem(`drivers:available:${type}`, id));
  });
  await pipeline.exec();
}

async function main() {
  let failures = 0;
  const fail = (message: string) => {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  };

  await cleanup();

  console.log('\n=== a position is written to its own vehicle partition ===');

  await redis.saveDriverLocation(IDS.okadaNear, VehicleType.BIKE, near(1));
  await redis.saveDriverLocation(IDS.okadaFar, VehicleType.BIKE, near(20));
  await redis.saveDriverLocation(IDS.kekeNear, VehicleType.TRICYCLE, near(1));

  const bikeMembers = await client.zrange(geoKey(VehicleType.BIKE), 0, -1);
  const kekeMembers = await client.zrange(geoKey(VehicleType.TRICYCLE), 0, -1);

  console.log(`  ${geoKey(VehicleType.BIKE)}     -> ${bikeMembers.join(', ')}`);
  console.log(`  ${geoKey(VehicleType.TRICYCLE)} -> ${kekeMembers.join(', ')}`);

  if (!bikeMembers.includes(IDS.okadaNear) || bikeMembers.includes(IDS.kekeNear)) {
    fail('the bike partition does not hold exactly the bikes');
  }
  if (!kekeMembers.includes(IDS.kekeNear) || kekeMembers.includes(IDS.okadaNear)) {
    fail('the tricycle partition does not hold exactly the tricycles');
  }
  if (failures === 0) console.log('  PASS');

  console.log('\n=== a typed search reads only its own partition ===');

  Object.values(IDS).forEach(() => undefined);
  await client.sadd(`drivers:available:${VehicleType.BIKE}`, IDS.okadaNear, IDS.okadaFar);
  await client.sadd(`drivers:available:${VehicleType.TRICYCLE}`, IDS.kekeNear);

  const bikes = await redis.getDriversNearby({
    ...MINNA,
    radiusKm: 5,
    vehicleType: VehicleType.BIKE,
  } as any);
  const kekes = await redis.getDriversNearby({
    ...MINNA,
    radiusKm: 5,
    vehicleType: VehicleType.TRICYCLE,
  } as any);

  console.log(`  BIKE within 5 km     -> ${bikes.map((d) => d.driverId).join(', ') || 'none'}`);
  console.log(`  TRICYCLE within 5 km -> ${kekes.map((d) => d.driverId).join(', ') || 'none'}`);

  const before = failures;
  if (bikes.length !== 1 || bikes[0].driverId !== IDS.okadaNear) {
    fail('the bike search did not return exactly the near bike');
  }
  if (kekes.length !== 1 || kekes[0].driverId !== IDS.kekeNear) {
    fail('the tricycle search did not return exactly the near tricycle');
  }
  if (failures === before) console.log('  PASS');

  console.log('\n=== re-registering under another vehicle leaves no ghost ===');

  await redis.saveDriverLocation(IDS.okadaNear, VehicleType.TRICYCLE, near(1));

  const bikeAfter = await client.zrange(geoKey(VehicleType.BIKE), 0, -1);
  const kekeAfter = await client.zrange(geoKey(VehicleType.TRICYCLE), 0, -1);

  console.log(`  bike partition now     -> ${bikeAfter.join(', ') || 'empty'}`);
  console.log(`  tricycle partition now -> ${kekeAfter.join(', ')}`);

  if (bikeAfter.includes(IDS.okadaNear)) {
    fail('the driver is still in their old partition — a sorted set member has no TTL');
  } else if (!kekeAfter.includes(IDS.okadaNear)) {
    fail('the driver did not arrive in the new partition');
  } else {
    console.log('  PASS');
  }

  console.log('\n=== removeDriver clears every partition ===');

  await redis.removeDriver(IDS.okadaNear);

  const stillSomewhere: string[] = [];
  for (const key of ALL_GEO_KEYS) {
    const score = await client.zscore(key, IDS.okadaNear);
    if (score != null) stillSomewhere.push(key);
  }

  console.log(`  remaining in: ${stillSomewhere.join(', ') || 'nothing'}`);
  if (stillSomewhere.length > 0) fail('teardown left the driver in an index');
  else console.log('  PASS');

  console.log('\n=== the flush job enumerates every partition ===');

  const tracked = await redis.getAllTrackedDrivers();
  const mine = tracked.filter((entry) => entry.driverId.startsWith('test-'));
  console.log(`  tracked: ${mine.map((e) => `${e.driverId}(${e.vehicleType})`).join(', ')}`);

  if (!mine.some((e) => e.driverId === IDS.kekeNear && e.vehicleType === VehicleType.TRICYCLE)) {
    fail('a tracked driver was not reported with their partition');
  } else {
    console.log('  PASS');
  }

  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);

  client.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  client.disconnect();
  process.exit(1);
});
