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

export interface CompatibilityInput {
  driverId: string;
  vehicleType: VehicleType;
  origin: Point;
  currentOrders: Order[];
  candidate: RoutableOrder;
  baselineKm?: number;
  speedKph?: number;
}

export interface CompatibilityResult {
  compatible: boolean;
  additionalDistanceKm: number;
  additionalTimeMinutes: number;
  routeScore: number;
  match: RouteMatch;
  pickupDistanceKm: number;
  existingDelayMinutes: number;
  reason: string;
}

@Injectable()
export class OrderCompatibilityService {
  private readonly logger = new Logger(OrderCompatibilityService.name);

  constructor(private routes: RouteOptimizerService) {}

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
