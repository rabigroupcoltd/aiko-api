/**
 * Service-layer result contract.
 *
 * Services never throw at their boundary — they catch and return one of these,
 * and the controller turns it into an HTTP envelope. `0`, `1` and `2` keep the
 * same meaning as in the `api` project; the rest exist so a service can ask for
 * a 401/403/404/409 instead of collapsing everything into a 400 or a 500.
 */
export const ERR = {
  /** Success. */
  NONE: 0,
  /** Business rule violated — 400. */
  BAD_REQUEST: 1,
  /** Unhandled failure — 500. */
  EXCEPTION: 2,
  /** Missing or invalid credentials — 401. */
  UNAUTHORIZED: 3,
  /** Authenticated but not permitted — 403. */
  FORBIDDEN: 4,
  /** Record does not exist — 404. */
  NOT_FOUND: 5,
  /** Duplicate or conflicting state — 409. */
  CONFLICT: 6,
  /** Dependency unavailable — 503. */
  UNAVAILABLE: 7,
} as const;

export type ServiceErrorCode = (typeof ERR)[keyof typeof ERR];

export interface ServiceResult<T = any> {
  error: ServiceErrorCode;
  body: T;
}

// ------------------------------------------------------------- constructors

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

/** True when the result carries data rather than an error message. */
export function isOk<T>(result: ServiceResult<T>): boolean {
  return result.error === ERR.NONE;
}
