import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ResponsesService, extractHttpMessage } from '../responses/responses.service';
import { mapPrismaError } from '../responses/prisma-error';
import { ERR, ServiceErrorCode } from '../responses/response.types';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly responses: ResponsesService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.toEnvelope(exception);

    if (body.code >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (
      request.method !== 'GET' &&
      body.code !== HttpStatus.UNAUTHORIZED &&
      body.code !== HttpStatus.NOT_FOUND
    ) {
      this.logger.warn(
        `${request.method} ${request.path} -> ${body.code}: ${JSON.stringify((body as any).message)}`,
      );
    }

    response.status(body.code).json(body);
  }

  private toEnvelope(exception: unknown) {
    const prisma = mapPrismaError(exception);
    if (prisma) return this.fromCode(prisma.error, prisma.body);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      const message =
        typeof payload === 'object' && Array.isArray((payload as any).message)
          ? (payload as any).message
          : extractHttpMessage(exception);

      return this.responses.error(status, httpStatusLabel(status), message);
    }

    return this.responses.exception(
      exception instanceof Error ? exception.message : 'Unexpected error',
    );
  }

  private fromCode(code: ServiceErrorCode, message: string) {
    return this.responses.handle({ error: code, body: message }) as ReturnType<
      ResponsesService['error']
    >;
  }
}

function httpStatusLabel(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'INVALID REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD TOO LARGE';
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return 'UNSUPPORTED MEDIA TYPE';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO MANY REQUESTS';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL SERVER ERROR' : 'REQUEST FAILED';
  }
}

export const FILTER_ERROR_CODES = ERR;
