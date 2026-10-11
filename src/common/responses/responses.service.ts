import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiErrorResponse, ApiSuccessResponse, PaginatedResponse } from './api-response.dto';
import { mapPrismaError } from './prisma-error';
import { ERR, ServiceErrorCode, ServiceResult } from './response.types';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

@Injectable()
export class ResponsesService {
  private readonly logger = new Logger(ResponsesService.name);

  readonly responseCodes = {
    SUCCESS: HttpStatus.OK,
    CREATED: HttpStatus.CREATED,
    INVALID_REQUEST: HttpStatus.BAD_REQUEST,
    UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
    FORBIDDEN: HttpStatus.FORBIDDEN,
    NOT_FOUND: HttpStatus.NOT_FOUND,
    CONFLICT: HttpStatus.CONFLICT,
    UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
    EXCEPTION: HttpStatus.INTERNAL_SERVER_ERROR,
  };

  readonly responseMessages = {
    SUCCESS: 'SUCCESSFUL',
    CREATED: 'CREATED',
    INVALID_REQUEST: 'INVALID REQUEST',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    NOT_FOUND: 'NOT FOUND',
    CONFLICT: 'CONFLICT',
    UNAVAILABLE: 'SERVICE UNAVAILABLE',
    EXCEPTION: 'INTERNAL SERVER ERROR',
  };

  success<T>(data: T, message?: string): ApiSuccessResponse<T> {
    return {
      code: this.responseCodes.SUCCESS,
      message: message ?? this.responseMessages.SUCCESS,
      data: this.cast(data),
    };
  }

  created<T>(data: T, message?: string): ApiSuccessResponse<T> {
    return {
      code: this.responseCodes.CREATED,
      message: message ?? this.responseMessages.CREATED,
      data: this.cast(data),
    };
  }

  badRequest(error: any): ApiErrorResponse {
    return this.error(this.responseCodes.INVALID_REQUEST, this.responseMessages.INVALID_REQUEST, error);
  }

  unauthorized(error: any = 'Invalid or missing credentials'): ApiErrorResponse {
    return this.error(this.responseCodes.UNAUTHORIZED, this.responseMessages.UNAUTHORIZED, error);
  }

  forbidden(error: any = 'You do not have access to this resource'): ApiErrorResponse {
    return this.error(this.responseCodes.FORBIDDEN, this.responseMessages.FORBIDDEN, error);
  }

  notFound(error: any = 'Resource not found'): ApiErrorResponse {
    return this.error(this.responseCodes.NOT_FOUND, this.responseMessages.NOT_FOUND, error);
  }

  conflict(error: any): ApiErrorResponse {
    return this.error(this.responseCodes.CONFLICT, this.responseMessages.CONFLICT, error);
  }

  unavailable(error: any = 'Service temporarily unavailable'): ApiErrorResponse {
    return this.error(this.responseCodes.UNAVAILABLE, this.responseMessages.UNAVAILABLE, error);
  }

  exception(error: any): ApiErrorResponse {
    this.logger.error(`Unhandled failure: ${stringify(error)}`);

    return this.error(
      this.responseCodes.EXCEPTION,
      this.responseMessages.EXCEPTION,
      IS_PRODUCTION ? 'Something went wrong, please try again' : error,
    );
  }

  error(code: number, message: string, error: any): ApiErrorResponse {
    return { code, message, error: normaliseError(error) };
  }

  handle<T>(result: ServiceResult<T>, options: { created?: boolean; message?: string } = {}) {
    switch (result.error) {
      case ERR.NONE:
        return options.created
          ? this.created(result.body, options.message)
          : this.success(result.body, options.message);
      case ERR.BAD_REQUEST:
        return this.badRequest(result.body);
      case ERR.UNAUTHORIZED:
        return this.unauthorized(result.body);
      case ERR.FORBIDDEN:
        return this.forbidden(result.body);
      case ERR.NOT_FOUND:
        return this.notFound(result.body);
      case ERR.CONFLICT:
        return this.conflict(result.body);
      case ERR.UNAVAILABLE:
        return this.unavailable(result.body);
      default:
        return this.exception(result.body);
    }
  }

  handleCreated<T>(result: ServiceResult<T>, message?: string) {
    return this.handle(result, { created: true, message });
  }

  errorHandler(e: any): ServiceResult<string> {
    const prisma = mapPrismaError(e);
    if (prisma) {
      this.logger.warn(`Prisma ${prisma.prismaCode ?? 'error'}: ${stringify(e?.message)}`);

      const body =
        prisma.revealsInternals && IS_PRODUCTION
          ? 'The request could not be processed'
          : prisma.body;

      return { error: prisma.error, body };
    }

    if (e instanceof HttpException) {
      return { error: statusToErrorCode(e.getStatus()), body: extractHttpMessage(e) };
    }

    if (e instanceof Error) {
      this.logger.error(e.stack ?? e.message);
      return { error: ERR.EXCEPTION, body: e.message };
    }

    return { error: ERR.EXCEPTION, body: stringify(e) };
  }

  pagination(page?: number, size?: number) {
    const limit = size ? Number(size) : 10;
    const offset = page ? (Number(page) - 1) * limit : 0;
    return { limit, offset };
  }

  pagingData<T>(
    data: { totalItems: number; result: T[] },
    page?: number,
    limit = 10,
  ): PaginatedResponse<T> {
    const { totalItems, result } = data;
    return {
      totalItems,
      totalPages: totalItems > limit ? Math.ceil(totalItems / limit) : 1,
      currentPage: page ? Number(page) : 1,
      result,
    };
  }

  cast(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') return obj.toString();
    if (obj instanceof Date) return obj.toISOString();
    if (this.isDecimal(obj)) return obj.toString();

    if (Array.isArray(obj)) return obj.map((value) => this.cast(value));

    if (typeof obj === 'object' && isPlainObject(obj)) {
      const next: Record<string, any> = {};
      for (const key of Object.keys(obj)) next[key] = this.cast(obj[key]);
      return next;
    }

    return obj;
  }

  isDecimal(object: any): boolean {
    return (
      typeof object === 'object' &&
      object !== null &&
      typeof (object as any).s === 'number' &&
      typeof (object as any).e === 'number' &&
      Array.isArray((object as any).d)
    );
  }
}

export function statusToErrorCode(status: number): ServiceErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ERR.BAD_REQUEST;
    case HttpStatus.UNAUTHORIZED:
      return ERR.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ERR.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ERR.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ERR.CONFLICT;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ERR.UNAVAILABLE;
    default:
      return status >= 400 && status < 500 ? ERR.BAD_REQUEST : ERR.EXCEPTION;
  }
}

export function extractHttpMessage(e: HttpException): string {
  const response = e.getResponse();

  if (typeof response === 'string') return response;

  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string') return message;

  return e.message;
}

function normaliseError(error: any): string | string[] {
  if (Array.isArray(error)) return error.map(String);
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return stringify(error);
}

function stringify(value: any): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
