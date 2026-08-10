import { OrderStatus } from '@prisma/client';
import { estimateRoadDistanceKm, round2 } from '../common/geo.util';
import { IN_HAND_STATUSES } from './dispatch.constants';

/**
 * Route planning for a driver carrying several orders at once.
 *
 * Deliberately arithmetic, not a service call: §17 asks for a deterministic
 * distance/route score for the MVP, and a Directions API round trip per
 * candidate order per driver poll would be both slow and expensive. Everything
 * here is straight-line distance scaled by ROAD_DISTANCE_FACTOR, the same
 * approximation the fare quote already uses — so a detour estimate and the price
 * the customer was shown come from one model rather than two that disagree.
 *
 * Swapping in real road distances later means replacing `legKm` and nothing else.
 */

export type StopKind = 'PICKUP' | 'DROPOFF';

export interface Point {
  lat: number;
  lng: number;
}

export interface RouteStop extends Point {
  orderId: string;
  kind: StopKind;
  address: string;
  /** Present on the driver's own route; never on a marketplace preview. */
  phone?: string | null;
  status?: OrderStatus;
}

export interface PlannedStop extends RouteStop {
  /** 1-based position in the route the driver should drive. */
  sequence: number;
  /** Distance from the previous stop, or from the driver for the first. */
  legKm: number;
  /** Distance from the driver's current position to this stop, along the route. */
  cumulativeKm: number;
  /** Minutes from now to this stop, at the planning speed. */
  etaMinutes: number;
}

export interface RoutePlan {
  stops: PlannedStop[];
  totalKm: number;
  totalMinutes: number;
  /** Arrival time in minutes at each order's drop-off, keyed by order id. */
  deliveryEtaByOrder: Record<string, number>;
  /** Arrival time in minutes at each order's pickup. Absent once collected. */
  pickupEtaByOrder: Record<string, number>;
}

/** One order reduced to the stops it still owes the driver. */
export interface RoutableOrder {
  id: string;
  status: OrderStatus;
  pickupLat: number;
  pickupLng: number;
  pickupLocation: string;
  pickupPhone?: string | null;
  dropoffLat: number;
  dropoffLng: number;
  dropoffLocation: string;
  dropoffPhone?: string | null;
}

/**
 * The stops an order still requires.
 *
 * An order the driver is already carrying has no pickup left — including one
 * would send them back to a place they have been, and would make every detour
 * estimate wrong.
 */
export function stopsFor(order: RoutableOrder): RouteStop[] {
  const dropoff: RouteStop = {
    orderId: order.id,
    kind: 'DROPOFF',
    lat: order.dropoffLat,
    lng: order.dropoffLng,
    address: order.dropoffLocation,
    phone: order.dropoffPhone ?? null,
    status: order.status,
  };

  if (IN_HAND_STATUSES.includes(order.status)) return [dropoff];

  return [
    {
      orderId: order.id,
      kind: 'PICKUP',
      lat: order.pickupLat,
      lng: order.pickupLng,
      address: order.pickupLocation,
      phone: order.pickupPhone ?? null,
      status: order.status,
    },
    dropoff,
  ];
}

export function legKm(from: Point, to: Point): number {
  return estimateRoadDistanceKm(from.lat, from.lng, to.lat, to.lng);
}

function minutesFor(km: number, speedKph: number): number {
  return (km / Math.max(speedKph, 1)) * 60;
}

/**
 * Orders the stops into a route the driver can actually drive.
 *
 * Nearest-neighbour under one precedence rule — an order's drop-off is only
 * reachable once its pickup has been visited — followed by a relocation pass
 * that moves single stops to cheaper positions. That is enough to produce the
 * interleaved routes §19 asks for (pickup A, pickup B, drop-off A, pickup C…)
 * without pretending to solve a pickup-and-delivery TSP: the fleet here carries
 * at most MAX_RESERVED_ORDERS_PER_DRIVER orders, so the search space is six
 * stops on a bad day.
 */
export function planRoute(origin: Point, stops: RouteStop[], speedKph: number): RoutePlan {
  const ordered = improve(nearestNeighbour(origin, stops), origin);
  return measure(origin, ordered, speedKph);
}

