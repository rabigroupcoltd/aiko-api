export const SOCKET_EVENTS = {
  CONNECTED: 'connected',
  INFO: 'info',
  ERROR: 'error',
} as const;

export const INFO_CODES = {
  REQUEST_NEW: 'REQUEST_NEW',

  REQUEST_LOST: 'REQUEST_LOST',

  REQUEST_WON: 'REQUEST_WON',

  REQUEST_CLOSED: 'REQUEST_CLOSED',

  ORDER_STATUS: 'ORDER_STATUS',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_RESERVED: 'ORDER_RESERVED',
  ORDER_NO_DRIVER: 'ORDER_NO_DRIVER',
  MESSAGE: 'MESSAGE',
  MESSAGE_READ: 'MESSAGE_READ',
  DRIVER_LOCATION: 'DRIVER_LOCATION',
  KYC_UPDATED: 'KYC_UPDATED',
} as const;

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
} as const;

export type InfoCode = (typeof INFO_CODES)[keyof typeof INFO_CODES];
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const REMOVAL_REASONS = {
  TAKEN: 'TAKEN',
  CANCELLED: 'CANCELLED',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
  SKIPPED: 'SKIPPED',
} as const;

export type RemovalReason = (typeof REMOVAL_REASONS)[keyof typeof REMOVAL_REASONS];

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
