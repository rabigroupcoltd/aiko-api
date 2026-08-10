export const QUEUE_DRIVER_LOCATION = 'driver-location';
export const QUEUE_RIDE_MATCHING = 'ride-matching';
export const QUEUE_RIDE_TIMEOUT = 'ride-timeout';
/** Widens the ring around a marketplace order nobody has claimed. */
export const QUEUE_ORDER_DISPATCH = 'order-dispatch';

export const JOB_FLUSH_LOCATIONS = 'process-driver-location';
export const JOB_FIND_NEARBY_DRIVERS = 'find-nearby-drivers';
export const JOB_CANCEL_UNACCEPTED = 'cancel-unaccepted-order';
export const JOB_EXPAND_ORDER_SEARCH = 'expand-order-search';

/** How often Redis positions are batched into Postgres. */
export const LOCATION_FLUSH_INTERVAL_MS = Number(process.env.LOCATION_FLUSH_INTERVAL_MS || 30_000);

/** Retry a widened driver search this many times before giving up on a request. */
export const MATCHING_RETRIES = Number(process.env.MATCHING_RETRIES || 3);
export const MATCHING_RETRY_DELAY_MS = Number(process.env.MATCHING_RETRY_DELAY_MS || 15_000);
