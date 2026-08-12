import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The one error body this API ever returns.
 *
 * `HttpExceptionFilter` rebuilds every error response from a fixed key
 * allowlist, so this class is not an approximation of the wire format — it is
 * the complete set of keys that can appear. In particular a custom top-level
 * field on a thrown `HttpException` payload is silently dropped; endpoint-
 * specific data belongs under {@link details}.
 *
 * Kept as an `@ApiProperty` class rather than a zod DTO because nothing
 * validates it — it is documentation-only, produced by the filter and never
 * parsed on the way in.
 */
export class ErrorDto {
  @ApiProperty({
    description: 'HTTP status code, repeated in the body so a logged payload is self-describing.',
    example: 409,
  })
  statusCode!: number;

  @ApiProperty({
    description:
      'Stable machine-readable code derived from the status. Prefer branching on this over ' +
      'matching `message`, which is prose and may change.',
    example: 'CONFLICT',
    enum: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE_ENTITY',
      'TOO_MANY_REQUESTS',
      'INTERNAL_ERROR',
      'ERROR',
    ],
  })
  code!: string;

  @ApiProperty({
    description: 'Human-readable description of what went wrong.',
    example: 'A backup is already running',
  })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Endpoint-specific structured data — the only place a custom field survives the exception ' +
      'filter. Shape varies by endpoint and is documented on the operation that returns it.',
    example: { activeRunId: '3f1b0c5e-9f7a-4a2d-8f1e-2b6c9d0a4e77' },
  })
  details?: unknown;

  @ApiPropertyOptional({
    description:
      'OAuth 2.0 / RFC 8628 error code, forwarded verbatim. Present only on the device-authorization ' +
      'routes and on the maintenance-mode 503 (where it is `maintenance`).',
    example: 'authorization_pending',
  })
  error?: string;

  @ApiPropertyOptional({
    description: 'OAuth 2.0 / RFC 8628 human-readable error description, forwarded verbatim.',
    example: 'The authorization request is still pending',
  })
  error_description?: string;

  @ApiPropertyOptional({
    description: 'Maintenance-mode 503 only: when maintenance was enabled. Null if unknown.',
    type: String,
    nullable: true,
    example: '2026-08-12T04:37:58.000Z',
  })
  startedAt?: string | null;

  @ApiProperty({
    description: 'When the error was produced, ISO 8601 UTC.',
    example: '2026-08-12T04:37:58.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Request path that produced the error.',
    example: '/api/admin/db-backup/runs',
  })
  path!: string;
}
