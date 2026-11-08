// =============================================================================
// MemoriaHub's own notification preference (RETRO-D3, #576)
// =============================================================================
//
// The platform owns every per-event, per-channel preference (the `notifications`
// user namespace). One MemoriaHub preference has no platform equivalent:
// `workflowMicroRuns` (epic #240, issue #251), the opt-IN that re-enables the
// rolling `on_media_enriched` workflow micro-run notifications. It lives in the
// app user namespace `memoriahubNotifications` (registered in
// `src/settings/registry/namespaces/user/memoriahub-notifications.ts`), and
// ABSENT MEANS FALSE: the inverted default of the pre-platform namespace.
// =============================================================================

import type { PrismaService } from '../prisma/prisma.service';

/** The app user namespace holding MemoriaHub-only notification preferences. */
export const MEMORIAHUB_NOTIFICATIONS_NAMESPACE = 'memoriahubNotifications';

/**
 * Whether the user opted into workflow micro-run notifications. Fails closed
 * (false): a failed read must not start notifying someone who never asked.
 */
export async function allowsWorkflowMicroRuns(prisma: PrismaService, userId: string): Promise<boolean> {
  try {
    const row = await prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const value = row?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const ns = (value as Record<string, unknown>)[MEMORIAHUB_NOTIFICATIONS_NAMESPACE];
    if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return false;
    return (ns as Record<string, unknown>)['workflowMicroRuns'] === true;
  } catch {
    return false;
  }
}
