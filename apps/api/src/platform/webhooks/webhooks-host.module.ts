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
// MemoriaHub has no separate `PrismaSystemService` yet (it arrives with the
// storage slice, RETRO-D1), so the bypass rides the app's client through the
// platform's own `forSystem` / `runAsSystem`: every operation runs in a
// transaction whose FIRST statement is `set_config('app.rls_bypass', 'on', true)`
// (transaction-local, the platform's RLS contract). Same binding as the AI
// slice's `AI_SYSTEM_PRISMA` (`platform/ai/ai-host.module.ts`).
// PLATFORM-ADOPTION-SHIM(RETRO-D1): bind `PrismaSystemService` once it exists.
//
// PLATFORM_PRISMA, AUDIT_SINK, JobsService, the credential stores and the
// notifications come from the app's global modules and the slice's own imports.
// =============================================================================

import { Module } from '@nestjs/common';
import { forSystem, runAsSystem } from '@marinoscar/platform-api/core';
import { WEBHOOKS_SYSTEM_PRISMA, type WebhooksSystemPrisma, type WebhooksTx } from '@marinoscar/platform-api/webhooks';

import { PrismaService } from '../../prisma/prisma.service';

/** The `WebhooksSystemPrisma` port over the app's client. Exported for the tests. */
export function webhooksSystemPrisma(prisma: PrismaService): WebhooksSystemPrisma {
  return {
    asSystem: (reason) => forSystem(prisma, reason) as unknown as WebhooksTx,
    runAsSystem: (reason, fn, options) =>
      runAsSystem(prisma, reason, (tx) => fn(tx as unknown as WebhooksTx), options),
  };
}

@Module({
  providers: [
    {
      provide: WEBHOOKS_SYSTEM_PRISMA,
      inject: [PrismaService],
      useFactory: webhooksSystemPrisma,
    },
  ],
  exports: [WEBHOOKS_SYSTEM_PRISMA],
})
export class WebhooksHostModule {}
