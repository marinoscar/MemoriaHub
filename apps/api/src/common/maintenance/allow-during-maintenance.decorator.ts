import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for routes exempt from the maintenance-mode block.
 */
export const ALLOW_DURING_MAINTENANCE_KEY = 'allowDuringMaintenance';

/**
 * Decorator marking a route (or an entire controller) as reachable while
 * maintenance mode is active — LOCKOUT SAFEGUARD #1 of three (issue #348).
 *
 * If maintenance mode 503'd literally everything, the admin could not turn it
 * off again. Exactly three categories of route carry this decorator:
 *
 *  1. Health probes — `GET /api/health/live` (must stay 200 so nothing kills
 *     the container) and `GET /api/health/ready` (must report NOT ready so
 *     load balancers drain it).
 *  2. The auth routes needed to sign in: `/api/auth/providers`,
 *     `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/refresh`,
 *     `/api/auth/me` — an admin who is not already logged in has to be able
 *     to log in before they can reach the toggle.
 *  3. The maintenance endpoints themselves (`/api/admin/maintenance`) — the
 *     off switch. See the regression test in maintenance.guard.spec.ts.
 *
 * This mirrors the shape of `@Public()`
 * (`apps/api/src/auth/decorators/public.decorator.ts`). Note the two are
 * ORTHOGONAL: `@Public()` skips authentication, `@AllowDuringMaintenance()`
 * skips the maintenance block. A route may carry either, both, or neither.
 *
 * @example
 * ```typescript
 * @AllowDuringMaintenance()
 * @Get('live')
 * liveness() {
 *   return { status: 'ok' };
 * }
 * ```
 */
export const AllowDuringMaintenance = () =>
  SetMetadata(ALLOW_DURING_MAINTENANCE_KEY, true);
