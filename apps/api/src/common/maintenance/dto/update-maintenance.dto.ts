import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Body of `PUT /api/admin/maintenance` (issue #348).
 *
 * `enabled` is required — this endpoint is an explicit toggle, never a
 * partial patch. `message` and `allowAdmins` are optional; when omitted on an
 * enable they keep their persisted values (and `allowAdmins` falls back to
 * its schema default of `true`, the safe direction).
 */
export const updateMaintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(500).optional(),
  allowAdmins: z.boolean().optional(),
});

export class UpdateMaintenanceDto extends createZodDto(updateMaintenanceSchema) {}
