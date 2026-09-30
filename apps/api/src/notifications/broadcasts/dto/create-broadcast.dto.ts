import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { BROADCAST_CHANNELS } from '../broadcast-constants';

export const BROADCAST_TITLE_MAX = 120;
export const BROADCAST_BODY_MAX = 2_000;
export const BROADCAST_CTA_LABEL_MAX = 40;
export const BROADCAST_LINK_MAX = 500;

/** Whitespace and control characters — never legitimate inside a path. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_LINK_CHARS = /[\u0000- \u007F]/;

/**
 * A ROOT-RELATIVE in-app path ("/memories"). Never absolute, never
 * protocol-relative ("//evil.test") or "/\\" (which browsers normalise to
 * "//"): a broadcast link reaches every user, so it must not be able to send
 * them off-site.
 */
const rootRelativeLink = z
  .string()
  .trim()
  .min(1, 'link must not be empty')
  .max(BROADCAST_LINK_MAX)
  .refine((v) => !FORBIDDEN_LINK_CHARS.test(v), {
    message: 'link must not contain spaces or control characters',
  })
  .refine((v) => v.startsWith('/'), { message: 'link must be root-relative and start with "/"' })
  .refine((v) => !v.startsWith('//'), { message: 'link must not be protocol-relative ("//…")' })
  .refine((v) => !v.startsWith('/\\'), { message: 'link must not start with "/\\"' });

/**
 * Body of POST /api/admin/broadcasts and POST /api/admin/broadcasts/test.
 *
 * `body` is PLAIN TEXT (no HTML/markdown is interpreted anywhere). The
 * notification type is derived from `critical`, never accepted.
 */
export const createBroadcastSchema = z
  .object({
    title: z.string().trim().min(1, 'title must not be empty').max(BROADCAST_TITLE_MAX),
    body: z.string().trim().min(1, 'body must not be empty').max(BROADCAST_BODY_MAX),
    link: rootRelativeLink.optional(),
    ctaLabel: z.string().trim().min(1).max(BROADCAST_CTA_LABEL_MAX).optional(),
    channels: z
      .array(z.enum(BROADCAST_CHANNELS))
      .min(1, 'select at least one channel')
      .refine((v) => new Set(v).size === v.length, { message: 'channels must not contain duplicates' }),
    /** ISO 8601 with offset; must be in the future. Omit to send now. */
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .refine((v) => v.getTime() > Date.now(), { message: 'scheduledFor must be in the future' })
      .optional(),
    critical: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.ctaLabel && !value.link) {
      ctx.addIssue({ code: 'custom', path: ['ctaLabel'], message: 'ctaLabel requires link' });
    }
    if (value.critical && !value.channels.includes('inbox')) {
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message:
          'a critical broadcast must include the "inbox" channel: the in-app notification is the ' +
          'durable record every recipient can go back and read',
      });
    }
    if (value.channels.includes('push') && !value.channels.includes('inbox')) {
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message:
          'the "push" channel requires "inbox": a Web Push is dispatched from, and opens, the ' +
          'in-app notification',
      });
    }
  });

export class CreateBroadcastDto extends createZodDto(createBroadcastSchema) {}

/** Same shape as create; `scheduledFor` is ignored by a test send. */
export class TestBroadcastDto extends createZodDto(createBroadcastSchema) {}

export type CreateBroadcastInput = z.output<typeof createBroadcastSchema>;
