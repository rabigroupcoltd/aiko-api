export const QUEUE_DRIVER_LOCATION = 'driver-location';
export const QUEUE_RIDE_MATCHING = 'ride-matching';
export const QUEUE_RIDE_TIMEOUT = 'ride-timeout';
export const QUEUE_ORDER_DISPATCH = 'order-dispatch';
export const QUEUE_DRIVER_WATCHDOG = 'driver-watchdog';

export const JOB_FLUSH_LOCATIONS = 'process-driver-location';
export const JOB_FIND_NEARBY_DRIVERS = 'find-nearby-drivers';
export const JOB_CANCEL_UNACCEPTED = 'cancel-unaccepted-order';
export const JOB_EXPAND_ORDER_SEARCH = 'expand-order-search';
export const JOB_CHECK_DRIVER_WATCHDOG = 'check-driver-watchdog';

export const LOCATION_FLUSH_INTERVAL_MS = Number(
  process.env.LOCATION_FLUSH_INTERVAL_MS || 120_000,
);

export const DRIVER_WATCHDOG_INTERVAL_MS = Number(
  process.env.DRIVER_WATCHDOG_INTERVAL_MS || 30_000,
);

export const MATCHING_RETRIES = Number(process.env.MATCHING_RETRIES || 3);
export const MATCHING_RETRY_DELAY_MS = Number(process.env.MATCHING_RETRY_DELAY_MS || 15_000);

export const WORKER_OPTIONS = {
  drainDelay: Number(process.env.QUEUE_DRAIN_DELAY_SECONDS || 60),
} as const;
