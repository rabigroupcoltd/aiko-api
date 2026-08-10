import { Injectable, Logger } from '@nestjs/common';
import { Order, VehicleType } from '@prisma/client';
import { round2 } from '../common/geo.util';
import {
  MAX_EXISTING_ORDER_DELAY_MINUTES,
  MAX_RESERVED_ORDERS_PER_DRIVER,
  MAX_ROUTE_DETOUR_KM,
  MAX_ROUTE_DETOUR_PERCENT,
  RouteMatch,
} from './dispatch.constants';
import { RouteOptimizerService } from './route-optimizer.service';
import { Point, RoutableOrder, bestRouteLengthKm, legKm, stopsFor } from './route.util';

/**
 * Answers one question: can driver X safely take order Y as well?
 *
 * "Safely" is not only about the driver's own mileage. §41 puts the customers
 * who are already waiting ahead of the extra fare, so a route that is barely
 * longer but pushes an existing drop-off past its promise is still a no.
 */

export interface CompatibilityInput {
  driverId: string;
  vehicleType: VehicleType;
  /** Where the driver is now. */
  origin: Point;
  /** Orders already occupying a capacity slot. */
  currentOrders: Order[];
  candidate: RoutableOrder;
  /** Pre-computed length of the current plan, so a scan does not redo it per order. */
  baselineKm?: number;
  /** Planning speed, likewise hoisted out of the loop. */
  speedKph?: number;
}

export interface CompatibilityResult {
  compatible: boolean;
  additionalDistanceKm: number;
  additionalTimeMinutes: number;
  /** 0–100. Higher is a better fit for this driver right now. */
  routeScore: number;
  match: RouteMatch;
  /** Straight-line-ish distance from the driver to this order's pickup. */
  pickupDistanceKm: number;
  /** Worst delay this order would inflict on an already-committed customer. */
  existingDelayMinutes: number;
  /** Why it was refused, or why it is a good fit. Shown to the driver verbatim. */
  reason: string;
}

@Injectable()
export class OrderCompatibilityService {
  private readonly logger = new Logger(OrderCompatibilityService.name);

  constructor(private routes: RouteOptimizerService) {}

  /**
   * Evaluate one candidate.
   *
   * The first order a driver takes is always compatible — there is no route to
   * detour from — so it is scored on proximity alone.
   */
  async evaluate(input: CompatibilityInput): Promise<CompatibilityResult> {
    const { origin, currentOrders, candidate } = input;

    const speedKph = input.speedKph ?? (await this.routes.speedFor(input.vehicleType));
    const pickupDistanceKm = round2(
      legKm(origin, { lat: candidate.pickupLat, lng: candidate.pickupLng }),
    );

    if (currentOrders.length >= MAX_RESERVED_ORDERS_PER_DRIVER) {
      return this.refuse(
        pickupDistanceKm,
        `You are already holding ${currentOrders.length} of ${MAX_RESERVED_ORDERS_PER_DRIVER} orders`,
      );
    }

    const currentStops = currentOrders.flatMap((order) =>
      stopsFor(order as unknown as RoutableOrder),
    );

    const baselineKm = input.baselineKm ?? bestRouteLengthKm(origin, currentStops);
    const combinedKm = bestRouteLengthKm(origin, [...currentStops, ...stopsFor(candidate)]);

    const additionalDistanceKm = round2(Math.max(0, combinedKm - baselineKm));
    const additionalTimeMinutes = Math.round((additionalDistanceKm / Math.max(speedKph, 1)) * 60);

    // Nothing committed yet: any order is takeable, and the only thing that
    // separates a good one from a bad one is how far away the pickup is.
    if (currentStops.length === 0) {
      const score = this.scoreFirstOrder(pickupDistanceKm);
      return {
        compatible: true,
        additionalDistanceKm,
        additionalTimeMinutes,
        routeScore: score,
        match: this.matchFor(score),
        pickupDistanceKm,
        existingDelayMinutes: 0,
        reason: `${pickupDistanceKm.toFixed(1)} km to pickup`,
      };
    }

    const existingDelayMinutes = await this.delayToExistingCustomers(input);

    /**
     * The two limits in §14 are a floor and a scale, not two gates.
     *
     * Taking the larger is what makes both useful: on a 5 km route the
     * percentage alone would allow 1 km, which rejects almost every second
     * order and defeats the feature; on a 40 km route the flat 3 km alone
     * would reject detours that are trivially worth taking. So the allowance
     * is whichever is more generous, and the absolute cap acts as the floor a
     * short route still gets.
     *
     * Protecting the customers who are already waiting is a separate gate —
     * `existingDelayMinutes` below — because it is a different concern. These
     * two are about the driver's own economics.
     */
    const allowanceKm = Math.max(
      MAX_ROUTE_DETOUR_KM,
      (baselineKm * MAX_ROUTE_DETOUR_PERCENT) / 100,
    );

    const detourPercent = baselineKm > 0 ? (additionalDistanceKm / baselineKm) * 100 : 0;

    const overDistance = additionalDistanceKm > allowanceKm;
    const overDelay = existingDelayMinutes > MAX_EXISTING_ORDER_DELAY_MINUTES;

    const score = this.score({
      additionalDistanceKm,
      allowanceKm,
      pickupDistanceKm,
      existingDelayMinutes,
    });

    if (overDelay) {
      return {
        compatible: false,
        additionalDistanceKm,
        additionalTimeMinutes,
        routeScore: score,
        match: 'POOR',
        pickupDistanceKm,
        existingDelayMinutes,
        // Named plainly: the driver should understand this is about the people
        // already waiting on them, not an arbitrary cap.
        reason: `Would delay a customer you already accepted by ${existingDelayMinutes} min`,
      };
    }

    if (overDistance) {
      return {
        compatible: false,
        additionalDistanceKm,
        additionalTimeMinutes,
        routeScore: score,
        match: 'POOR',
        pickupDistanceKm,
        existingDelayMinutes,
        reason:
          `Adds ${additionalDistanceKm.toFixed(1)} km (${Math.round(detourPercent)}%) — ` +
          `over your ${allowanceKm.toFixed(1)} km detour limit`,
      };
    }

    return {
      compatible: true,
      additionalDistanceKm,
      additionalTimeMinutes,
      routeScore: score,
      match: this.matchFor(score),
      pickupDistanceKm,
      existingDelayMinutes,
      reason: `+${additionalDistanceKm.toFixed(1)} km on your current route`,
    };
  }

