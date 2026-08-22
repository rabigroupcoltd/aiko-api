export const QUEUE_DRIVER_LOCATION = 'driver-location';
export const QUEUE_RIDE_MATCHING = 'ride-matching';
export const QUEUE_RIDE_TIMEOUT = 'ride-timeout';
/** Widens the ring around a marketplace order nobody has claimed. */
export const QUEUE_ORDER_DISPATCH = 'order-dispatch';

export const JOB_FLUSH_LOCATIONS = 'process-driver-location';
export const JOB_FIND_NEARBY_DRIVERS = 'find-nearby-drivers';
export const JOB_CANCEL_UNACCEPTED = 'cancel-unaccepted-order';
export const JOB_EXPAND_ORDER_SEARCH = 'expand-order-search';

/**
 * How often Redis positions are batched into Postgres.
 *
 * Two minutes, not thirty seconds. This is a repeatable job, so it runs on the
 * interval forever whether or not a driver is online, and each cycle costs a
 * handful of Redis commands plus a Postgres round trip — the single largest
 * source of load in an otherwise idle system.
 *
 * Lengthening it costs nothing a user can see. Dispatch reads positions from
 * Redis, never from Postgres; the flushed copy exists for history and for
 * answering "where was this driver" after the fact, and neither needs to be
 * fresh to the second. The worker also returns early when no driver is
 * tracked, so an idle system does not wake the database at all.
 */
export const LOCATION_FLUSH_INTERVAL_MS = Number(
  process.env.LOCATION_FLUSH_INTERVAL_MS || 120_000,
);

/** Retry a widened driver search this many times before giving up on a request. */
export const MATCHING_RETRIES = Number(process.env.MATCHING_RETRIES || 3);
export const MATCHING_RETRY_DELAY_MS = Number(process.env.MATCHING_RETRY_DELAY_MS || 15_000);

/**
 * Worker options every processor shares.
 *
 * `drainDelay` is how long an idle worker blocks on Redis before asking again.
 * BullMQ defaults to 5 seconds, so four idle queues re-issue a blocking read
 * twelve times a minute each, forever, with no jobs anywhere in the system —
 * the bulk of this app's Redis traffic when nobody is using it.
 *
 * At 60 seconds that drops by an order of magnitude and nothing observable
 * changes: the block is interrupted the moment a job is enqueued, so this is
 * how long an *empty* queue takes to notice work, not how long a busy one takes
 * to pick it up.
 */
export const WORKER_OPTIONS = {
  drainDelay: Number(process.env.QUEUE_DRAIN_DELAY_SECONDS || 60),
} as const;
