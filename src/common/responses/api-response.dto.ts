import { ApiProperty } from '@nestjs/swagger';

export class ApiSuccessResponse<T = any> {
  @ApiProperty({ example: 200, description: 'HTTP status. Always < 400 here.' })
  code: number;

  @ApiProperty({ example: 'SUCCESSFUL' })
  message: string;

  @ApiProperty({ description: 'The payload. Shape depends on the endpoint.' })
  data: T;
}

export class ApiErrorResponse {
  @ApiProperty({ example: 400, description: 'HTTP status. Always >= 400 here.' })
  code: number;

  @ApiProperty({ example: 'BAD REQUEST' })
  message: string;

  @ApiProperty({
    example: 'amount must not be less than 1',
    description: 'A string, or a list of validation messages.',
  })
  error: string | string[];
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

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