/** Total road distance of a sequence, starting from the driver. */
export function routeLengthKm(origin: Point, stops: RouteStop[]): number {
  let total = 0;
  let cursor: Point = origin;

  for (const stop of stops) {
    total += legKm(cursor, stop);
    cursor = stop;
  }

  return total;
}

/** The cheapest legal ordering this planner can find, as a distance. */
export function bestRouteLengthKm(origin: Point, stops: RouteStop[]): number {
  if (stops.length === 0) return 0;
  return routeLengthKm(origin, improve(nearestNeighbour(origin, stops), origin));
}

// ------------------------------------------------------------------ internals

function nearestNeighbour(origin: Point, stops: RouteStop[]): RouteStop[] {
  const remaining = [...stops];
  const route: RouteStop[] = [];
  const collected = new Set<string>();
  let cursor: Point = origin;

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const stop = remaining[index];
      if (!isReachable(stop, collected, stops)) continue;

      const distance = legKm(cursor, stop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    // Only possible if a drop-off's pickup is missing from the set entirely,
    // which `stopsFor` cannot produce — take the head rather than spin.
    if (bestIndex === -1) bestIndex = 0;

    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen.kind === 'PICKUP') collected.add(chosen.orderId);
    route.push(chosen);
    cursor = chosen;
  }

  return route;
}

/** A drop-off waits for its own pickup; a pickup is always reachable. */
function isReachable(stop: RouteStop, collected: Set<string>, all: RouteStop[]): boolean {
  if (stop.kind === 'PICKUP') return true;
  const hasPickup = all.some((s) => s.orderId === stop.orderId && s.kind === 'PICKUP');
  return !hasPickup || collected.has(stop.orderId);
}

/**
 * Relocation pass: try each stop at every other position, keep any move that
 * shortens the route and keeps it legal. Repeats until nothing improves.
 */
function improve(route: RouteStop[], origin: Point): RouteStop[] {
  if (route.length < 3) return route;

  let best = route;
  let bestLength = routeLengthKm(origin, best);
  let improved = true;
  // Bounded so a pathological input cannot loop; six stops converge in one or two.
  let passes = 0;

  while (improved && passes < 8) {
    improved = false;
    passes += 1;

    for (let from = 0; from < best.length; from += 1) {
      for (let to = 0; to < best.length; to += 1) {
        if (from === to) continue;

        const candidate = [...best];
        const [moved] = candidate.splice(from, 1);
        candidate.splice(to, 0, moved);

        if (!isLegal(candidate)) continue;

        const length = routeLengthKm(origin, candidate);
        if (length < bestLength - 0.001) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }
  }

  return best;
}

function isLegal(route: RouteStop[]): boolean {
  const collected = new Set<string>();

  for (const stop of route) {
    if (stop.kind === 'PICKUP') {
      collected.add(stop.orderId);
      continue;
    }

    const hasPickup = route.some((s) => s.orderId === stop.orderId && s.kind === 'PICKUP');
    if (hasPickup && !collected.has(stop.orderId)) return false;
  }

  return true;
}

function measure(origin: Point, stops: RouteStop[], speedKph: number): RoutePlan {
  const planned: PlannedStop[] = [];
  const deliveryEtaByOrder: Record<string, number> = {};
  const pickupEtaByOrder: Record<string, number> = {};

  let cursor: Point = origin;
  let cumulative = 0;

  stops.forEach((stop, index) => {
    const leg = legKm(cursor, stop);
    cumulative += leg;

    const etaMinutes = Math.round(minutesFor(cumulative, speedKph));

    planned.push({
      ...stop,
      sequence: index + 1,
      legKm: round2(leg),
      cumulativeKm: round2(cumulative),
      etaMinutes,
    });

    if (stop.kind === 'DROPOFF') deliveryEtaByOrder[stop.orderId] = etaMinutes;
    else pickupEtaByOrder[stop.orderId] = etaMinutes;

    cursor = stop;
  });

  return {
    stops: planned,
    totalKm: round2(cumulative),
    totalMinutes: Math.round(minutesFor(cumulative, speedKph)),
    deliveryEtaByOrder,
    pickupEtaByOrder,
  };
}
