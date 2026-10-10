import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BidStatus,
  Driver,
  KycStatus,
  PricingRule,
  RideRequest,
  RideRequestStatus,
  VehicleType,
} from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
import { boundingBox, haversineKm, round2 } from '../common/geo.util';
import { CONTACT_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ServiceResult,
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
} from '../common/responses/response.types';
import { DriversService } from '../drivers/drivers.service';
import { RideEventsService } from '../events/ride-events.service';
import { OrdersService } from '../orders/orders.service';
import { FareQuote, PricingService } from '../pricing/pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { RedisService } from '../redis/redis.service';
import {
  AcceptDriverDto,
  CancelRideRequestDto,
  CreateRideRequestDto,
  NearbyRequestsQueryDto,
  PlaceBidDto,
} from './dto/ride.dto';

export const REQUEST_TTL_SECONDS = Number(process.env.RIDE_REQUEST_TTL || 120);
const SEARCH_RADIUS_KM = Number(process.env.SEARCH_RADIUS_KM || 5);
const MAX_MATCHES = Number(process.env.MAX_MATCHED_DRIVERS || 15);

/**
 * Shortest gap between two backfill sweeps for the same driver.
 *
 * A driver publishes a position every ~10s, and each one announces them as
 * available. Without this the sweep would run six times a minute per online
 * driver for no benefit — nothing new can appear that fast that the ordinary
 * fan-out would not already have caught.
 */
const SWEEP_THROTTLE_SECONDS = Number(process.env.DRIVER_SWEEP_THROTTLE || 30);
const sweepKey = (driverId: string) => `driver:sweep:${driverId}`;

/** Off by default: the accepted bid is informational and the server quote stands. */
const ALLOW_BID_FARE_OVERRIDE = process.env.ALLOW_BID_FARE_OVERRIDE === 'true';
/** How far a bid may stray from the quote when overrides are enabled. */
const BID_TOLERANCE = 0.5;

const REQUEST_INCLUDE = {
  user: { select: CONTACT_USER_SELECT },
  bids: {
    include: {
      driver: { include: { user: { select: CONTACT_USER_SELECT } } },
    },
  },
};

/**
 * Broadcast-and-bid matching: a passenger's request fans out to nearby drivers
 * of the right vehicle type, drivers respond, the passenger picks one.
 */
@Injectable()
export class RideService implements OnModuleInit {
  private readonly logger = new Logger(RideService.name);

  constructor(
    private prisma: PrismaService,
    private pricing: PricingService,
    private drivers: DriversService,
    private orders: OrdersService,
    private redis: RedisService,
    private events: RideEventsService,
    private queues: QueuesService,
    private response: ResponsesService,
  ) {}

  onModuleInit() {
    // Matching only ever pushes: a request fans out to whoever was online at
    // the moment it was raised. A driver who comes online a few seconds later
    // is invisible to it until the rematch worker happens to widen the search,
    // and completely invisible once those attempts are spent. This closes that
    // window from the other side — the driver's own arrival pulls open work
    // towards them.
    this.events.on<any>('driver.available').subscribe(({ payload }) => {
      this.sweepForDriver(payload).catch((e) =>
        this.logger.warn(`Backfill sweep for driver ${payload?.driverId} failed: ${e?.message}`),
      );
    });
  }

