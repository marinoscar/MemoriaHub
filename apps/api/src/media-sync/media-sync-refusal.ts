import { HttpException, type HttpStatus } from '@nestjs/common';

import type { MediaSyncReason } from './media-sync.constants';

/**
 * A Media Sync refusal with a stable `details.reason`. `HttpExceptionFilter`
 * derives the error `code` from the HTTP status and rebuilds the body from an
 * allowlist, so the reason and every extra field live under `details`
 * (docs/specs/android-media-sync.md D1).
 */
export function mediaSyncRefusal(
  status: HttpStatus,
  reason: MediaSyncReason,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ message, details: { reason, ...extra } }, status);
}
