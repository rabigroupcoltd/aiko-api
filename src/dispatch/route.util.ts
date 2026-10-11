import { OrderStatus } from '@prisma/client';
import { estimateRoadDistanceKm, round2 } from '../common/geo.util';
import { IN_HAND_STATUSES } from './dispatch.constants';

export type StopKind = 'PICKUP' | 'DROPOFF';

export interface Point {
  lat: number;
  lng: number;
}

export interface RouteStop extends Point {
  orderId: string;
  kind: StopKind;
  address: string;
  phone?: string | null;
  status?: OrderStatus;
}

export interface PlannedStop extends RouteStop {
  sequence: number;
  legKm: number;
  cumulativeKm: number;
  etaMinutes: number;
}

export interface RoutePlan {
  stops: PlannedStop[];
  totalKm: number;
  totalMinutes: number;
  deliveryEtaByOrder: Record<string, number>;
  pickupEtaByOrder: Record<string, number>;
}

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

export function planRoute(origin: Point, stops: RouteStop[], speedKph: number): RoutePlan {
  const ordered = improve(nearestNeighbour(origin, stops), origin);
  return measure(origin, ordered, speedKph);
}

export function routeLengthKm(origin: Point, stops: RouteStop[]): number {
  let total = 0;
  let cursor: Point = origin;

  for (const stop of stops) {
    total += legKm(cursor, stop);
    cursor = stop;
  }

  return total;
}

export function bestRouteLengthKm(origin: Point, stops: RouteStop[]): number {
  if (stops.length === 0) return 0;
  return routeLengthKm(origin, improve(nearestNeighbour(origin, stops), origin));
}

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

    if (bestIndex === -1) bestIndex = 0;

    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen.kind === 'PICKUP') collected.add(chosen.orderId);
    route.push(chosen);
    cursor = chosen;
  }

  return route;
}

function isReachable(stop: RouteStop, collected: Set<string>, all: RouteStop[]): boolean {
  if (stop.kind === 'PICKUP') return true;
  const hasPickup = all.some((s) => s.orderId === stop.orderId && s.kind === 'PICKUP');
  return !hasPickup || collected.has(stop.orderId);
}

function improve(route: RouteStop[], origin: Point): RouteStop[] {
  if (route.length < 3) return route;

  let best = route;
  let bestLength = routeLengthKm(origin, best);
  let improved = true;
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
