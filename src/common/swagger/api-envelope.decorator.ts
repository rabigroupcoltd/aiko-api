import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

/**
 * Response helpers that wrap a sample payload in the project envelope.
 *
 * Every endpoint answers with `{ code, message, data }` on success and
 * `{ code, message, error }` on failure (see ResponsesService), so documenting
 * a bare payload would misrepresent the wire format. These decorators take the
 * `data` sample and build the full body around it.
 */

type EnvelopeOptions = {
  /** Overrides the `message` field. Defaults to the code's usual wording. */
  message?: string;
  /** Shown above the sample in the UI. */
  description?: string;
};

function successEnvelope(status: number, message: string, data: unknown) {
  return { code: status, message, data };
}

function errorEnvelope(status: number, message: string, error: string | string[]) {
  return { code: status, message, error };
}

/** 200 with a sample `data` payload. */
export function ApiOkEnvelope(data: unknown, options: EnvelopeOptions = {}) {
  return ApiResponse({
    status: 200,
    description: options.description ?? 'Success',
    schema: { example: successEnvelope(200, options.message ?? 'SUCCESSFUL', data) },
  });
}

/**
 * 200 with several named `data` samples, rendered as a dropdown in the UI.
 *
 * For endpoints whose one success status covers materially different outcomes —
 * showing only one of them would misrepresent what the caller has to handle.
 */
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

/** 201 with a sample `data` payload — for the endpoints that use handleCreated. */
export function ApiCreatedEnvelope(data: unknown, options: EnvelopeOptions = {}) {
  return ApiResponse({
    status: 201,
    description: options.description ?? 'Created',
    schema: { example: successEnvelope(201, options.message ?? 'SUCCESSFUL', data) },
  });
}

/** Any error status with a sample message. */
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

/**
 * The 400 every endpoint can return — the global ValidationPipe flattens
 * constraint messages into a single comma-joined string.
 */
export function ApiValidationError(error = 'vehicleType must be one of the following values: CAR, BIKE, TRUCK, TRICYCLE, BICYCLE') {
  return ApiErrorEnvelope(400, 'BAD REQUEST', error, 'Validation failed or a business rule was violated');
}

/** 401 — missing, malformed or expired bearer token. */
export function ApiUnauthorized(error = 'Unauthorized') {
  return ApiErrorEnvelope(401, 'UNAUTHORIZED', error, 'Missing or invalid access token');
}

/** 403 — authenticated, but not allowed to touch this record. */
export function ApiForbidden(error = 'Forbidden') {
  return ApiErrorEnvelope(403, 'FORBIDDEN', error, 'Authenticated but not permitted');
}

/** 404 — the record does not exist. */
export function ApiNotFound(error = 'Not found') {
  return ApiErrorEnvelope(404, 'NOT FOUND', error, 'Record does not exist');
}

/** 409 — duplicate or conflicting state. */
export function ApiConflict(error: string) {
  return ApiErrorEnvelope(409, 'CONFLICT', error, 'Conflicting state');
}

/** The pair every authenticated route shares. */
export function ApiAuthErrors() {
  return applyDecorators(ApiUnauthorized());
}

/** The pair every admin-only route shares. */
export function ApiAdminErrors() {
  return applyDecorators(ApiUnauthorized(), ApiForbidden('Requires one of: ADMIN'));
}
