export const ERR = {
  NONE: 0,
  BAD_REQUEST: 1,
  EXCEPTION: 2,
  UNAUTHORIZED: 3,
  FORBIDDEN: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  UNAVAILABLE: 7,
} as const;

export type ServiceErrorCode = (typeof ERR)[keyof typeof ERR];

export interface ServiceResult<T = any> {
  error: ServiceErrorCode;
  body: T;
}

export function ok<T>(body: T): ServiceResult<T> {
  return { error: ERR.NONE, body };
}

export function badRequest(message: string): ServiceResult<string> {
  return { error: ERR.BAD_REQUEST, body: message };
}

export function unauthorized(message = 'Unauthorized'): ServiceResult<string> {
  return { error: ERR.UNAUTHORIZED, body: message };
}

export function forbidden(message = 'Forbidden'): ServiceResult<string> {
  return { error: ERR.FORBIDDEN, body: message };
}

export function notFound(message = 'Not found'): ServiceResult<string> {
  return { error: ERR.NOT_FOUND, body: message };
}

export function conflict(message: string): ServiceResult<string> {
  return { error: ERR.CONFLICT, body: message };
}

export function exception(message: string): ServiceResult<string> {
  return { error: ERR.EXCEPTION, body: message };
}

export function isOk<T>(result: ServiceResult<T>): boolean {
  return result.error === ERR.NONE;
}
