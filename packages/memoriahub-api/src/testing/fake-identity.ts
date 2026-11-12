import type { ExecutionContext } from '@nestjs/common';

import type { MemoriahubIdentityPort, MemoriahubPrincipal } from '../ports/index.js';

/**
 * The request property the fake reads a principal from.
 *
 * @stability experimental
 */
export const FAKE_PRINCIPAL_KEY = '__memoriahubFakePrincipal';

/**
 * A fake `MEMORIAHUB_IDENTITY`: a request carries its principal under {@link FAKE_PRINCIPAL_KEY}; a
 * request without one is anonymous. Users and their permissions are registered with `addUser`.
 *
 * @stability experimental
 */
export class FakeMemoriahubIdentity implements MemoriahubIdentityPort {
  private readonly users = new Map<string, MemoriahubPrincipal>();

  /**
   * Registers a user.
   *
   * @param principal - the user and what they may do.
   */
  addUser(principal: MemoriahubPrincipal): void {
    this.users.set(principal.userId, principal);
  }

  /**
   * An execution context whose request carries a user (or nobody).
   *
   * @param userId - the user, or `null` for an anonymous request.
   */
  contextFor(userId: string | null): ExecutionContext {
    const request: Record<string, unknown> = {};
    if (userId !== null) request[FAKE_PRINCIPAL_KEY] = userId;
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  }

  /** Authenticates a request. */
  async authenticate(context: ExecutionContext): Promise<MemoriahubPrincipal | null> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const userId = request[FAKE_PRINCIPAL_KEY];
    return typeof userId === 'string' ? (this.users.get(userId) ?? null) : null;
  }

  /** Permission check. */
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    return this.users.get(userId)?.permissions.has(permission) ?? false;
  }

  /** Permissions of a user. */
  async permissionsOf(userId: string): Promise<readonly string[]> {
    return [...(this.users.get(userId)?.permissions ?? [])];
  }

  /** Ids of the registered users holding the `admin` role. */
  async adminUserIds(): Promise<readonly string[]> {
    return [...this.users.values()].filter((u) => u.roles.includes('admin')).map((u) => u.userId);
  }
}
