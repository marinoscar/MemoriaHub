import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Sanitizes a device-flow `returnUri`.
 *
 * Only the following schemes are accepted:
 * - `memoriahub:` — custom Android/iOS deep-link scheme
 * - `https:`       — standard secure web URL
 *
 * Anything else (http, javascript, data, etc.) is rejected and null is returned.
 * The value is also capped at 512 characters before the scheme check.
 *
 * @returns The original URI string if accepted, or null if rejected/absent.
 */
export function sanitizeReturnUri(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.length > 512) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('memoriahub:')) return value;
  if (lower.startsWith('https:')) return value;
  return null;
}

/**
 * Client info schema for device authorization requests
 */
export const ClientInfoSchema = z.object({
  deviceName: z.string().optional(),
  userAgent: z.string().optional(),
  /**
   * Optional deep-link URI the web activation page uses to redirect the user
   * back into the requesting app after approval.
   * Accepted schemes: `memoriahub:` or `https:`.
   */
  returnUri: z
    .string()
    .max(512)
    .optional()
    .refine(
      (v) => v === undefined || sanitizeReturnUri(v) !== null,
      { message: 'returnUri must use the memoriahub: or https: scheme' },
    ),
});

/**
 * Request DTO for initiating device authorization flow
 */
export const DeviceCodeRequestSchema = z.object({
  clientInfo: ClientInfoSchema.optional(),
});

export class DeviceCodeRequestDto extends createZodDto(DeviceCodeRequestSchema) {
  @ApiProperty({
    description: 'Optional client information',
    required: false,
  })
  clientInfo?: {
    deviceName?: string;
    userAgent?: string;
    /**
     * Deep-link URI to redirect the user back to the requesting app after approval.
     * Accepted schemes: `memoriahub:` (custom app scheme) or `https:`.
     * Maximum 512 characters.
     */
    returnUri?: string;
  };
}