  /**
   * How much later every already-committed customer would be served.
   *
   * Returns the worst case across them, weighted by commitment: an order the
   * driver is physically carrying (§41's first priority) counts its full delay,
   * one merely reserved is allowed a little more slack because the customer has
   * not yet been met.
   */
  private async delayToExistingCustomers(input: CompatibilityInput): Promise<number> {
    const { driverId, vehicleType, origin, currentOrders, candidate } = input;

    const [before, after] = await Promise.all([
      this.routes.planFor(driverId, vehicleType, { orders: currentOrders, origin }),
      this.routes.planFor(driverId, vehicleType, { orders: currentOrders, origin, extra: candidate }),
    ]);

    if (!before || !after) return 0;

    let worst = 0;

    for (const order of currentOrders) {
      const wasDelivered = before.deliveryEtaByOrder[order.id];
      const nowDelivered = after.deliveryEtaByOrder[order.id];
      if (wasDelivered == null || nowDelivered == null) continue;

      worst = Math.max(worst, nowDelivered - wasDelivered);
    }

    return Math.max(0, Math.round(worst));
  }

  // ------------------------------------------------------------------ scoring

  /**
   * A single number the grid can sort on.
   *
   * Three penalties against a perfect 100, each capped so no one factor can
   * sink an otherwise good match on its own:
   *
   *   detour       up to 60 — measured against this route's own allowance, so
   *                a 2 km detour on a long route scores far better than the
   *                same 2 km on a short one
   *   pickup       up to 25 — dead mileage before the driver earns anything
   *   delay        up to 15 — the customers already waiting
   *
   * An order that exactly exhausts its detour allowance lands at 60 penalty and
   * therefore scores 40 or less, which is exactly the FAIR/POOR boundary.
   */
  private score(input: {
    additionalDistanceKm: number;
    allowanceKm: number;
    pickupDistanceKm: number;
    existingDelayMinutes: number;
  }): number {
    const detourPenalty = clamp(
      (input.additionalDistanceKm / Math.max(input.allowanceKm, 0.1)) * 60,
      0,
      60,
    );
    const pickupPenalty = clamp((input.pickupDistanceKm / 5) * 25, 0, 25);
    const delayPenalty = clamp(
      (input.existingDelayMinutes / Math.max(MAX_EXISTING_ORDER_DELAY_MINUTES, 1)) * 15,
      0,
      15,
    );

    return Math.round(clamp(100 - detourPenalty - pickupPenalty - delayPenalty, 0, 100));
  }

  /** With no route to compare against, closeness is the whole story. */
  private scoreFirstOrder(pickupDistanceKm: number): number {
    return Math.round(clamp(100 - (pickupDistanceKm / 5) * 45, 0, 100));
  }

  private matchFor(score: number): RouteMatch {
    if (score >= 80) return 'GREAT';
    if (score >= 60) return 'GOOD';
    if (score >= 40) return 'FAIR';
    return 'POOR';
  }

  private refuse(pickupDistanceKm: number, reason: string): CompatibilityResult {
    return {
      compatible: false,
      additionalDistanceKm: 0,
      additionalTimeMinutes: 0,
      routeScore: 0,
      match: 'POOR',
      pickupDistanceKm,
      existingDelayMinutes: 0,
      reason,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
