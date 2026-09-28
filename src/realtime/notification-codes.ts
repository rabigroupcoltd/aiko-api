/**
 * The whole socket vocabulary, as data.
 *
 * The socket carries notifications and nothing else — no client ever emits, and
 * every server push is one of three events: `connected` once at handshake, then
 * `info` or `error` forever after. What actually happened is carried by `code`,
 * which is why these are strings rather than the numeric ERR values the REST
 * envelope uses: a client switches on the code to decide what to do with `data`,
 * and `200` would tell it nothing.
 *
 * Mutations all go through REST. That split is deliberate — a socket that only
 * ever pushes has no request/response state to resynchronise after a reconnect,
 * so the client's recovery path is one `GET /api/drivers/state` call rather than
 * a replay of in-flight acknowledgements.
 */

/** Payload-carrying server events. `connected` is the third and stands alone. */
export const SOCKET_EVENTS = {
  /** Sent once, immediately after the handshake, then never again. */
  CONNECTED: 'connected',
  /** Something happened. `{ code, message, data }`. */
  INFO: 'info',
  /** Something failed. `{ code, message, error }`. */
  ERROR: 'error',
} as const;

/**
 * `info` codes.
 *
 * Grouped by who listens. A driver client can ignore every ORDER_* code that is
 * not about an order it holds, and a passenger client ignores the REQUEST_*
 * block entirely — the card grid is a driver concept.
 */
export const INFO_CODES = {
  // ---------------------------------------------------------------- driver
  /**
   * A new job is open near this driver. Add a card.
   *
   * Fanned out to every driver the radius search picked, so receiving it is
   * already proof the order is within range — the client does no geo filtering
   * of its own.
   */
  REQUEST_NEW: 'REQUEST_NEW',

  /**
   * Another driver claimed it first. Remove the card.
   *
   * This is the losing half of fastest-finger: the winner gets REQUEST_WON, and
   * everyone who was shown the same card gets this. Sent to drivers who were
   * offered the order, not broadcast to the namespace, so a client never has to
   * reason about ids it was never given.
   */
  REQUEST_LOST: 'REQUEST_LOST',

  /**
   * You won it. Remove the card, open the trip.
   *
   * Redundant with the 200 from `POST /api/marketplace/orders/:id/reserve` — and
   * deliberately so. The REST response can be lost to a dropped connection at
   * the exact moment the order became yours, and a driver who never learns they
   * won is a driver who strands a customer.
   */
  REQUEST_WON: 'REQUEST_WON',

  /**
   * The job is off the market for a reason that is nobody's win — the passenger
   * cancelled, or the search widened as far as it could and gave up. Remove the
   * card.
   */
  REQUEST_CLOSED: 'REQUEST_CLOSED',

  // ------------------------------------------------------------- both sides
  /** A trip moved to a new status. Both parties get it. */
  ORDER_STATUS: 'ORDER_STATUS',
  /** A trip was cancelled. Carries `cancellationReason`. */
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  /** A driver claimed the passenger's order — who is coming, and the ETA. */
  ORDER_RESERVED: 'ORDER_RESERVED',
  /** Nobody took it before the search gave up. Terminal for the passenger. */
  ORDER_NO_DRIVER: 'ORDER_NO_DRIVER',
  /** A chat message on a trip. */
  MESSAGE: 'MESSAGE',
  /**
   * The other party opened the chat and your messages are now read.
   *
   * Raised only when something actually changed, so a chat screen sitting open
   * and polling does not emit a receipt every twenty seconds.
   */
  MESSAGE_READ: 'MESSAGE_READ',
  /** The assigned driver moved. This animates the marker. */
  DRIVER_LOCATION: 'DRIVER_LOCATION',
  /** An admin cleared or rejected this driver's documents. */
  KYC_UPDATED: 'KYC_UPDATED',
} as const;

/** `error` codes. Rare — the socket pushes, so there is little to reject. */
export const ERROR_CODES = {
  /** The handshake token was missing, malformed or expired. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** The server could not build a notification it had already committed to. */
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
} as const;

export type InfoCode = (typeof INFO_CODES)[keyof typeof INFO_CODES];
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Why a card left the grid. Carried on REQUEST_LOST and REQUEST_CLOSED. */
export const REMOVAL_REASONS = {
  /** Another driver reserved it. */
  TAKEN: 'TAKEN',
  /** The passenger called it off. */
  CANCELLED: 'CANCELLED',
  /** The search exhausted its widening passes. */
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
  /** This driver skipped it themselves — echoed so other devices agree. */
  SKIPPED: 'SKIPPED',
} as const;

export type RemovalReason = (typeof REMOVAL_REASONS)[keyof typeof REMOVAL_REASONS];

// ---------------------------------------------------------------- envelopes

export interface InfoEnvelope<T = unknown> {
  code: InfoCode;
  message: string;
  data: T;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  error: string;
}

export function info<T>(code: InfoCode, message: string, data: T): InfoEnvelope<T> {
  return { code, message, data };
}

export function socketError(code: ErrorCode, message: string, error = message): ErrorEnvelope {
  return { code, message, error };
}
