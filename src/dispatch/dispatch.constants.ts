import { OrderStatus } from '@prisma/client';

export const MAX_RESERVED_ORDERS_PER_DRIVER = Number(
  process.env.MAX_RESERVED_ORDERS_PER_DRIVER || 3,
);

export const INITIAL_DRIVER_RADIUS_KM = Number(process.env.INITIAL_DRIVER_RADIUS_KM || 5);

export const MAX_DRIVER_RADIUS_KM = Number(process.env.MAX_DRIVER_RADIUS_KM || 10);

export const RADIUS_EXPANSION_FACTOR = Number(process.env.RADIUS_EXPANSION_FACTOR || 2);

export const DISPATCH_EXPAND_DELAY_MS = Number(process.env.DISPATCH_EXPAND_DELAY_MS || 45_000);


export const MAX_ROUTE_DETOUR_KM = Number(process.env.MAX_ROUTE_DETOUR_KM || 3);

export const MAX_ROUTE_DETOUR_PERCENT = Number(process.env.MAX_ROUTE_DETOUR_PERCENT || 20);

export const MAX_EXISTING_ORDER_DELAY_MINUTES = Number(
  process.env.MAX_EXISTING_ORDER_DELAY_MINUTES || 8,
);

// How long a rider has to hand back an order an admin assigned to them.
export const ASSIGNMENT_DECLINE_MINUTES = Number(process.env.ASSIGNMENT_DECLINE_MINUTES || 5);

// How long after closing as NO_DRIVER_FOUND an admin can still revive an order.
export const NO_DRIVER_REVIVE_MINUTES = Number(process.env.NO_DRIVER_REVIVE_MINUTES || 15);

export const SKIP_COOLDOWN_MINUTES = Number(process.env.SKIP_COOLDOWN_MINUTES || 0);

export const DRIVER_LOCATION_STALE_SECONDS = Number(
  process.env.DRIVER_LOCATION_STALE_SECONDS || 120,
);

export const MARKETPLACE_PAGE_SIZE = Number(process.env.MARKETPLACE_PAGE_SIZE || 20);

export const ALLOW_INCOMPATIBLE_RESERVATION =
  process.env.ALLOW_INCOMPATIBLE_RESERVATION === 'true';

export const DEFAULT_AVG_SPEED_KPH = Number(process.env.DEFAULT_AVG_SPEED_KPH || 25);

export const OPEN_MARKETPLACE_STATUSES: OrderStatus[] = [OrderStatus.SEARCHING_FOR_DRIVER];

export const DRIVER_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
];

export const NOT_YET_COLLECTED_STATUSES: OrderStatus[] = [
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
];

export const IN_HAND_STATUSES: OrderStatus[] = [OrderStatus.PICKED_UP, OrderStatus.IN_TRANSIT];

export const LEGACY_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.ARRIVED,
  OrderStatus.IN_PROGRESS,
];

export type RouteMatch = 'GREAT' | 'GOOD' | 'FAIR' | 'POOR';

export const MARKETPLACE_CONFIG = {
  maxReservedOrdersPerDriver: MAX_RESERVED_ORDERS_PER_DRIVER,
  initialDriverRadiusKm: INITIAL_DRIVER_RADIUS_KM,
  maxDriverRadiusKm: MAX_DRIVER_RADIUS_KM,
  maxRouteDetourKm: MAX_ROUTE_DETOUR_KM,
  maxRouteDetourPercent: MAX_ROUTE_DETOUR_PERCENT,
  maxExistingOrderDelayMinutes: MAX_EXISTING_ORDER_DELAY_MINUTES,
  allowIncompatibleReservation: ALLOW_INCOMPATIBLE_RESERVATION,
  skipCooldownMinutes: SKIP_COOLDOWN_MINUTES,
  assignmentDeclineMinutes: ASSIGNMENT_DECLINE_MINUTES,
} as const;
