/**
 * The push contract, as constants.
 *
 * Every message carries a `type` in its data payload; the app switches on it to
 * decide what to refresh and where to navigate when the notification is tapped.
 * Keep this in step with `aiko/src/services/pushNotifications.ts` — the two
 * halves of one wire format.
 */
export const PUSH_TYPES = {
  /** A new job, to every driver the matcher picked. */
  RIDE_REQUEST: 'RIDE_REQUEST',
  /** Silent — the passenger withdrew, drop it from the inbox. */
  RIDE_REQUEST_CANCELLED: 'RIDE_REQUEST_CANCELLED',
  /** Nobody bid inside the TTL. */
  RIDE_REQUEST_EXPIRED: 'RIDE_REQUEST_EXPIRED',
  /** A driver has offered to take the trip. */
  BID_PLACED: 'BID_PLACED',
  /** The passenger picked this driver — the request is now a trip. */
  BID_ACCEPTED: 'BID_ACCEPTED',
  /** Arrived, started, completed. `status` carries which. */
  TRIP_STATUS: 'TRIP_STATUS',
  TRIP_CANCELLED: 'TRIP_CANCELLED',
  TRIP_MESSAGE: 'TRIP_MESSAGE',
  /** An admin cleared or rejected the driver's documents. */
  KYC_STATUS: 'KYC_STATUS',

  /** A marketplace order is open near this driver. */
  ORDER_AVAILABLE: 'ORDER_AVAILABLE',
  /** A driver claimed the customer's order. */
  ORDER_RESERVED: 'ORDER_RESERVED',
  /**
   * Silent — this order is off the market, drop the card.
   *
   * The socket carries the same news as REQUEST_LOST / REQUEST_CLOSED, but a
   * backgrounded driver has no socket, and the ORDER_AVAILABLE tray entry is
   * still sitting on their phone advertising a job they can no longer take.
   *
   * Data-only, and sharing ORDER_AVAILABLE's collapse key so an offer still
   * queued for an offline device is replaced rather than delivered after the
   * fact. Clearing the entry already displayed is the app's job: it drew the
   * notification through Notifee and can cancel it by the same id.
   */
  ORDER_REMOVED: 'ORDER_REMOVED',
  /** The driver collected the parcel. */
  ORDER_PICKED_UP: 'ORDER_PICKED_UP',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  /** The search widened as far as it could and found nobody. */
  ORDER_NO_DRIVER: 'ORDER_NO_DRIVER',
  /** The assigned driver's location stopped arriving mid-trip. */
  DRIVER_UNREACHABLE: 'DRIVER_UNREACHABLE',
} as const;

export type PushType = (typeof PUSH_TYPES)[keyof typeof PUSH_TYPES];

/**
 * Android notification channel for anything time-critical.
 *
 * Left unset by default on purpose: naming a channel the app has not created
 * makes Android fall back to the manifest default, which costs the heads-up
 * behaviour rather than gaining it. Set FCM_RIDE_CHANNEL_ID once the client
 * declares a matching high-importance channel.
 */
export const RIDE_CHANNEL_ID = process.env.FCM_RIDE_CHANNEL_ID || undefined;

/**
 * How long FCM may hold a message for a device that is offline.
 *
 * A ride offer is worthless once the request has expired, so it is given the
 * request's own lifetime rather than the four-week default — a driver coming
 * back online must not be buzzed about a job that closed an hour ago.
 */
export const OFFER_TTL_SECONDS = Number(process.env.RIDE_REQUEST_TTL || 120);

/** Trip updates stay useful for longer, but not indefinitely. */
export const TRIP_TTL_SECONDS = Number(process.env.PUSH_TRIP_TTL || 1800);

/** FCM rejects a multicast with more tokens than this. */
export const MAX_TOKENS_PER_BATCH = 500;
