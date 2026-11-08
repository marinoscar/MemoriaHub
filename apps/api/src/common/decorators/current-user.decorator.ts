import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  toRequestUser,
  type AuthenticatedUser,
  type RequestUser,
} from '@marinoscar/platform-api/identity';

// =============================================================================
// @CurrentUser(): the caller as a RequestUser, on EVERY authenticated route
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(seam request, EnterpriseAppBase: `@CurrentUser()` on a
// bare `@Auth()` route): the identity slice's `CurrentUser` returns
// `request.requestUser || request.user`, and `requestUser` is attached only by
// `RolesGuard` / `PermissionsGuard` when a role or permission check actually ran.
// On a route that declares neither (a bare `@Auth()`), the decorator hands back
// the RAW `AuthenticatedUser` graph, which has no `permissions` field. MemoriaHub
// passes that object, typed `RequestUser`, to services that read
// `user.permissions` (circle access, person linking): this is exactly the defect
// of issue #406 (`PATCH /api/users/me/profile` answering 404 for every link),
// fixed in the app's old guards and regressed by the packaged ones.
//
// This decorator derives the RequestUser from the graph with the platform's own
// `toRequestUser` when no guard attached one, so the value is always complete.
// It is the only `CurrentUser` the app imports. Removed when the seam ships.

/** A graph (has `userRoles`) is derived; an object that already is a RequestUser passes through. */
function asRequestUser(user: AuthenticatedUser | RequestUser): RequestUser {
  return 'userRoles' in user ? toRequestUser(user) : user;
}

type RequestWithUser = { requestUser?: RequestUser; user?: AuthenticatedUser | RequestUser };

/** `@CurrentUser()` -> the RequestUser; `@CurrentUser('id')` -> one field of it. */
export const CurrentUser = createParamDecorator((field: keyof RequestUser | undefined, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<RequestWithUser>();
  const user = request.requestUser ?? (request.user ? asRequestUser(request.user) : undefined);
  return field ? user?.[field] : user;
});
