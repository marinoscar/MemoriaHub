# MemoriaHub Troubleshooting Guide

This guide documents common issues encountered during development and their solutions. Each issue includes symptoms, root cause analysis, and step-by-step fixes.

## Table of Contents

- [Docker & Build Issues](#docker--build-issues)
  - [npm ci fails - no package-lock.json](#npm-ci-fails---no-package-lockjson)
  - [Port already in use](#port-already-in-use)
  - [Windows port reservation conflict](#windows-port-reservation-conflict)
  - [Container won't start](#container-wont-start)
- [OAuth & Authentication Issues](#oauth--authentication-issues)
  - [OAuth callback returns 404](#oauth-callback-returns-404)
  - [CORS error on API requests](#cors-error-on-api-requests)
  - [OAuth redirect to wrong URL](#oauth-redirect-to-wrong-url)
  - [Environment variables not updating](#environment-variables-not-updating)
- [API Issues](#api-issues)
  - [500 error on /api/auth/me](#500-error-on-apiauthme)
  - [API not reloading changes](#api-not-reloading-changes)
  - [Database connection refused](#database-connection-refused)
- [Nginx Issues](#nginx-issues)
  - [Duplicate variable error](#duplicate-variable-error)
  - [502 Bad Gateway](#502-bad-gateway)
- [Database Issues](#database-issues)
  - [Migration failed](#migration-failed)
  - [SSL connection required](#ssl-connection-required)
  - [Authentication failed](#authentication-failed)
- [General Debugging](#general-debugging)
  - [Checking container logs](#checking-container-logs)
  - [Inspecting environment variables](#inspecting-environment-variables)
  - [Testing connectivity between containers](#testing-connectivity-between-containers)

---

## Docker & Build Issues

### npm ci fails - no package-lock.json

**Symptoms:**
```
npm ci can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync
```
or
```
The `npm ci` command can only install with an existing package-lock.json
```

**Root Cause:**
Docker builds use `npm ci` for reproducible builds, but `package-lock.json` doesn't exist in the repository.

**Fix:**
```bash
# Generate package-lock.json from the repository root
npm install

# Rebuild Docker containers
docker compose -f infra/compose/dev.compose.yml up -d --build
```

**Prevention:**
Commit `package-lock.json` to version control after any dependency changes.

---

### Port already in use

**Symptoms:**
```
Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:5173
```
or
```
bind: address already in use
```

**Root Cause:**
Another process is using the required port.

**Fix:**

Windows:
```powershell
# Find what's using the port
netstat -ano | findstr :5173

# Kill the process (use PID from above)
taskkill /PID <pid> /F
```

macOS/Linux:
```bash
# Find and kill
lsof -i :5173
kill -9 <pid>
```

Alternative - use different ports in `dev.compose.yml`:
```yaml
web:
  ports:
    - "5174:5173"  # Use 5174 on host
```

---

### Windows port reservation conflict

**Symptoms:**
```
Error response from daemon: Ports are not available: listen tcp 0.0.0.0:80: bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

**Root Cause:**
Windows Hyper-V reserves certain port ranges. Ports 80, 8080, and others may be blocked.

**Diagnosis:**
```powershell
# Check reserved port ranges
netsh interface ipv4 show excludedportrange protocol=tcp
```

**Fix:**
The nginx service in `dev.compose.yml` uses port 8888 instead of 80:
```yaml
nginx:
  ports:
    - "8888:80"  # Use 8888 on host
```

Access via http://localhost:8888 instead of http://localhost

---

### Container won't start

**Symptoms:**
Container immediately exits or shows "Restarting" status.

**Diagnosis:**
```bash
# Check logs for the failing container
docker compose -f infra/compose/dev.compose.yml logs api

# Check container status
docker compose -f infra/compose/dev.compose.yml ps
```

**Common Causes:**

1. **Missing dependencies** - Check if all required packages are installed
2. **Environment variable errors** - Missing required env vars
3. **Port conflicts** - See "Port already in use" above
4. **Health check failing** - Service starts but health check fails

**Fix:**
```bash
# Rebuild the container
docker compose -f infra/compose/dev.compose.yml up -d --build <service>

# Or recreate from scratch
docker compose -f infra/compose/dev.compose.yml down
docker compose -f infra/compose/dev.compose.yml up -d --build
```

---

## OAuth & Authentication Issues

### OAuth callback returns 404

**Symptoms:**
After Google authentication, browser shows 404 error:
```
GET http://localhost/api/auth/google/callback?code=... 404 (Not Found)
```

**Root Cause:**
The `OAUTH_CALLBACK_BASE_URL` doesn't match the URL you're accessing the app from.

**Fix:**

1. Check your access URL (http://localhost:5173 vs http://localhost:8888)

2. Update `infra/compose/.env`:
   ```bash
   # For Vite dev server (port 5173):
   OAUTH_CALLBACK_BASE_URL=http://localhost:5173/api/auth
   FRONTEND_URL=http://localhost:5173

   # For nginx (port 8888):
   OAUTH_CALLBACK_BASE_URL=http://localhost:8888/api/auth
   FRONTEND_URL=http://localhost:8888
   ```

3. Update Google Cloud Console redirect URI to match:
   ```
   http://localhost:5173/api/auth/google/callback
   ```

4. Recreate the API container (restart doesn't reload env vars):
   ```bash
   docker compose -f infra/compose/dev.compose.yml up -d --force-recreate api
   ```

5. Verify the change took effect:
   ```bash
   docker compose -f infra/compose/dev.compose.yml exec api printenv | grep OAUTH_CALLBACK
   ```

---

### CORS error on API requests

**Symptoms:**
```
Access to XMLHttpRequest at 'http://localhost/api/auth/me' from origin 'http://localhost:5173'
has been blocked by CORS policy
```

**Root Cause:**
The frontend is making requests to an absolute URL instead of using the Vite proxy.

**Fix:**

1. Ensure `VITE_API_URL` is set to a relative path in `dev.compose.yml`:
   ```yaml
   web:
     environment:
       VITE_API_URL: /api  # Relative, not http://localhost/api
   ```

2. Recreate the web container:
   ```bash
   docker compose -f infra/compose/dev.compose.yml up -d --force-recreate web
   ```

3. Verify the Vite proxy is working:
   ```bash
   # From inside the web container, test API connectivity
   docker compose -f infra/compose/dev.compose.yml exec web curl -s http://api:3000/healthz
   ```

---

### OAuth redirect to wrong URL

**Symptoms:**
After clicking "Sign in with Google", the redirect goes to the wrong port (e.g., port 80 instead of 5173).

**Root Cause:**
OAuth callback URL is hardcoded or env var not loaded properly.

**Diagnosis:**
```bash
# Check what callback URL the API is using
docker compose -f infra/compose/dev.compose.yml exec api printenv | grep OAUTH
```

**Fix:**

1. Check `dev.compose.yml` - ensure env vars use variable substitution:
   ```yaml
   api:
     environment:
       OAUTH_CALLBACK_BASE_URL: ${OAUTH_CALLBACK_BASE_URL:-http://localhost:5173/api/auth}
   ```

2. Check `.env` file has correct values
3. Force recreate the container (restart doesn't reload env vars from compose file):
   ```bash
   docker compose -f infra/compose/dev.compose.yml up -d --force-recreate api
   ```

---

### Environment variables not updating

**Symptoms:**
Changed `.env` file but container still uses old values.

**Root Cause:**
`docker compose restart` doesn't reload environment variables. You need to recreate the container.

**Fix:**
```bash
# Force recreate to pick up env changes
docker compose -f infra/compose/dev.compose.yml up -d --force-recreate api

# Verify the change
docker compose -f infra/compose/dev.compose.yml exec api printenv | grep YOUR_VAR
```

**Important:** The compose file also defines environment variables. If a variable is hardcoded there (not using `${VAR:-default}`), changes to `.env` won't take effect.

---

## API Issues

### 500 error on /api/auth/me

**Symptoms:**
```
GET http://localhost:5173/api/auth/me 500 (Internal Server Error)
```

API logs show:
```
ZodError: Invalid enum value. Expected 'google' | 'microsoft' | 'github', received 'me'
```

**Root Cause:**
Express route ordering issue. The route `/auth/:provider` is matching `/auth/me` because `me` is treated as the `:provider` parameter.

**Fix:**
In `apps/api/src/api/routes/auth.routes.ts`, static routes must be defined BEFORE parameterized routes:

```typescript
// CORRECT ORDER:
router.get('/providers', ...);  // Static
router.get('/me', ...);         // Static - must come before /:provider
router.post('/refresh', ...);   // Static
router.post('/logout', ...);    // Static
router.get('/:provider', ...);  // Parameterized - must come last
router.get('/:provider/callback', ...);
```

After fixing, restart the API:
```bash
docker compose -f infra/compose/dev.compose.yml restart api
```

---

### API not reloading changes

**Symptoms:**
Made code changes but API doesn't reflect them.

**Root Cause:**
Volume mounts might not be working correctly, or tsx watch isn't detecting changes.

**Diagnosis:**
```bash
# Check if volume is mounted
docker compose -f infra/compose/dev.compose.yml exec api ls -la /app/apps/api/src

# Check tsx watch status in logs
docker compose -f infra/compose/dev.compose.yml logs api --tail=20
```

**Fix:**
```bash
# Restart to trigger tsx watch reload
docker compose -f infra/compose/dev.compose.yml restart api

# Or rebuild if needed
docker compose -f infra/compose/dev.compose.yml up -d --build api
```

---

### Database connection refused

**Symptoms:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Root Cause:**
PostgreSQL container isn't running or API is trying to connect to wrong host.

**Fix:**
```bash
# Check if PostgreSQL is running
docker compose -f infra/compose/dev.compose.yml ps postgres

# Start it if needed
docker compose -f infra/compose/dev.compose.yml up -d postgres

# Wait for it to be healthy
docker compose -f infra/compose/dev.compose.yml logs postgres

# Restart API to retry connection
docker compose -f infra/compose/dev.compose.yml restart api
```

---

## Nginx Issues

### Duplicate variable error

**Symptoms:**
```
nginx: [emerg] the duplicate "request_id" variable in /etc/nginx/nginx.conf:66
```

**Root Cause:**
The nginx `map` directive was placed inside the `server` block instead of the `http` block, or a variable name conflicts with nginx's built-in variables.

**Fix:**
In `infra/nginx/dev.conf`:

1. Move `map` directives to the `http` block (before `server`)
2. Use a custom variable name (e.g., `$req_id` instead of `$request_id`)

```nginx
http {
    # Map directive must be in http block
    map $http_x_request_id $req_id {
        default   $http_x_request_id;
        ""        $connection-$msec;
    }

    server {
        # Use $req_id in proxy_set_header
        proxy_set_header X-Request-Id $req_id;
    }
}
```

Restart nginx:
```bash
docker compose -f infra/compose/dev.compose.yml restart nginx
```

---

### 502 Bad Gateway

**Symptoms:**
Nginx returns 502 error when accessing the application.

**Root Cause:**
The upstream service (API or Web) isn't running or isn't accessible.

**Diagnosis:**
```bash
# Check if services are running
docker compose -f infra/compose/dev.compose.yml ps

# Check nginx logs
docker compose -f infra/compose/dev.compose.yml logs nginx

# Test upstream from nginx container
docker compose -f infra/compose/dev.compose.yml exec nginx curl -s http://api:3000/healthz
docker compose -f infra/compose/dev.compose.yml exec nginx curl -s http://web:5173/
```

**Fix:**
```bash
# Start the failing service
docker compose -f infra/compose/dev.compose.yml up -d api web

# Restart nginx
docker compose -f infra/compose/dev.compose.yml restart nginx
```

---

## Database Issues

### Migration failed

**Symptoms:**
```
Failed to apply migration: 003_create_libraries
```

**Root Cause:**
SQL syntax error in migration file or constraint violation.

**Diagnosis:**
```bash
# Check API logs for detailed error
docker compose -f infra/compose/dev.compose.yml logs api | grep -A 10 "migration"

# Connect to database to inspect state
docker compose -f infra/compose/dev.compose.yml exec postgres psql -U memoriahub
```

**Fix:**
1. Fix the SQL in the migration file
2. If partially applied, clean up manually:
   ```sql
   -- Remove failed migration record
   DELETE FROM schema_migrations WHERE version = '003_create_libraries';

   -- Drop partially created objects
   DROP TABLE IF EXISTS libraries CASCADE;
   ```
3. Restart API to retry:
   ```bash
   docker compose -f infra/compose/dev.compose.yml restart api
   ```

---

### SSL connection required

**Symptoms:**
```
Error: SSL connection is required
```

**Root Cause:**
Cloud database requires SSL but it's disabled in configuration.

**Fix:**
In `infra/compose/.env`:
```bash
POSTGRES_SSL=true
```

Or in `DATABASE_URL`:
```bash
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

---

### Authentication failed

**Symptoms:**
```
Error: password authentication failed for user "memoriahub"
```

**Root Cause:**
Credentials in `.env` don't match the database.

**Fix:**
For local Docker database, reset it:
```bash
# Stop and remove volumes
docker compose -f infra/compose/dev.compose.yml down -v

# Start fresh
docker compose -f infra/compose/dev.compose.yml up -d
```

For cloud database, verify credentials in provider's console.

---

## General Debugging

### Checking container logs

```bash
# All logs
docker compose -f infra/compose/dev.compose.yml logs

# Specific service
docker compose -f infra/compose/dev.compose.yml logs api

# Follow logs in real-time
docker compose -f infra/compose/dev.compose.yml logs -f api

# Last N lines
docker compose -f infra/compose/dev.compose.yml logs --tail=50 api

# Search for errors
docker compose -f infra/compose/dev.compose.yml logs api 2>&1 | grep -i error
```

### Inspecting environment variables

```bash
# View all env vars in a container
docker compose -f infra/compose/dev.compose.yml exec api printenv

# Search for specific var
docker compose -f infra/compose/dev.compose.yml exec api printenv | grep OAUTH

# Compare compose config vs actual
docker compose -f infra/compose/dev.compose.yml config | grep -A 20 "api:"
```

### Testing connectivity between containers

```bash
# From web to api
docker compose -f infra/compose/dev.compose.yml exec web curl -s http://api:3000/healthz

# From api to postgres
docker compose -f infra/compose/dev.compose.yml exec api curl -s postgres:5432 || echo "Can't curl PostgreSQL but that's expected"

# Check DNS resolution
docker compose -f infra/compose/dev.compose.yml exec api nslookup postgres

# Check if port is listening
docker compose -f infra/compose/dev.compose.yml exec api nc -zv postgres 5432
```

### Full reset

When all else fails, start fresh:

```bash
# Stop everything and remove volumes
docker compose -f infra/compose/dev.compose.yml down -v

# Remove built images
docker compose -f infra/compose/dev.compose.yml down --rmi local

# Clean Docker system (optional, affects all Docker)
docker system prune -a

# Rebuild everything
docker compose -f infra/compose/dev.compose.yml up -d --build
```

---

## Getting Help

If you encounter an issue not covered here:

1. **Check the logs** - Most issues have clear error messages
2. **Search existing issues** - https://github.com/marinoscar/MemoriaHub/issues
3. **Create a new issue** - Include:
   - Steps to reproduce
   - Error messages (full stack trace)
   - Environment (OS, Docker version, Node version)
   - Relevant config (sanitize secrets!)
