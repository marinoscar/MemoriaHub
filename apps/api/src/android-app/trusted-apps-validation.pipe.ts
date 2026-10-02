import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { TRUSTED_APPS_ERROR_REASONS, type TrustedAppsErrorReason } from './android-app.schema';
import { updateAndroidAppSchema, type UpdateAndroidAppInput } from './dto/android-app.dto';

// =============================================================================
// TrustedAppsValidationPipe (issue #503)
// =============================================================================
//
// Validates the `PUT /api/admin/android-app` body. Used instead of the global
// `ZodValidationPipe` (the controller types the parameter with a plain type,
// not the Zod DTO class, so the global pipe passes it through untouched)
// because that pipe's 400 carries its issues in a top-level `errors` field,
// which `HttpExceptionFilter` drops. Here every 400 carries a machine-readable
// `details.reason` (docs/specs/android-media-sync.md §17.2) plus the issues
// under `details.issues`, the only place the filter's allowlist lets custom
// fields through.
// =============================================================================

/** When several problems are present, the reason reported is the first of these that applies. */
const REASON_PRIORITY: readonly TrustedAppsErrorReason[] = [
  TRUSTED_APPS_ERROR_REASONS.TOO_MANY_TRUSTED_APPS,
  TRUSTED_APPS_ERROR_REASONS.INVALID_PACKAGE_NAME,
  TRUSTED_APPS_ERROR_REASONS.INVALID_FINGERPRINT,
  TRUSTED_APPS_ERROR_REASONS.INVALID_TRUSTED_APPS,
];

/** Maps one Zod issue onto the spec's reason vocabulary. */
export function reasonForIssue(issue: z.core.$ZodIssue): TrustedAppsErrorReason {
  const [root, index, field] = issue.path;
  if (root === 'trustedApps' && issue.path.length === 1 && issue.code === 'too_big') {
    return TRUSTED_APPS_ERROR_REASONS.TOO_MANY_TRUSTED_APPS;
  }
  if (root === 'trustedApps' && typeof index === 'number') {
    if (field === 'packageName') return TRUSTED_APPS_ERROR_REASONS.INVALID_PACKAGE_NAME;
    if (field === 'sha256') return TRUSTED_APPS_ERROR_REASONS.INVALID_FINGERPRINT;
  }
  return TRUSTED_APPS_ERROR_REASONS.INVALID_TRUSTED_APPS;
}

@Injectable()
export class TrustedAppsValidationPipe implements PipeTransform<unknown, UpdateAndroidAppInput> {
  transform(value: unknown): UpdateAndroidAppInput {
    // Fastify leaves a body-less request's body `undefined`; parse it as `{}`
    // so it fails as "trustedApps is required", not as an unexpected type.
    const parsed = updateAndroidAppSchema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;

    const reasons = new Set(parsed.error.issues.map(reasonForIssue));
    const reason = REASON_PRIORITY.find((candidate) => reasons.has(candidate))!;

    throw new BadRequestException({
      message: 'Invalid trusted Android apps',
      details: {
        reason,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          reason: reasonForIssue(issue),
          message: issue.message,
        })),
      },
    });
  }
}
