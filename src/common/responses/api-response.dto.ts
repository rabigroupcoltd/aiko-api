import { ApiProperty } from '@nestjs/swagger';

/**
 * The two envelope shapes every endpoint returns.
 *
 *   code < 400  ->  { code, message, data }
 *   code >= 400 ->  { code, message, error }
 *
 * `code` is always the HTTP status, and the StatusInterceptor sets the real
 * response status from it, so the body and the status line never disagree.
 */

export class ApiSuccessResponse<T = any> {
  /** HTTP status. Always < 400 here. */
  @ApiProperty({ example: 200, description: 'HTTP status. Always < 400 here.' })
  code: number;

  /** Human-readable outcome, e.g. `SUCCESSFUL`. */
  @ApiProperty({ example: 'SUCCESSFUL' })
  message: string;

  /** The payload. */
  @ApiProperty({ description: 'The payload. Shape depends on the endpoint.' })
  data: T;
}

export class ApiErrorResponse {
  /** HTTP status. Always >= 400 here. */
  @ApiProperty({ example: 400, description: 'HTTP status. Always >= 400 here.' })
  code: number;

  /** Short category, e.g. `NOT FOUND`. */
  @ApiProperty({ example: 'BAD REQUEST' })
  message: string;

  /** What went wrong — a string, or a list of validation messages. */
  @ApiProperty({
    example: 'amount must not be less than 1',
    description: 'A string, or a list of validation messages.',
  })
  error: string | string[];
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Shape returned inside `data` for any paginated list. */
export class PaginatedResponse<T = any> {
  @ApiProperty({ example: 47 })
  totalItems: number;

  @ApiProperty({ example: 3 })
  totalPages: number;

  @ApiProperty({ example: 1 })
  currentPage: number;

  @ApiProperty({ isArray: true, description: 'The page of rows.' })
  result: T[];
}
