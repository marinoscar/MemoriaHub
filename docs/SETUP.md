# MemoriaHub Setup Guide

Complete guide for setting up MemoriaHub for the first time, including development environment configuration, Google OAuth setup, and verification steps.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
  - [Step 1: Clone and Configure](#step-1-clone-and-configure)
  - [Step 2: Configure Google OAuth](#step-2-configure-google-oauth)
  - [Step 3: Generate Package Lock File](#step-3-generate-package-lock-file)
  - [Step 4: Start Docker Services](#step-4-start-docker-services)
  - [Step 5: Verify Services](#step-5-verify-services)
  - [Step 6: Test OAuth Flow](#step-6-test-oauth-flow)
- [Development Workflow](#development-workflow)
- [Service URLs](#service-urls)
- [Common Issues](#common-issues)

---

## Prerequisites

Before starting, ensure you have:

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |
| Docker | 24+ | `docker --version` |
| Docker Compose | 2.20+ | `docker compose version` |
| Git | 2.40+ | `git --version` |

**Windows Users**: Ensure Docker Desktop is running and WSL 2 is enabled for best performance.

---

## Quick Start

For experienced developers who want to get running quickly:

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/MemoriaHub.git
cd MemoriaHub

# 2. Copy environment template
cp infra/compose/.env.example infra/compose/.env

# 3. Edit .env file with your Google OAuth credentials
# See "Configure Google OAuth" section below

# 4. Generate package-lock.json (required for Docker builds)
npm install

# 5. Start all services using the dev script
# Linux/macOS:
./scripts/dev.sh start

# Windows (PowerShell):
.\scripts\dev.ps1 start

# 6. Wait for services to be healthy (check with)
# Linux/macOS:
./scripts/dev.sh status

# Windows (PowerShell):
.\scripts\dev.ps1 status

# 7. Open browser
# App: http://localhost:5173
# API Health: http://localhost:3000/healthz
```

---

## Detailed Setup

### Step 1: Clone and Configure

```bash
# Clone the repository
git clone https://github.com/yourusername/MemoriaHub.git
cd MemoriaHub

# Copy the environment template
cp infra/compose/.env.example infra/compose/.env
```

Edit `infra/compose/.env` with your settings. The critical settings for first-time setup are:

```bash
# OAuth Configuration (REQUIRED for login)
OAUTH_GOOGLE_CLIENT_ID=your-google-client-id
OAUTH_GOOGLE_CLIENT_SECRET=your-google-client-secret

# OAuth URLs for development with Vite proxy
OAUTH_CALLBACK_BASE_URL=http://localhost:5173/api/auth
FRONTEND_URL=http://localhost:5173

# JWT Secret (generate a secure random string)
JWT_SECRET=your-secure-random-string-here
```

### Step 2: Configure Google OAuth

1. **Go to Google Cloud Console**
   - Visit [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Create a new project or select an existing one

2. **Create OAuth 2.0 Credentials**
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Name: "MemoriaHub Development"

3. **Configure Authorized URIs**

   **Authorized JavaScript origins:**
   ```
   http://localhost:5173
   ```

   **Authorized redirect URIs:**
   ```
   http://localhost:5173/api/auth/google/callback
   ```

4. **Copy Credentials**
   - Copy the Client ID and Client Secret
   - Add them to your `infra/compose/.env` file:
   ```bash
   OAUTH_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret
   ```

5. **Configure OAuth Consent Screen** (if not already done)
   - User Type: External (or Internal for Google Workspace)
   - App name: MemoriaHub
   - User support email: your email
   - Scopes: email, profile, openid

### Step 3: Generate Package Lock File

Docker builds require a `package-lock.json` file. Generate it by running:

```bash
# From the repository root
npm install
```

This creates `package-lock.json` files for the monorepo.

### Step 4: Start Docker Services

```bash
# Start all services in detached mode
docker compose -f infra/compose/dev.compose.yml up -d

# Watch the build progress (first time takes 2-5 minutes)
docker compose -f infra/compose/dev.compose.yml logs -f
```

**What happens during startup:**

1. PostgreSQL starts and becomes healthy
2. MinIO (S3) starts and bucket is created
3. API container builds and starts
4. API runs database migrations automatically
5. Web container builds and starts (Vite dev server)
6. Nginx reverse proxy starts
7. Observability stack starts (Jaeger, Prometheus, Grafana, Loki)

### Step 5: Verify Services

Check all services are running:

```bash
docker compose -f infra/compose/dev.compose.yml ps
```

Expected output (all should show "healthy" or "running"):

```
NAME                    STATUS                    PORTS
memoriahub-api          Up (healthy)              0.0.0.0:3000->3000/tcp
memoriahub-grafana      Up                        0.0.0.0:3001->3000/tcp
memoriahub-jaeger       Up                        0.0.0.0:16686->16686/tcp
memoriahub-minio        Up (healthy)              0.0.0.0:9000-9001->9000-9001/tcp
memoriahub-nginx        Up                        0.0.0.0:8888->80/tcp
memoriahub-postgres     Up (healthy)              0.0.0.0:5432->5432/tcp
memoriahub-prometheus   Up                        0.0.0.0:9090->9090/tcp
memoriahub-web          Up (healthy)              0.0.0.0:5173->5173/tcp
memoriahub-worker       Up                        3001/tcp
```

Test the API health endpoints:

```bash
# Health check
curl http://localhost:3000/healthz
# Expected: {"status":"ok","timestamp":"...","version":"0.1.0"}

# Ready check (includes database)
curl http://localhost:3000/readyz
# Expected: {"status":"ok",...,"dependencies":{"database":"ok"}}

# Auth providers
curl http://localhost:3000/api/auth/providers
# Expected: {"data":[{"id":"google","name":"Google","authUrl":"/api/auth/google"}]}
```

### Step 6: Test OAuth Flow

1. **Open the application**
   - Navigate to `http://localhost:5173` in your browser

2. **Click "Sign in with Google"**
   - You should be redirected to Google's OAuth consent screen

3. **Complete authentication**
   - Select your Google account
   - Accept the permissions

4. **Verify login**
   - You should be redirected back to MemoriaHub
   - Your name and avatar should appear in the top-right corner
   - Click your avatar to see the user menu

---

## Development Workflow

### Development Scripts

MemoriaHub includes convenience scripts to manage the development environment:

**Linux/macOS:**
```bash
./scripts/dev.sh <action> [service]
```

**Windows (PowerShell):**
```powershell
.\scripts\dev.ps1 <action> [service]
```

**Available Actions:**

| Action | Description |
|--------|-------------|
| `start` | Start all services (or specific service) |
| `stop` | Stop all services (or specific service) |
| `restart` | Restart all services (or specific service) |
| `rebuild` | Rebuild and restart all services (or specific service) |
| `logs` | Show logs (follow mode) |
| `status` | Show status of all services |
| `clean` | Stop services and remove volumes (resets database) |
| `help` | Show help message |

**Examples:**

```bash
# Start all services
./scripts/dev.sh start          # Linux/macOS
.\scripts\dev.ps1 start         # Windows

# Rebuild everything after code changes
./scripts/dev.sh rebuild        # Linux/macOS
.\scripts\dev.ps1 rebuild       # Windows

# Rebuild only the API service
./scripts/dev.sh rebuild api    # Linux/macOS
.\scripts\dev.ps1 rebuild api   # Windows

# View API logs
./scripts/dev.sh logs api       # Linux/macOS
.\scripts\dev.ps1 logs api      # Windows

# Check service status
./scripts/dev.sh status         # Linux/macOS
.\scripts\dev.ps1 status        # Windows

# Reset everything (destroys data)
./scripts/dev.sh clean          # Linux/macOS
.\scripts\dev.ps1 clean         # Windows
```

### Manual Docker Commands

If you prefer using Docker Compose directly:

```bash
# Start all services
docker compose -f infra/compose/dev.compose.yml up -d

# Start specific services
docker compose -f infra/compose/dev.compose.yml up -d api web postgres

# View logs
docker compose -f infra/compose/dev.compose.yml logs -f api

# Stop all services (preserves data)
docker compose -f infra/compose/dev.compose.yml down

# Stop and remove volumes (resets database)
docker compose -f infra/compose/dev.compose.yml down -v

# Rebuild and restart
docker compose -f infra/compose/dev.compose.yml up -d --build
```

### Hot Reload

The development setup includes hot reload:
- **API**: tsx watch mode - changes to TypeScript files auto-restart
- **Web**: Vite HMR - changes to React components update instantly
- **Worker**: tsx watch mode - changes auto-restart

---

## Service URLs

| Service | URL | Purpose |
|---------|-----|---------|
| **Web App** | http://localhost:5173 | Main application (React + Vite) |
| **API** | http://localhost:3000 | REST API endpoints |
| **API Health** | http://localhost:3000/healthz | Health check |
| **API Metrics** | http://localhost:3000/metrics | Prometheus metrics |
| **Nginx** | http://localhost:8888 | Reverse proxy (production-like) |
| **Grafana** | http://localhost:3001 | Dashboards (admin/admin) |
| **Prometheus** | http://localhost:9090 | Metrics & queries |
| **Jaeger** | http://localhost:16686 | Distributed tracing |
| **MinIO Console** | http://localhost:9001 | S3 storage UI (memoriahub/memoriahub_dev_secret) |
| **PostgreSQL** | localhost:5432 | Database (memoriahub/memoriahub_dev) |

---

## Database Management

### Connecting with pgAdmin

You can connect to the PostgreSQL database using pgAdmin or any PostgreSQL client.

**Connection Details:**

| Setting | Value |
|---------|-------|
| Host | `localhost` |
| Port | `5432` |
| Database | `memoriahub` |
| Username | `memoriahub` |
| Password | `memoriahub_dev` |

**pgAdmin Setup:**

1. Open pgAdmin
2. Right-click **Servers** → **Register** → **Server**
3. **General tab**:
   - Name: `MemoriaHub Local`
4. **Connection tab**:
   - Host: `localhost`
   - Port: `5432`
   - Maintenance database: `memoriahub`
   - Username: `memoriahub`
   - Password: `memoriahub_dev`
   - Save password: ✓ (optional)
5. Click **Save**

**Alternative: Command Line:**

```bash
# Using Docker (no local psql needed)
docker compose -f infra/compose/dev.compose.yml exec postgres psql -U memoriahub

# Using local psql client
psql -h localhost -p 5432 -U memoriahub -d memoriahub
```

**Useful Queries:**

```sql
-- List all tables
\dt

-- View users
SELECT id, email, display_name, created_at FROM users;

-- View system settings
SELECT category, updated_at FROM system_settings;

-- Check migrations
SELECT * FROM schema_migrations ORDER BY version;
```

### Other Database Tools

These connection details work with any PostgreSQL client:

- **DBeaver**: Create PostgreSQL connection with the same settings
- **DataGrip**: Add PostgreSQL data source
- **VS Code**: Use PostgreSQL extension with connection string:
  ```
  postgresql://memoriahub:memoriahub_dev@localhost:5432/memoriahub
  ```

---

## Common Issues

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed solutions to common problems.

### Quick Fixes

**Port already in use:**
```bash
# Check what's using the port
netstat -ano | findstr :5173  # Windows
lsof -i :5173                  # macOS/Linux

# Use a different port or stop the conflicting service
```

**Docker build fails with npm ci:**
```bash
# Generate package-lock.json
npm install

# Rebuild
docker compose -f infra/compose/dev.compose.yml up -d --build
```

**OAuth callback fails with 404:**
```bash
# Ensure OAUTH_CALLBACK_BASE_URL matches your access URL
# For Vite dev server:
OAUTH_CALLBACK_BASE_URL=http://localhost:5173/api/auth

# Recreate API container to pick up changes
docker compose -f infra/compose/dev.compose.yml up -d --force-recreate api
```

**API returns 500 on /api/auth/me:**
```bash
# This is usually a route ordering issue - restart API
docker compose -f infra/compose/dev.compose.yml restart api
```

---

## Next Steps

Once setup is complete:

1. **Explore the codebase**
   - `apps/web/` - React frontend with MUI
   - `apps/api/` - Express backend with OAuth
   - `packages/shared/` - Shared types and utilities

2. **Check observability**
   - View traces in Jaeger: http://localhost:16686
   - View metrics in Grafana: http://localhost:3001
   - View logs: `docker compose logs -f api`

3. **Read the documentation**
   - [ARCHITECTURE.md](../ARCHITECTURE.md) - System design
   - [DATABASE.md](DATABASE.md) - Database configuration
   - [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Problem solving

4. **Start developing**
   - Features are marked "Coming Soon" in the UI
   - Check [ROADMAP.md](../ROADMAP.md) for planned features
