// =============================================================================
// The webhooks slice's host port (RETRO-H4, #603)
// =============================================================================
//
//   WEBHOOKS_SYSTEM_PRISMA  the bypass client. A system-scope endpoint (and its
//                           deliveries) has no organization, so row-level
//                           security shows it to the bypass client only.
//                           Reasons `webhooks` (every system-scope query and the
//                           delivery job's reads of them; registered by
//                           `WebhooksModule.forRoot`) and `retention` (the
//                           delivery purge across organizations, a platform
//                           built-in).
//
// The bypass rides `PrismaSystemService` (its own pool, RETRO-D1): every operation runs in a
// transaction whose FIRST statement is `set_config('app.rls_bypass', 'on', true)`
// (transaction-local, the platform's RLS contract). Same binding as the AI slice's
// `AI_SYSTEM_PRISMA` (`platform/ai/ai-host.module.ts`).
//
// PLATFORM_PRISMA, AUDIT_SINK, JobsService, the credential stores and the
// notifications come from the app's global modules and the slice's own imports.
// =============================================================================

import { Module } from '@nestjs/common';
import { WEBHOOKS_SYSTEM_PRISMA, type WebhooksSystemPrisma, type WebhooksTx } from '@marinoscar/platform-api/webhooks';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

/** The `WebhooksSystemPrisma` port over the system client. Exported for the tests. */
export function webhooksSystemPrisma(
  system: Pick<PrismaSystemService, 'asSystem' | 'runAsSystem'>,
): WebhooksSystemPrisma {
  return {
    asSystem: (reason) => system.asSystem(reason) as unknown as WebhooksTx,
    runAsSystem: (reason, fn, options) =>
      system.runAsSystem(reason, (tx) => fn(tx as unknown as WebhooksTx), options),
  };
}

@Module({
  providers: [
    {
      provide: WEBHOOKS_SYSTEM_PRISMA,
      inject: [PrismaSystemService],
      useFactory: webhooksSystemPrisma,
    },
  ],
  exports: [WEBHOOKS_SYSTEM_PRISMA],
})
export class WebhooksHostModule {}
