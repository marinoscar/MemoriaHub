import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

import { INVALID_TRUSTED_APPS_REASON } from './android-app.schema';
import { updateAndroidAppSchema, type UpdateAndroidAppInput } from './dto/android-app.dto';

// =============================================================================
// TrustedAppsValidationPipe (issue #503)
// =============================================================================
//
// Validates the `PUT /api/admin/android-app` body. Used instead of the global
// `ZodValidationPipe` (the controller types the parameter with a plain type,
// not the Zod DTO class, so the global pipe passes it through untouched)
// because that pipe's 400 carries its issues in a top-level `errors` field,
// which `HttpExceptionFilter` drops. Here every 400 carries
// `details.reason = 'invalid_trusted_apps'` plus the issues under `details`,
// the only place the filter's allowlist lets custom fields through.
// =============================================================================

@Injectable()
export class TrustedAppsValidationPipe implements PipeTransform<unknown, UpdateAndroidAppInput> {
  transform(value: unknown): UpdateAndroidAppInput {
    const parsed = updateAndroidAppSchema.safeParse(value ?? {});
    if (parsed.success) return parsed.data;

    throw new BadRequestException({
      message: 'Invalid trusted Android apps',
      details: {
        reason: INVALID_TRUSTED_APPS_REASON,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
}
