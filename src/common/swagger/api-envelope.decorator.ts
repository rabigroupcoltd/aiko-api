import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

type EnvelopeOptions = {
  message?: string;
  description?: string;
};

function successEnvelope(status: number, message: string, data: unknown) {
  return { code: status, message, data };
}

function errorEnvelope(status: number, message: string, error: string | string[]) {
  return { code: status, message, error };
}

export function ApiOkEnvelope(data: unknown, options: EnvelopeOptions = {}) {
  return ApiResponse({
    status: 200,
    description: options.description ?? 'Success',
    schema: { example: successEnvelope(200, options.message ?? 'SUCCESSFUL', data) },
  });
}

export function ApiOkEnvelopeExamples(
  samples: Record<string, { summary: string; data: unknown; message?: string }>,
  description = 'Success',
) {
  const examples = Object.fromEntries(
    Object.entries(samples).map(([key, sample]) => [
      key,
      {
        summary: sample.summary,
        value: successEnvelope(200, sample.message ?? 'SUCCESSFUL', sample.data),
      },
    ]),
  );

  return ApiResponse({ status: 200, description, content: { 'application/json': { examples } } });
}

export function ApiCreatedEnvelope(data: unknown, options: EnvelopeOptions = {}) {
  return ApiResponse({
    status: 201,
    description: options.description ?? 'Created',
    schema: { example: successEnvelope(201, options.message ?? 'SUCCESSFUL', data) },
  });
}

export function ApiErrorEnvelope(
  status: number,
  message: string,
  error: string | string[],
  description?: string,
) {
  return ApiResponse({
    status,
    description: description ?? error.toString(),
    schema: { example: errorEnvelope(status, message, error) },
  });
}

export function ApiValidationError(error = 'vehicleType must be one of the following values: CAR, BIKE, TRUCK, TRICYCLE, BICYCLE') {
  return ApiErrorEnvelope(400, 'BAD REQUEST', error, 'Validation failed or a business rule was violated');
}

export function ApiUnauthorized(error = 'Unauthorized') {
  return ApiErrorEnvelope(401, 'UNAUTHORIZED', error, 'Missing or invalid access token');
}

export function ApiForbidden(error = 'Forbidden') {
  return ApiErrorEnvelope(403, 'FORBIDDEN', error, 'Authenticated but not permitted');
}

export function ApiNotFound(error = 'Not found') {
  return ApiErrorEnvelope(404, 'NOT FOUND', error, 'Record does not exist');
}

export function ApiConflict(error: string) {
  return ApiErrorEnvelope(409, 'CONFLICT', error, 'Conflicting state');
}

export function ApiAuthErrors() {
  return applyDecorators(ApiUnauthorized());
}

export function ApiAdminErrors() {
  return applyDecorators(ApiUnauthorized(), ApiForbidden('Requires one of: ADMIN'));
}
