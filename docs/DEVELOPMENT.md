# Development Guide

This document provides essential information for developers working on this project, including setup instructions, common patterns, and important lessons learned from implementation.

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Development Setup](#development-setup)
3. [Working with NestJS + Fastify](#working-with-nestjs--fastify)
4. [Database Patterns](#database-patterns)
5. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
6. [Testing Guidelines](#testing-guidelines)
7. [Debugging Tips](#debugging-tips)

---

## Technology Stack

### Backend
- **Framework**: NestJS with **Fastify adapter** (NOT Express)
- **ORM**: Prisma with PostgreSQL
- **Authentication**: Passport.js (Google OAuth)
- **Validation**: Zod schemas with nestjs-zod
- **Documentation**: Swagger/OpenAPI

### Key Difference: Fastify vs Express

This application uses **Fastify** as the HTTP adapter, not Express. This has important implications for how you write controllers and work with request/response objects.

**Why Fastify?**
- Faster performance (2-3x faster than Express)
- Better TypeScript support
- Lower overhead
- Built-in schema validation support

---

## Development Setup

### Prerequisites
- Node.js 18+
- Docker Desktop
- PostgreSQL (via Docker)
- Google OAuth credentials (from Google Cloud Console)

### Initial Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repository-url>
   cd MemoriaHub
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cd infra/compose
   cp .env.example .env
   # Edit .env with your Google OAuth credentials and other settings
   ```

3. **Start development environment**
   ```bash
   cd infra/compose
   docker compose -f base.compose.yml -f dev.compose.yml up
   ```

4. **IMPORTANT: Run database seeds**

   Before your first login, you MUST seed the database with roles and permissions:

   ```bash
   # In a new terminal, exec into the API container
   docker compose exec api sh

   # Run the seed script
   cd /app/apps/api
   npx tsx prisma/seed.ts

   # Exit the container
   exit
   ```

   **Why this is critical:**
   - Seeds create the RBAC roles (admin, contributor, viewer)
   - Seeds create permissions (users:read, users:write, etc.)
   - Without seeds, user creation will fail with "Default role not found"
   - Seeds are idempotent - safe to run multiple times

5. **Access the application**
   - Frontend: http://localhost:3535
   - API: http://localhost:3535/api
   - Swagger: http://localhost:3535/api/docs

### First Login

The first user to login with the email matching `INITIAL_ADMIN_EMAIL` (from .env) will automatically be granted the **admin** role. All subsequent users get the **viewer** role by default.

---

## Working with NestJS + Fastify

### Critical Differences from Express

#### 1. Response Methods

**❌ WRONG (Express-style):**
```typescript
@Get('example')
example(@Res() res: Response) {
  return res.status(200).json({ data: 'Hello' });
}
```

**✅ CORRECT (Fastify-style):**
```typescript
@Get('example')
example(@Res() res: FastifyReply) {
  return res.code(200).send({ data: 'Hello' });
}
```

**Key Differences:**
- Use `code()` instead of `status()`
- Use `send()` instead of `json()`
- Import types from `fastify` not `express`

**Best Practice:**
Most of the time, avoid using `@Res()` decorator directly. Let NestJS handle responses:

```typescript
@Get('example')
example() {
  // NestJS automatically serializes to JSON
  return { data: 'Hello' };
}
```

#### 2. Request Objects

**Type Imports:**
```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

// NOT from express:
// import { Request, Response } from 'express';
```

**Request Properties:**
```typescript
@Get('example')
example(@Req() req: FastifyRequest) {
  // Fastify uses req.body, req.params, req.query like Express
  // But some properties differ
  const ip = req.ip;           // Client IP
  const protocol = req.protocol; // http/https
  const hostname = req.hostname; // Host header
}
```

### Passport OAuth with Fastify

Passport strategies (like Google OAuth) are designed for Express and expect Express-style request/response objects. To work with Fastify, you need special handling.

#### The Problem

Passport OAuth guards expect to work with Node.js `IncomingMessage` and `ServerResponse` objects, but Fastify wraps these in its own request/response objects.

#### The Solution

Override `getRequest()` and `getResponse()` in your OAuth guard to return the raw Node.js objects:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // IMPORTANT: Copy user from raw request to Fastify request
    // so controllers can access req.user normally
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
```

**What this does:**
1. `getRequest()` returns `request.raw` - the underlying Node.js request object
2. `getResponse()` returns `response.raw` - the underlying Node.js response object
3. Passport performs OAuth using these raw objects
4. `handleRequest()` copies the authenticated user back to the Fastify request
5. Your controllers can now access `req.user` as normal

**Example in Controller:**
```typescript
@Get('google/callback')
@Public()
@UseGuards(GoogleOAuthGuard)
async googleAuthCallback(
  @Req() req: FastifyRequest & { user?: GoogleProfile },
  @Res() res: FastifyReply,
) {
  // Guard has set req.user for us
  const profile = req.user;

  // Use Fastify methods for response
  return res.redirect(302, redirectUrl.toString());
}
```

### Cookies with Fastify

Fastify uses `@fastify/cookie` plugin for cookie handling.

**Set Cookie:**
```typescript
res.setCookie('name', 'value', {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60 * 1000, // milliseconds
});
```

**Read Cookie:**
```typescript
const value = req.cookies['name'];
```

**Clear Cookie:**
```typescript
res.clearCookie('name', { path: '/api/auth' });
```

---

## Database Patterns

### Prisma Transactions

When creating related records (e.g., user with roles), always use transactions to maintain data consistency.

#### Why Transactions Matter

Without transactions, you can encounter foreign key violations:

**❌ WRONG (No Transaction):**
```typescript
// This can fail if user creation succeeds but role assignment fails
const user = await prisma.user.create({
  data: { email, displayName }
});

await prisma.userRole.create({
  data: {
    userId: user.id,
    roleId: defaultRole.id, // FK violation if role doesn't exist
  }
});
```

**✅ CORRECT (With Transaction):**
```typescript
const user = await prisma.$transaction(async (tx) => {
  const newUser = await tx.user.create({
    data: {
      email,
      displayName,
      userRoles: {
        create: {
          roleId: defaultRole.id,
        },
      },
      userSettings: {
        create: {
          value: DEFAULT_USER_SETTINGS,
        },
      },
    },
    include: {
      userRoles: {
        include: { role: true },
      },
    },
  });

  return newUser;
});
```

**Benefits:**
- All-or-nothing: Either all records are created or none
- No orphaned records
- No foreign key violations
- Consistent database state

### Nested Creates

Prisma supports nested creates which are automatically wrapped in transactions:

```typescript
const user = await prisma.user.create({
  data: {
    email: 'user@example.com',
    // Create related records in the same operation
    identities: {
      create: {
        provider: 'google',
        providerSubject: 'google-id-123',
        providerEmail: 'user@example.com',
      },
    },
    userRoles: {
      create: {
        roleId: roleId,
      },
    },
    userSettings: {
      create: {
        value: { theme: 'light' },
      },
    },
  },
  include: {
    identities: true,
    userRoles: { include: { role: true } },
    userSettings: true,
  },
});
```

### Seeding the Database

The seed script (`apps/api/prisma/seed.ts`) is idempotent and safe to run multiple times.

**Running Seeds:**

**In Docker:**
```bash
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
```

**Locally:**
```bash
cd apps/api
npx tsx prisma/seed.ts
```

**What Gets Seeded:**
- RBAC roles (admin, contributor, viewer)
- RBAC permissions (users:read, users:write, system_settings:read, circles:read, circles:write, circles:manage_any, etc.)
- Role-permission assignments (Admin gets all permissions; Contributor and Viewer both get circles:read + circles:write)
- Default system settings

**When to Run Seeds:**
- Before first login
- After database reset
- After pulling schema changes that add new roles/permissions
- In CI/CD before running tests

---

## Common Pitfalls and Solutions

### 1. "Default role not found" Error

**Symptom:** First OAuth login fails with database error.

**Cause:** Database hasn't been seeded with RBAC roles.

**Solution:**
```bash
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
exit
```

### 2. Passport OAuth Not Working with Fastify

**Symptom:** OAuth redirect fails, or user object is undefined in callback.

**Cause:** Passport expects Express-style request/response objects.

**Solution:** Use the guard pattern shown above with `getRequest()`, `getResponse()`, and `handleRequest()` overrides to return raw Node.js objects and copy user back to Fastify request.

### 3. Response Method Not Working

**Symptom:** `res.status(200).json()` throws an error.

**Cause:** Using Express-style methods with Fastify adapter.

**Solution:** Use Fastify methods: `res.code(200).send()` or let NestJS handle the response.

### 4. Foreign Key Violation on User Creation

**Symptom:** User creation fails with FK constraint error.

**Cause:** Not using transaction when creating user with roles.

**Solution:** Wrap in `prisma.$transaction()` or use nested creates.

### 5. Error Messages in Redirect URLs

**Symptom:** Redirect fails or displays malformed error message.

**Cause:** Error messages contain newlines or special characters not safe for URLs.

**Solution:** Sanitize error messages before adding to URL:
```typescript
const errorMessage = error instanceof Error
  ? encodeURIComponent(error.message.replace(/[\r\n]/g, ' ').substring(0, 100))
  : 'authentication_failed';
return res.redirect(`${appUrl}/auth/callback?error=${errorMessage}`);
```

---

## Testing Guidelines

### Running Tests

**Backend Tests:**
```bash
cd apps/api
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:cov        # With coverage
npm run test:e2e        # E2E tests only
```

**Frontend Tests:**
```bash
cd apps/web
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage
```

### Test Database

Backend tests use a separate test database. Configure in `apps/api/.env.test`:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/app_test"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```

**Important:** The test database is truncated between test runs. Never point tests at your development database.

### Mocking OAuth in Tests

OAuth strategies are mocked in tests to avoid external dependencies:

```typescript
import { MockGoogleStrategy } from '../../test/mocks/google-oauth.mock';

// Set custom profile for test
MockGoogleStrategy.setMockProfile({
  email: 'test@example.com',
  displayName: 'Test User',
});

// Perform OAuth test
const response = await request(app.getHttpServer())
  .get('/api/auth/google/callback')
  .expect(302);
```

---

## Debugging Tips

### Debugging OAuth Flow

1. **Check Environment Variables:**
   ```bash
   echo $GOOGLE_CLIENT_ID
   echo $GOOGLE_CLIENT_SECRET
   echo $GOOGLE_CALLBACK_URL
   ```

2. **Verify Callback URL:**
   - Must match exactly in Google Cloud Console
   - Include protocol: `http://` or `https://`
   - Include port if not 80/443: `http://localhost:3535/api/auth/google/callback`

3. **Check Container Logs:**
   ```bash
   docker compose logs api -f
   ```

4. **Test OAuth Provider Endpoint:**
   ```bash
   curl http://localhost:3535/api/auth/providers
   ```

### Debugging Database Issues

1. **Check Prisma Connection:**
   ```bash
   cd apps/api
   npx prisma db push --preview-feature
   ```

2. **Inspect Database:**
   ```bash
   docker compose exec db psql -U postgres -d appdb
   \dt              # List tables
   SELECT * FROM roles;
   SELECT * FROM permissions;
   ```

3. **View Prisma Logs:**
   Set `LOG_LEVEL=debug` in `.env` to see SQL queries.

### Common Log Messages

**"Database connected"**
✅ Prisma successfully connected to PostgreSQL

**"User logged out: user@example.com"**
✅ Logout successful

**"Refresh token reuse detected for user: xxx"**
⚠️ Security alert: Possible token theft

**"Default role not found - run database seeds"**
❌ Database not seeded - run `npx tsx prisma/seed.ts`

---

## Development Workflow

### Making Database Changes

1. **Update the schema fragment** (the schema is split into fragments and composed; never hand-edit `prisma/schema/`, it is GENERATED):
   ```bash
   cd apps/api
   # Edit the owning fragment in prisma/fragments/*.prisma
   npm run db:compose            # regenerates prisma/schema/ (CI runs db:compose:check)
   ```
   Models a platform slice will replace live in `prisma/fragments/platform-*.legacy.prisma` (header `PLATFORM-ADOPTION-SHIM`); everything else is grouped by domain (`media.prisma`, `face.prisma`, ...). Parentheses inside a field type such as `Unsupported("vector(128)")` are written `\u0028`/`\u0029` because the composer's field reader stops a type at the first `)`; Prisma decodes them.

2. **Create Migration:**
   ```bash
   # Using npm script (recommended - handles environment variables)
   npm run prisma:migrate:dev -- --name descriptive_name

   # Or in Docker container
   docker compose exec api npm run prisma:migrate:dev -- --name descriptive_name
   ```

3. **Generate Prisma Client:**
   ```bash
   # Using npm script (recommended)
   npm run prisma:generate

   # Or in Docker container
   docker compose exec api npm run prisma:generate
   ```

4. **Update Seeds (if needed):**
   ```bash
   # Edit prisma/seed.ts
   npx tsx prisma/seed.ts
   ```

**Note:** The project uses individual database environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, etc.) instead of a single `DATABASE_URL`. The npm scripts (`prisma:*`) automatically construct the connection URL from these variables. See `apps/api/scripts/README.md` for details.

### Platform packages

The seven `@marinoscar/platform-*` packages are pinned to one exact prerelease version (npm `next`, never `latest`). Three checks keep that true, and CI runs them: `npm run check:platform-pin` (one exact version everywhere, lockfile and `overrides` agree), `npm run check:single-instance` (libraries with module-level state, such as Nest, React, MUI, Zod and OpenTelemetry, resolve to a single copy) and `npm run check:platform-imports` (no deep imports into platform internals). Never edit platform code here; see [platform-adoption](platform-adoption/README.md#platform-pin) for how to bump the pin.

### Adding New API Endpoints

1. Create DTO with Zod schema
2. Add controller method with guards
3. Implement service method with business logic
4. Add Swagger decorators for documentation
5. Write tests (unit + integration)
6. Update API.md documentation

### Adding New Guards

1. Create guard in `apps/api/src/auth/guards/`
2. Implement `canActivate()` method
3. Register in module if not global
4. Add tests for guard logic
5. Document usage in SECURITY.md

---

## Performance Considerations

### Fastify Performance Tips

1. **Avoid `@Res()` decorator when possible** - Let NestJS handle serialization
2. **Use schema validation** - Fastify's built-in validation is faster than runtime checks
3. **Enable compression** - Use `@fastify/compress` for large responses
4. **Connection pooling** - Prisma handles this automatically

### Database Query Optimization

1. **Use `select` to limit fields:**
   ```typescript
   const user = await prisma.user.findUnique({
     where: { id },
     select: { id: true, email: true, displayName: true },
   });
   ```

2. **Use `include` judiciously:**
   ```typescript
   // Only include what you need
   include: {
     userRoles: {
       include: { role: true }, // Avoid deep nesting
     },
   }
   ```

3. **Index frequently queried fields** - Already done in schema for email, provider combinations

---

## Family Circles Development Patterns

### Two-Layer Authorization

Every circle-scoped operation requires two authorization checks:

1. **Global permission** (system RBAC guard) — the endpoint declares `permissions: [PERMISSIONS.CIRCLES_READ]` or `PERMISSIONS.CIRCLES_WRITE`. This gates access at the route level.
2. **Per-circle role** (CircleMembershipService) — inside the service, call `assertCircleAccess(userId, circleId, minRole)` to verify the caller holds at least the required per-circle role.

```typescript
// Example service method pattern
async updateCircle(userId: string, circleId: string, dto: UpdateCircleDto) {
  // Verify caller is circle_admin (or super-admin) in this circle
  await this.membershipService.assertCircleAccess(
    userId,
    circleId,
    CircleRole.circle_admin,
  );
  return this.prisma.circle.update({ where: { id: circleId }, data: dto });
}
```

**Super-admin bypass:** `assertCircleAccess` skips the per-circle check if the caller holds `circles:manage_any`, `media:write_any`, or `media:read_any`. You do not need to handle this case yourself.

### Personal Circle Creation (User Signup)

When provisioning a new user in `AuthService.findOrCreateUser()`, the transaction must also:
1. Create a `circles` row with `isPersonal: true` and `ownerId = user.id`.
2. Create a `circle_members` row for that user at `circle_admin`.
3. Call `CircleInviteService.claimPendingInvites(user.email, user.id)` to accept any circle invites that arrived before the user registered.

This chain must be inside the same Prisma transaction as user creation to avoid orphaned records.

### Invite Flow

Sending an invite (`POST /api/circles/:id/invites`) does two things atomically:
1. Upserts the email into `allowed_emails` (so the invitee can log in even if not otherwise allowlisted).
2. Creates a `circle_invites` row with `claimedById = null`.

On login, `claimPendingInvites` scans `circle_invites` for unclaimed rows matching the user's email, creates the `circle_members` rows, and marks the invites as claimed.

### Working with circleId in Media Endpoints

All media, album, and tag operations are circle-scoped. The `circleId` must be provided by the caller (request body for mutations, query parameter for reads). The server verifies membership before reading or writing.

Deduplication for `MediaItem` uses a unique index on `(circle_id, content_hash)`. A pre-upload dedup check (`GET /api/media?circleId=<id>&contentHash=<hash>`) must include `circleId` to scope the check to the correct circle.

### Adding New Circle Endpoints

Follow the same pattern as existing circle endpoints in `apps/api/src/circles/`:

1. Declare the endpoint in `circles.controller.ts` with `@Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })`.
2. Implement the service method in `circles.service.ts` or a focused sub-service.
3. Call `assertCircleAccess` with the minimum required per-circle role.
4. Write a unit test in `circles.service.spec.ts` and an E2E test in `test/circles.e2e.spec.ts`.

---

## Observability (telemetry)

The API boots OpenTelemetry through the platform's `initializeOtel` (`apps/api/src/instrumentation.ts`, imported first by `main.ts`). The service name is `memoriahub-api` (`OTEL_SERVICE_NAME` overrides it; see `apps/api/src/common/otel/telemetry-identity.ts`). Nothing is exported unless `OTEL_ENABLED=true`. HTTP server spans carry `http.route` and `app.route.matched` (`registerRequestSpanAttributes`), `@Trace` comes from `@marinoscar/platform-api/otel-core`, and `OtelMetricsModule` hosts metrics.

Telemetry is stored in GreptimeDB through the generated collector; the Uptrace/ClickHouse stack is retired and historical data was not migrated (operators who need it export it, then remove the old `uptrace-data`, `clickhouse-data` and `uptrace-pg-data` volumes by hand).

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f telemetry.compose.yml up
# GreptimeDB explorer: http://localhost:14000/dashboard
```

Set the `GREPTIME_*` writer and reader passwords in `.env` (never commit them). Details: the platform telemetry runbook and `docs/specs/telemetry.md` in EnterpriseAppBase.

### Turn telemetry on (RETRO-T2, #625)

The API side is the platform telemetry slice (`@marinoscar/platform-api/telemetry`, mounted once by `apps/api/src/platform/telemetry/telemetry.config.ts`), and the pages are `@marinoscar/platform-web/telemetry/ui`. The SDK's export gate starts **closed**: nothing leaves the API until an administrator switches telemetry on, even with `OTEL_ENABLED=true`. The gate opens when the `telemetry.enabled` system setting is on **and** a GreptimeDB store is configured, and it follows the setting at runtime (no restart; other instances converge within the refresh interval).

1. Run the telemetry stack (above) and set `OTEL_ENABLED=true` plus the `GREPTIME_*` passwords in `.env`. `GREPTIME_HOST`, `GREPTIME_PG_PORT`, `GREPTIME_DB` and the reader and admin logins are only the **deployment default** connection.
2. Sign in as an administrator and open **Settings → Operations → Telemetry** (`/admin/settings/telemetry`, `telemetry:read`; saving needs `telemetry:write`). Optionally save a GreptimeDB connection there: it replaces the `GREPTIME_*` default wholly, its passwords are stored encrypted under the credential purpose `telemetry_greptime` and are never returned.
3. Switch collection on and choose the retention (days). The retention is applied by the server-only job `telemetry.retention.apply` (visible on the Job Queue page).
4. **Telemetry Explorer** (`/admin/settings/telemetry/explorer`) runs read-only SQL (`SELECT 1` is a quick check) and exports results; **Telemetry Dashboard** (`/admin/settings/telemetry/dashboard`) shows the health verdict and the metric groups. Both need `telemetry:query` and appear only while telemetry is on. The AI assistant shows "AI disabled" until RETRO-E4.
5. The Doctor (`/admin/settings/doctor`) has a Telemetry section: `telemetry.export`, `telemetry.connection`, `telemetry.reachable`, `telemetry.tables`, `telemetry.freshness`.

**Upgrading a deployment that exported before the slice** (`OTEL_ENABLED=true`): the `telemetry` namespace defaults to off, so run `npm run settings:migrate-telemetry --workspace=api` (dry run) and then with `-- --apply` to store `telemetry.enabled: true`. It writes only while the namespace is absent.

Operator detail (retention, the assistant, the connection from the UI): the telemetry runbook in EnterpriseAppBase, `docs/runbooks/telemetry.md` §4 (turn on), §5 (retention), §6 (assistant) and §9 (connection from the UI), and the slice README (`packages/platform-api/src/telemetry/README.md`).

## Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Fastify Documentation](https://www.fastify.io/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Passport.js Documentation](http://www.passportjs.org/)
- [Project SECURITY-ARCHITECTURE.md](./SECURITY-ARCHITECTURE.md)
- [Project TESTING.md](./TESTING.md)

---

## Getting Help

If you encounter issues:

1. Check this guide for common pitfalls
2. Review container logs: `docker compose logs api -f`
3. Verify database seeds have run
4. Check environment variables are set correctly
5. Consult the specification docs in `docs/specs/`
6. Ask the team in Slack/Teams

## Summary

Key takeaways for developers:

- ✅ **Use Fastify methods**: `code()` and `send()`, not `status()` and `json()`
- ✅ **Seed before first login**: `npx tsx prisma/seed.ts` in the API container
- ✅ **Use transactions**: Wrap related creates in `prisma.$transaction()`
- ✅ **Return raw objects for OAuth**: Override guard methods for Passport compatibility
- ✅ **Sanitize redirect URLs**: Encode and remove newlines from error messages

Following these patterns will help you avoid the most common issues and maintain consistency with the existing codebase.

## Adding a setting

Every system and user settings namespace is declared once (RETRO-B3, #614); there is no wire DTO and no hand-written merge to keep in step.

- **A field in an existing namespace**: edit `apps/api/src/settings/registry/namespaces/system/<ns>.ts` (or `user/<ns>.ts`): the zod shape with its bounds and the defaults. The PATCH/PUT bodies, the response, the field-by-field merge and the salvage of a stored document that lacks the field are derived.
- **A new system namespace**: a new file there, `defineSystemNamespace({ key, description, schema, defaults })` (add `keepOnNull` paths only if an explicit `null` must keep the stored value), appended to `APP_SYSTEM_SETTINGS_NAMESPACES` in `apps/api/src/app-registrations/settings.ts`, and its type to the `declare module '@marinoscar/platform-api/settings'` block in the same file. Do NOT augment a key a platform slice declares (`ai`, `storage`, `notifications`, `databaseBackup`, `email`, `jobs`): add it to `settings/app-settings.types.ts` instead (TS2717 otherwise).
- **A new user namespace**: a `UserSettingsNamespace` (`schema`, `patchSchema`, `merge`), never `.default()`: absent means "no preference". `null` in a PATCH clears; return `undefined` from `merge` to store nothing.
- **Reading**: `SystemSettingsService.getSettings()` (cached 5 s, write drops it) or `getNamespace('key')`; a Doctor check uses `readKnownValue()` (never creates the row).
- **Secrets**: the registry refuses a field named `password`, `secret`, `apiKey`, `token`, `privateKey`, ... Store it with the credential store (RETRO-B4); until then see `email/email-smtp-secret.store.ts`.
- **Check**: `npx jest --config ./test/jest.config.js test/settings`; and `npm run settings:verify --workspace=api` on a restored backup (reports stored values the schemas would not accept).
