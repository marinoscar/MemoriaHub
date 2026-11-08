import type { HttpException } from '@nestjs/common';
import { defaultErrorCodeForStatus, withVerbatimErrorBody } from '@marinoscar/platform-api/core';

/**
 * An RFC 8628 device-flow failure: `{ error, error_description }` at the TOP
 * level of the body, which is what the CLI and the Android app branch on
 * (`authorization_pending`, `slow_down`, `expired_token`, ...).
 *
 * The platform exception filter rebuilds every error into its own envelope and
 * would drop `error` / `error_description`, so these exceptions are branded
 * verbatim (`withVerbatimErrorBody`): the filter sends the body exactly as
 * built here. The body keeps the keys the app's previous filter emitted
 * (`statusCode`, `code`, `message`) next to the two RFC keys, minus `path` and
 * `timestamp`, which no device client reads.
 *
 * @param Ctor - the Nest exception class that carries the status (`BadRequestException`, ...).
 * @param error - the RFC error code.
 * @param description - the human description (also used as `message`).
 */
export function rfc8628Error<T extends HttpException>(
  Ctor: new (body: Record<string, unknown>) => T,
  error: string,
  description: string,
): T {
  const status = new Ctor({}).getStatus();
  return withVerbatimErrorBody(
    new Ctor({
      statusCode: status,
      code: defaultErrorCodeForStatus(status),
      message: description,
      error,
      error_description: description,
    }),
  );
}
