# Runbook: Admin-Controlled Maintenance Mode

Issue: [#348](https://github.com/marinoscar/MemoriaHub/issues/348)
Code: `apps/api/src/common/maintenance/` (`maintenance-mode.service.ts`, `maintenance.guard.ts`, `allow-during-maintenance.decorator.ts`, `maintenance.controller.ts`), `apps/api/src/health/health.controller.ts`

## 1. What maintenance mode does

When maintenance mode is active, `MaintenanceGuard` (a global `APP_GUARD`) intercepts every incoming HTTP request **before** route-level auth guards run. For any route not explicitly exempted, it:

- Returns **HTTP 503** with a stable JSON body:
  ```json
  {
    "error": "maintenance",
    "message": "Upgrading to v2.4, back by 03:00 UTC",
    "startedAt": "2026-08-09T14:00:00.000Z"
  }
  ```
  The `"error": "maintenance"` field (`MAINTENANCE_ERROR_MARKER` in `maintenance.guard.ts`) is the stable marker the web frontend keys off of to render the maintenance screen instead of a generic error page. Do not change this string without updating `apps/web` in the same change.
- Sets a `Retry-After: 120` header on the response (`MAINTENANCE_RETRY_AFTER_SECONDS`).

Two health endpoints behave differently by design, so orchestration keeps working through the window:

- `GET /api/health/live` **stays 200** even during maintenance. If it 503'd, an orchestrator (Docker healthcheck, Kubernetes liveness probe) would decide the process is hung and kill the container mid-upgrade — the opposite of what you want.
- `GET /api/health/ready` **reports not-ready** (503, with a maintenance-specific body) while maintenance is active — checked *before* the database probe, so it still answers correctly even during the issue #344 database-rename window when the DB is briefly unreachable. This is what makes a load balancer or orchestrator drain traffic away from the instance.

Both health routes are always reachable (`@AllowDuringMaintenance()`); the difference is what each one *reports*.

## 2. The two-layer state model, and why it exists

Maintenance state resolves through up to three layers, checked in this order (`MaintenanceModeService.isActive()` / `getState()`):

```
effective state = MAINTENANCE_MODE env override
                   ?? in-memory (process-local) override
                   ?? persisted system_settings.maintenance.enabled
```

**Persisted (`system_settings.maintenance.*`) is the primary layer**, and it is non-negotiable for the planned-upgrade use case this feature exists for. If maintenance state lived only in memory, enabling it, then restarting the container to deploy/migrate, would silently clear the flag — the app comes back up serving live traffic mid-migration, which is exactly the failure this feature is supposed to prevent. Because it's a system setting, it also means an admin toggling maintenance ON is a normal, auditable API call (see §6), not a config file edit that needs a deploy of its own.

**The in-memory override exists for a narrower, unrelated reason:** issue #344's database restore/rename cutover. During that swap, the database the persisted flag lives in is briefly renamed out from under the running API process — for a few seconds there is no row to read and no row to write. A process-local boolean is the only layer that still works in that window: `MaintenanceModeService.enable()` sets the in-memory override *first*, synchronously, so the block takes effect even if the following persisted write fails or can't run at all. Once the swap window closes and the persisted setting is written successfully, the in-memory override is cleared (`clearInMemoryOverride()`) and the persisted value becomes authoritative again.

You will not normally set the in-memory layer directly — `PUT /api/admin/maintenance` manages both layers together in the correct order (see §6). It's documented here so you understand why `GET /api/admin/maintenance` shows `persistedEnabled`, `inMemoryOverride`, and `envOverride` as separate fields: they tell you exactly which layer is producing the effective `active` answer, which matters when the state looks "stuck."

## 3. Recommended app-upgrade sequence

Use this for a routine deploy that requires downtime (a migration, a breaking change, a maintenance window communicated to users).

1. **Enable maintenance**, as an Admin, with a clear message:
   ```bash
   curl -sS -X PUT https://<your-domain>/api/admin/maintenance \
     -H "Authorization: Bearer <ADMIN_JWT>" \
     -H "Content-Type: application/json" \
     -d '{
       "enabled": true,
       "message": "Upgrading to v2.4, back by 03:00 UTC",
       "allowAdmins": true
     }'
   ```
   `allowAdmins: true` is the default and lets you keep working through the window (see the safeguard in §4 — do not set this to `false` unless you have already read that section).

2. **Verify the banner** — open the app in a browser as a non-admin user (or an incognito window) and confirm the maintenance screen renders. You can also check from the command line:
   ```bash
   curl -i https://<your-domain>/api/media
   # Expect: HTTP/1.1 503, header "Retry-After: 120", body {"error":"maintenance",...}
   ```

3. **Deploy / migrate.** Restart containers, run `npx prisma migrate deploy`, whatever the release needs. The persisted flag survives the restart — that's the entire point of the two-layer model in §2.

4. **Verify as an admin** with `allowAdmins: true` still in effect — log in (or reuse your existing session) and confirm the upgraded app actually works: pages load, the new feature/fix is present, no new errors in logs. Because `allowAdmins` defaults to true, your admin session bypasses the 503 automatically; nothing extra to configure here.

5. **Disable maintenance:**
   ```bash
   curl -sS -X PUT https://<your-domain>/api/admin/maintenance \
     -H "Authorization: Bearer <ADMIN_JWT>" \
     -H "Content-Type: application/json" \
     -d '{"enabled": false}'
   ```
   This persists `enabled: false` and clears the in-memory override, restoring normal traffic.

Check the resulting state at any point with:
```bash
curl -sS https://<your-domain>/api/admin/maintenance \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

## 4. The three lockout safeguards — and the one footgun

Because the guard runs globally, an admin-created lockout is a real risk this feature has to design against. Three safeguards exist:

1. **Exempt routes** (`@AllowDuringMaintenance()`), always reachable regardless of maintenance state:
   - Health probes: `GET /api/health/live`, `GET /api/health/ready` (see §1).
   - Sign-in routes: `GET /api/auth/providers`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/me`, `POST /api/auth/refresh` — an admin who isn't already logged in must still be able to sign in.
   - The maintenance endpoints themselves: `GET /api/admin/maintenance`, `PUT /api/admin/maintenance` — the off switch is always reachable. A regression test in `maintenance.guard.spec.ts` asserts this.

2. **The `allowAdmins` bypass** (default `true`): while maintenance is active, a request carrying a valid JWT whose `roles` claim includes Admin is let through everything else too, so an admin can keep using the full app (not just the toggle endpoint) to verify a deploy.

3. **The `MAINTENANCE_MODE` env var** (see §5) — the actual break-glass recovery mechanism.

### The footgun: `allowAdmins: false`

Setting `allowAdmins: false` blocks **every** request from an Admin session that is not itself on the exempt-route list — which, in practice, means the **admin web UI becomes unusable**: the UI needs other, non-exempt API calls (settings, users, media, etc.) to render its pages, and those are all blocked the same as for any other user once `state.active && !state.allowAdmins`.

The maintenance endpoints (`GET`/`PUT /api/admin/maintenance`) themselves stay reachable — the whole `MaintenanceController` carries `@AllowDuringMaintenance()`, so `MaintenanceGuard` lets both routes through unconditionally, before it ever evaluates `allowAdmins`. So if you still have a valid Admin JWT and a way to make a raw HTTP call (`curl`, Postman, the Swagger UI's "Try it out" if you can even load `/api/docs`), you can fix this directly:
```bash
curl -sS -X PUT https://<your-domain>/api/admin/maintenance \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "allowAdmins": true}'
```
That is the fast path — it does not require a restart.

If you don't have a usable JWT, can't reach the API host to run `curl`, or the API itself is unreachable/unhealthy, fall back to the environment-variable break-glass, which requires no application-level credential at all — only server/deploy access:

```bash
# In your deployment's environment (infra/compose/.env, systemd EnvironmentFile,
# container orchestrator env config — wherever MAINTENANCE_MODE is set for the API):
MAINTENANCE_MODE=false
```
Then restart the API container/process so it picks up the new environment:
```bash
# docker compose example:
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d --force-recreate api
```

`MAINTENANCE_MODE` is read fresh on every request (`readEnvOverride()` in `maintenance-mode.service.ts`) and it **wins over the persisted setting in both directions**:
- `MAINTENANCE_MODE=true` forces maintenance ON at boot even if the database (and therefore the persisted flag) is unreadable.
- `MAINTENANCE_MODE=false` forces maintenance OFF regardless of what's persisted, including an `allowAdmins: false` state — this is the documented recovery path.

Once you're back in, either unset `MAINTENANCE_MODE` and restart again (to let the persisted setting resume governing), or use `PUT /api/admin/maintenance` with `{"enabled": false}` to fix the persisted state properly, then remove the env override. Do not leave `MAINTENANCE_MODE=false` set permanently in an environment where you intend to use the persisted toggle day-to-day — it will silently defeat every future `PUT /api/admin/maintenance` call that tries to enable maintenance, until you notice why the toggle "isn't working."

## 5. `MAINTENANCE_MODE` reference

| Value | Effect |
|---|---|
| unset / empty | No override — persisted setting (and in-memory override, if any) governs. |
| `true` | Forces maintenance ON. Works even with a fully unreadable database. |
| `false` | Forces maintenance OFF. Break-glass recovery from a bad `allowAdmins: false` state. |
| anything else | Treated as unset (no override) — only exact, case-insensitive `true`/`false` are recognized. |

A change to `MAINTENANCE_MODE` requires an API process restart to take effect against a fresh boot state, but the value itself is re-read on every single request while the process is running — if you set it via an orchestrator that lets you edit a running container's environment and signal a reload, you don't necessarily need a full restart, but in practice for most deployments (Docker Compose, systemd) a restart is the reliable way to change it.

## 6. Nginx-level fallback (when the API itself won't start)

The in-app toggle above requires the API process to be running and able to answer requests — it is useless if a bad deploy means the API container crash-loops or never comes up at all. In that scenario, put the maintenance page in front of the API at the reverse-proxy layer instead.

The current `infra/nginx/nginx.conf` proxies `/api` and `/` straight through to the `api` and `web` upstream containers with no maintenance-mode awareness of its own — this is expected; nginx doesn't need to know about the feature in the normal case, since the API's own `MaintenanceGuard` handles it. But when the API is down, nginx is the only thing still running, so it needs an explicit fallback.

**Recommended approach: a static maintenance page served directly by nginx, activated by a toggled `include`.**

1. Create a static maintenance page, e.g. `infra/nginx/maintenance.html`:
   ```html
   <!DOCTYPE html>
   <html>
     <head><title>Maintenance</title></head>
     <body>
       <h1>MemoriaHub is temporarily down for maintenance.</h1>
       <p>We'll be back shortly. Thanks for your patience.</p>
     </body>
   </html>
   ```

2. Create a toggle file, e.g. `infra/nginx/maintenance.conf.disabled`, containing the fallback block:
   ```nginx
   # infra/nginx/maintenance.conf — copy/rename to enable, remove/rename away to disable.
   location / {
       root /usr/share/nginx/html;
       try_files /maintenance.html /maintenance.html =503;
       add_header Retry-After 120 always;
   }
   location /api {
       root /usr/share/nginx/html;
       default_type application/json;
       return 503 '{"error":"maintenance","message":"The application is temporarily down for maintenance."}';
       add_header Retry-After 120 always;
   }
   ```

3. In the `server {}` block of `nginx.conf`, add an `include` for the toggle file placed **before** the real `location /api` and `location /` blocks (nginx uses the first matching `location`, so the maintenance blocks must win when the file is present):
   ```nginx
   server {
       listen 80;
       server_name localhost;
       ...
       include /etc/nginx/maintenance.conf.enabled;   # no-op if the file doesn't exist... (see step 4)
       location /api { ... }
       location / { ... }
   }
   ```
   nginx's `include` directive errors on a genuinely missing file, so in practice keep an always-present, normally-empty file and overwrite its contents to toggle:
   ```bash
   # Always keep this file present (can be empty) so `include` never fails to find it:
   touch infra/nginx/maintenance.conf.enabled
   ```

4. **To activate the fallback** (API is down, nginx is still up), mount the maintenance page and copy the block from step 2 into the always-present include file, then reload nginx:
   ```bash
   cp infra/nginx/maintenance.conf.disabled infra/nginx/maintenance.conf.enabled
   # If running under Docker Compose, reload without restarting the container:
   docker compose -f infra/compose/base.compose.yml exec nginx nginx -s reload
   ```

5. **To deactivate**, empty the include file again and reload:
   ```bash
   : > infra/nginx/maintenance.conf.enabled
   docker compose -f infra/compose/base.compose.yml exec nginx nginx -s reload
   ```

This is a manual, ops-level fallback distinct from (and a level below) the in-app toggle in §3 — use it only when the API cannot serve `PUT /api/admin/maintenance` at all. As of this writing `nginx.conf` does not ship with the `include` line or the toggle file wired in; the steps above describe how to add them. If you set this up, keep the maintenance page's copy generic enough that it doesn't go stale (avoid baking in a specific ETA).

## 7. Audit trail

Every successful call to `PUT /api/admin/maintenance` writes an `AuditEvent` row (`action: 'maintenance:enabled'` or `'maintenance:disabled'`, `targetType: 'system_settings'`, `targetId: 'global'`, `meta: { enabled, message, allowAdmins, startedAt }`) via `MaintenanceModeService.writeAuditEvent`. The write is best-effort — a failed audit write is logged but never rolls back or blocks the toggle that already landed — so a missing audit row is a logging problem, not evidence the toggle didn't take effect. Check `audit_events` where `target_type = 'system_settings' AND target_id = 'global' AND action LIKE 'maintenance:%'` to review the history of who enabled/disabled maintenance and when.

## 8. Known limitation: unattended clients are always blocked

The `allowAdmins` bypass only recognizes a valid **JWT** carrying the Admin role. Personal access tokens (`pat_...`) and worker-node credentials (`nod_...`) are opaque bearer tokens that would need a database lookup to resolve to a user/role — and they identify unattended clients (the CLI, the worker-node fleet) that *should* back off during a maintenance window rather than be given an override. So: during maintenance, the CLI and worker nodes get the standard 503 regardless of `allowAdmins`, even if the underlying credential belongs to an Admin user. This is deliberate, not a bug — plan your maintenance windows with this in mind if you rely on scheduled CLI jobs or an active worker-node fleet, since their queue-processing will pause for the duration.
