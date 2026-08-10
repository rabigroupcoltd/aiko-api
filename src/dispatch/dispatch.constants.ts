import { OrderStatus } from '@prisma/client';

/**
 * Every dial the marketplace turns on, in one place.
 *
 * Read from the environment at boot rather than hard-coded in the services, and
 * echoed back to the driver app through `GET /api/marketplace/config` so the
 * client never has to carry its own copy of a number the server enforces.
 */

/** How many orders one driver may hold at once, reserved or picked up. */
export const MAX_RESERVED_ORDERS_PER_DRIVER = Number(
  process.env.MAX_RESERVED_ORDERS_PER_DRIVER || 3,
);

/** First ring searched around a new order's pickup. */
export const INITIAL_DRIVER_RADIUS_KM = Number(process.env.INITIAL_DRIVER_RADIUS_KM || 5);

/** The search stops widening here; the next failure is NO_DRIVER_FOUND. */
export const MAX_DRIVER_RADIUS_KM = Number(process.env.MAX_DRIVER_RADIUS_KM || 10);

/** Multiplier applied to the radius on each widening pass. */
export const RADIUS_EXPANSION_FACTOR = Number(process.env.RADIUS_EXPANSION_FACTOR || 2);

/** How long a pass runs before the radius widens. */
export const DISPATCH_EXPAND_DELAY_MS = Number(process.env.DISPATCH_EXPAND_DELAY_MS || 45_000);

/** Widening passes allowed before the order is given up on. */
export const MAX_DISPATCH_ATTEMPTS = Number(process.env.MAX_DISPATCH_ATTEMPTS || 3);

/** Absolute extra distance a new order may add to the driver's planned route. */
export const MAX_ROUTE_DETOUR_KM = Number(process.env.MAX_ROUTE_DETOUR_KM || 3);

/**
 * The same limit as a share of the route the driver already committed to.
 *
 * Both apply: a short route is protected by the percentage, a long one by the
 * absolute kilometres, and neither alone would cover both cases.
 */
export const MAX_ROUTE_DETOUR_PERCENT = Number(process.env.MAX_ROUTE_DETOUR_PERCENT || 20);

/**
 * How much later an already-committed customer may be served because of a new
 * order. This is the rule in §41 made numeric — existing promises outrank
 * another pickup.
 */
export const MAX_EXISTING_ORDER_DELAY_MINUTES = Number(
  process.env.MAX_EXISTING_ORDER_DELAY_MINUTES || 8,
);

/**
 * How long a skipped order stays out of that driver's grid. 0 means forever,
 * which is the default — a driver who said no does not want to be asked again
 * every ten seconds.
 */
export const SKIP_COOLDOWN_MINUTES = Number(process.env.SKIP_COOLDOWN_MINUTES || 0);

/** A position older than this cannot be trusted to place a driver. */
export const DRIVER_LOCATION_STALE_SECONDS = Number(
  process.env.DRIVER_LOCATION_STALE_SECONDS || 120,
);

/** Marketplace page size. */
export const MARKETPLACE_PAGE_SIZE = Number(process.env.MARKETPLACE_PAGE_SIZE || 20);

/**
 * Whether a driver may reserve an order the compatibility engine rejected.
 *
 * Off by default. When on, incompatible orders are still returned and still
 * labelled POOR — §16's "the driver can still see it only if the business rules
 * allow it" — but the reservation itself is refused unless this is true.
 */
export const ALLOW_INCOMPATIBLE_RESERVATION =
  process.env.ALLOW_INCOMPATIBLE_RESERVATION === 'true';

/** Fallback road speed when the vehicle's pricing rule has none. */
export const DEFAULT_AVG_SPEED_KPH = Number(process.env.DEFAULT_AVG_SPEED_KPH || 25);

// ------------------------------------------------------------------ statuses

/** Marketplace orders nobody has claimed yet. */
export const OPEN_MARKETPLACE_STATUSES: OrderStatus[] = [OrderStatus.SEARCHING_FOR_DRIVER];

/**
 * Orders that occupy a slot in the driver's capacity.
 *
 * DELIVERED and CANCELLED are absent on purpose: completing one order must free
 * exactly one slot and touch nothing else.
 */
export const DRIVER_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
];

/** The subset the driver has not physically collected yet. */
export const NOT_YET_COLLECTED_STATUSES: OrderStatus[] = [
  OrderStatus.RESERVED,
  OrderStatus.DRIVER_ARRIVING_PICKUP,
];

/** The subset already aboard — only a drop-off remains. */
export const IN_HAND_STATUSES: OrderStatus[] = [OrderStatus.PICKED_UP, OrderStatus.IN_TRANSIT];

/** Legacy ride-lane statuses that also make a driver unavailable for new work. */
export const LEGACY_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.ARRIVED,
  OrderStatus.IN_PROGRESS,
];

/** How well a candidate order fits, as the driver's grid labels it. */
export type RouteMatch = 'GREAT' | 'GOOD' | 'FAIR' | 'POOR';

/** The whole configuration, as the client reads it. */
export const MARKETPLACE_CONFIG = {
  maxReservedOrdersPerDriver: MAX_RESERVED_ORDERS_PER_DRIVER,
  initialDriverRadiusKm: INITIAL_DRIVER_RADIUS_KM,
  maxDriverRadiusKm: MAX_DRIVER_RADIUS_KM,
  maxRouteDetourKm: MAX_ROUTE_DETOUR_KM,
  maxRouteDetourPercent: MAX_ROUTE_DETOUR_PERCENT,
  maxExistingOrderDelayMinutes: MAX_EXISTING_ORDER_DELAY_MINUTES,
  allowIncompatibleReservation: ALLOW_INCOMPATIBLE_RESERVATION,
  skipCooldownMinutes: SKIP_COOLDOWN_MINUTES,
} as const;