  async createRequest(userId: string, dto: CreateRideRequestDto): Promise<ServiceResult> {
    try {
      const quoted = await this.pricing.estimate({
        vehicleType: dto.vehicleType,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
      });
      if (quoted.error) return quoted as ServiceResult<string>;

      const quote = quoted.body as FareQuote;

      const active = await this.prisma.rideRequest.findFirst({
        where: { userId, status: { in: [RideRequestStatus.PENDING, RideRequestStatus.MATCHED] } },
      });
      if (active) return conflict('You already have an open ride request');

      // Only drivers of the requested vehicle type are considered.
      const nearby = await this.drivers.nearbyDrivers({
        lat: dto.pickupLat,
        lng: dto.pickupLng,
        radiusKm: dto.radiusKm ?? SEARCH_RADIUS_KM,
        limit: MAX_MATCHES,
        vehicleType: dto.vehicleType,
      });

      const request = await this.prisma.rideRequest.create({
        data: {
          userId,
          vehicleType: dto.vehicleType as VehicleType,
          pickupLocation: dto.pickupLocation,
          dropoffLocation: dto.dropoffLocation,
          pickupLat: dto.pickupLat,
          pickupLng: dto.pickupLng,
          dropoffLat: dto.dropoffLat,
          dropoffLng: dto.dropoffLng,
          distanceKm: quote.distanceKm,
          durationMins: quote.durationMins,
          estimatedFare: quote.fare,
          paymentMethod: (dto.paymentMethod ?? 'CASH') as any,
          expiresAt: new Date(Date.now() + REQUEST_TTL_SECONDS * 1000),
          matchedDriverIds: nearby.map((driver) => driver.driverId),
          status: nearby.length > 0 ? RideRequestStatus.MATCHED : RideRequestStatus.PENDING,
        },
        include: REQUEST_INCLUDE,
      });

      await this.queues.scheduleRequestTimeout(request.id, REQUEST_TTL_SECONDS * 1000);
      if (nearby.length === 0) await this.queues.scheduleRematch(request.id, 1);

      this.events.emit('ride-request.created', { request, quote, matched: nearby });

      return ok({ request, quote, matchedDrivers: nearby });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Widens the search for a request that found nobody. Returns null when the
   * request is no longer open so the worker can stop retrying.
   */
  async rematch(requestId: string, attempt: number): Promise<{ driverId: string }[] | null> {
    const request = await this.prisma.rideRequest.findUnique({ where: { id: requestId } });

    if (!request) return null;
    if (![RideRequestStatus.PENDING, RideRequestStatus.MATCHED].includes(request.status as any)) {
      return null;
    }
    if (request.expiresAt.getTime() < Date.now()) {
      await this.expireRequest(requestId);
      return null;
    }

    const nearby = await this.drivers.nearbyDrivers({
      lat: request.pickupLat,
      lng: request.pickupLng,
      radiusKm: SEARCH_RADIUS_KM * (attempt + 1),
      limit: MAX_MATCHES,
      vehicleType: request.vehicleType,
    });

    const fresh = nearby.filter((driver) => !request.matchedDriverIds.includes(driver.driverId));
    if (fresh.length === 0) return [];

    const updated = await this.prisma.rideRequest.update({
      where: { id: requestId },
      data: {
        status: RideRequestStatus.MATCHED,
        matchedDriverIds: { push: fresh.map((driver) => driver.driverId) },
      },
      include: REQUEST_INCLUDE,
    });

    const ruleResult = await this.pricing.getActiveRule(request.vehicleType);
    if (ruleResult.error) return fresh;

    const quote = this.pricing.quoteFromRule(ruleResult.body as PricingRule, request.distanceKm);

    // Only the newly found drivers are notified — the earlier batch already has it.
    this.events.emit('ride-request.created', { request: updated, quote, matched: fresh });

    return fresh;
  }

  async placeBid(userId: string, dto: PlaceBidDto): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;
      const blocked = this.drivers.workBlockReason(driver);
      if (blocked) return forbidden(blocked);

      const open = await this.requireOpenRequest(dto.requestId);
      if (open.error) return open;

      const request = open.body as RideRequest;

      if (request.vehicleType !== driver.vehicleType) {
        return badRequest(`This request is for a ${request.vehicleType}`);
      }

      const amount = this.resolveBidAmount(request.estimatedFare, dto.amount);
      if (typeof amount !== 'number') return amount;

      const bid = await this.prisma.rideBid.upsert({
        where: { requestId_driverId: { requestId: request.id, driverId: driver.id } },
        create: { requestId: request.id, driverId: driver.id, amount, note: dto.note },
        update: { amount, note: dto.note, status: BidStatus.PENDING },
        include: { driver: { include: { user: { select: CONTACT_USER_SELECT } } } },
      });

      this.events.emit('ride-request.bid', { request, bid });
      return ok(bid);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Returns the resolved amount, or a failed ServiceResult when out of range. */
  private resolveBidAmount(quotedFare: number, requested?: number): number | ServiceResult {
    if (!ALLOW_BID_FARE_OVERRIDE || requested == null) return quotedFare;

    const min = quotedFare * (1 - BID_TOLERANCE);
    const max = quotedFare * (1 + BID_TOLERANCE);

    if (requested < min || requested > max) {
      return badRequest(`Bid must be between ${Math.round(min)} and ${Math.round(max)}`);
    }
    return requested;
  }

  /** Passenger picks a driver; this is the point an Order comes into existence. */
  async acceptDriver(userId: string, dto: AcceptDriverDto): Promise<ServiceResult> {
    try {
      const open = await this.requireOpenRequest(dto.requestId);
      if (open.error) return open;

      const request = open.body as RideRequest;
      if (request.userId !== userId) return forbidden('Not your ride request');

      const bid = await this.prisma.rideBid.findUnique({
        where: { requestId_driverId: { requestId: request.id, driverId: dto.driverId } },
      });
      if (!bid) return notFound('That driver has not bid on this request');
      if (bid.status !== BidStatus.PENDING) return badRequest('Bid is no longer open');

      // Guarded update — a second accept on the same request finds nothing to claim.
      const claim = await this.prisma.rideRequest.updateMany({
        where: {
          id: request.id,
          status: { in: [RideRequestStatus.PENDING, RideRequestStatus.MATCHED] },
        },
        data: { status: RideRequestStatus.ACCEPTED },
      });
      if (claim.count === 0) return conflict('Request is no longer open');

      const created = await this.orders.createFromRideRequest(
        request.id,
        dto.driverId,
        ALLOW_BID_FARE_OVERRIDE ? bid.amount : undefined,
      );

      if (created.error) {
        // Put the request back so the passenger can pick someone else.
        await this.prisma.rideRequest.update({
          where: { id: request.id },
          data: { status: RideRequestStatus.MATCHED },
        });
        return created;
      }

      const order = created.body;

      await this.prisma.$transaction([
        this.prisma.rideRequest.update({
          where: { id: request.id },
          data: { orderId: order.id },
        }),
        this.prisma.rideBid.update({
          where: { id: bid.id },
          data: { status: BidStatus.ACCEPTED },
        }),
        this.prisma.rideBid.updateMany({
          where: { requestId: request.id, id: { not: bid.id }, status: BidStatus.PENDING },
          data: { status: BidStatus.REJECTED },
        }),
      ]);

      this.events.emit('ride-request.bid-accepted', { requestId: request.id, order });
      return ok(order);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async cancelRequest(userId: string, dto: CancelRideRequestDto): Promise<ServiceResult> {
    try {
      const request = await this.prisma.rideRequest.findUnique({ where: { id: dto.requestId } });
      if (!request) return notFound('Ride request not found');
      if (request.userId !== userId) return forbidden('Not your ride request');

      if (request.status === RideRequestStatus.ACCEPTED) {
        return badRequest('Request already turned into a trip — cancel the trip instead');
      }

      const cancelled = await this.prisma.rideRequest.update({
        where: { id: request.id },
        data: { status: RideRequestStatus.CANCELLED },
        include: REQUEST_INCLUDE,
      });

      this.events.emit('ride-request.cancelled', cancelled);
      return ok(cancelled);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Called by the timeout worker; safe to run against an already-closed request. */
  async expireRequest(requestId: string) {
    const expired = await this.prisma.rideRequest.updateMany({
      where: {
        id: requestId,
        status: { in: [RideRequestStatus.PENDING, RideRequestStatus.MATCHED] },
      },
      data: { status: RideRequestStatus.EXPIRED },
    });

    if (expired.count === 0) return null;

    const request = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });

    this.events.emit('ride-request.expired', request);
    return request;
  }

  async findOne(id: string): Promise<ServiceResult> {
    try {
      const request = await this.prisma.rideRequest.findUnique({
        where: { id },
        include: REQUEST_INCLUDE,
      });

      if (!request) return notFound('Ride request not found');
      return ok(request);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findMine(user: JwtUser): Promise<ServiceResult> {
    try {
      const driver = await this.prisma.driver.findUnique({ where: { userId: user.sub } });

      const requests = await this.prisma.rideRequest.findMany({
        where: driver
          ? { OR: [{ userId: user.sub }, { matchedDriverIds: { has: driver.id } }] }
          : { userId: user.sub },
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      return ok(requests);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  // ------------------------------------------------------------- discovery

  /**
   * Open requests around a driver, whether or not they were matched into them.
   *
   * The counterpart to the inbox: that answers "what was I offered", this
   * answers "what is going on near me". A driver who came online mid-search
   * only ever appears in the second.
   *
   * Requests found this way are backfilled into `matchedDriverIds`, which is
   * what subscribes the driver to the request's later broadcasts — without it
   * they would keep showing a job that was cancelled or taken minutes ago.
   */
  async findNearbyOpen(userId: string, query: NearbyRequestsQueryDto): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;
      const blocked = this.drivers.workBlockReason(driver);
      if (blocked) return forbidden(blocked);

      const radiusKm = query.radiusKm ?? SEARCH_RADIUS_KM;
      const limit = query.limit ?? 20;

      const nearby = await this.openRequestsNear(driver, query.lat, query.lng, radiusKm, limit);
      await this.backfillMatches(nearby, driver.id);

      return ok(
        nearby.map((request) => ({
          ...request,
          // Browsing is open to every approved driver in the radius, which is a
          // wider audience than the matcher's own shortlist. A phone number is
          // not needed to decide whether to bid — it arrives with the order,
          // once this driver has actually won the trip.
          user: { ...request.user, phone: null },
          hasBid: request.bids.some((bid) => bid.driverId === driver.id),
        })),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Offers a newly-online driver whatever is already open around them.
   *
   * Emits the same `ride-request.created` event the ordinary fan-out uses, so
   * the offer reaches the socket and the push notification through exactly one
   * code path — there is no second notion of what a ride offer looks like.
   */
  private async sweepForDriver(payload: {
    driverId: string;
    lat: number;
    lng: number;
  }): Promise<void> {
    const { driverId, lat, lng } = payload ?? ({} as any);
    if (!driverId || lat == null || lng == null) return;

    // SET NX is the throttle: whichever announcement wins the key does the
    // sweep, the rest are no-ops until it expires. Cross-instance by virtue of
    // living in Redis, so two API nodes cannot both sweep the same driver.
    const claimed = await this.redis.client.set(
      sweepKey(driverId),
      '1',
      'EX',
      SWEEP_THROTTLE_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') return;

    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || this.drivers.workBlockReason(driver)) return;

    const nearby = await this.openRequestsNear(driver, lat, lng, SEARCH_RADIUS_KM, MAX_MATCHES);

    // Anything they are already matched into has been offered once already —
    // re-emitting would buzz the phone a second time for the same job.
    const fresh = nearby.filter((request) => !request.matchedDriverIds.includes(driverId));
    if (fresh.length === 0) return;

    await this.backfillMatches(fresh, driverId);

    for (const request of fresh) {
      this.events.emit('ride-request.created', {
        request,
        // The stored estimate, not a fresh quote: re-pricing here could show
        // this driver a different fare from the one every other matched driver
        // was offered for the same job.
        quote: { fare: request.estimatedFare, currency: 'NGN' },
        matched: [{ driverId }],
      });
    }

    this.logger.log(`Backfilled ${fresh.length} open request(s) to driver ${driverId}`);
  }

  /**
   * Open requests whose pickup is within `radiusKm`, nearest first.
   *
   * The bounding box narrows the read to a box around the driver; haversine
   * then trims the corners the box adds. Requests already turned into a trip,
   * expired, or for another vehicle type never enter the set.
   */
  private async openRequestsNear(
    driver: Driver,
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
  ) {
    const box = boundingBox(lat, lng, radiusKm);

    const candidates = await this.prisma.rideRequest.findMany({
      where: {
        status: { in: [RideRequestStatus.PENDING, RideRequestStatus.MATCHED] },
        expiresAt: { gt: new Date() },
        vehicleType: driver.vehicleType,
        orderId: null,
        pickupLat: { gte: box.minLat, lte: box.maxLat },
        pickupLng: { gte: box.minLng, lte: box.maxLng },
        // A driver must never be offered their own booking.
        userId: { not: driver.userId },
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      // Bounded independently of `limit`: the box over-selects, and the
      // haversine pass below can only ever shrink the list.
      take: Math.max(limit * 4, 40),
    });

    const now = Date.now();

    return candidates
      .map((request) => ({
        ...request,
        pickupDistanceKm: round2(haversineKm(lat, lng, request.pickupLat, request.pickupLng)),
        secondsRemaining: Math.max(0, Math.round((request.expiresAt.getTime() - now) / 1000)),
      }))
      .filter((request) => request.pickupDistanceKm <= radiusKm)
      .sort((a, b) => a.pickupDistanceKm - b.pickupDistanceKm)
      .slice(0, limit);
  }

  /**
   * Adds the driver to each request's matched list.
   *
   * Only writes for requests that do not already name them, so a client polling
   * this every few seconds settles into doing no writes at all.
   */
  private async backfillMatches(requests: { id: string; matchedDriverIds: string[] }[], driverId: string) {
    const missing = requests.filter((request) => !request.matchedDriverIds.includes(driverId));
    if (missing.length === 0) return;

    await this.prisma.rideRequest.updateMany({
      where: { id: { in: missing.map((request) => request.id) } },
      data: { matchedDriverIds: { push: driverId } },
    });

    // Keep the in-memory copies honest for whatever the caller does next.
    missing.forEach((request) => request.matchedDriverIds.push(driverId));
  }

  /** Open requests a given driver was matched into — the driver's inbox. */
  async findForDriver(userId: string): Promise<ServiceResult> {
    try {
      const found = await this.drivers.requireDriverForUser(userId);
      if (found.error) return found;

      const driver = found.body as Driver;

      const requests = await this.prisma.rideRequest.findMany({
        where: {
          matchedDriverIds: { has: driver.id },
          status: { in: [RideRequestStatus.PENDING, RideRequestStatus.MATCHED] },
          expiresAt: { gt: new Date() },
        },
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });

      return ok(requests);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async requireOpenRequest(id: string): Promise<ServiceResult> {
    const request = await this.prisma.rideRequest.findUnique({ where: { id } });
    if (!request) return notFound('Ride request not found');

    if (![RideRequestStatus.PENDING, RideRequestStatus.MATCHED].includes(request.status as any)) {
      return badRequest(`Ride request is ${request.status.toLowerCase()}`);
    }
    if (request.expiresAt.getTime() < Date.now()) {
      await this.expireRequest(id);
      return badRequest('Ride request has expired');
    }

    return ok(request);
  }
}
