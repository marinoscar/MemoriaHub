# MemoriaHub Administrator Guide

This guide is for administrators of self-hosted MemoriaHub instances. It covers system configuration, security settings, and maintenance tasks.

## Table of Contents

- [System Requirements](#system-requirements)
- [Configuration Overview](#configuration-overview)
- [System Settings](#system-settings)
  - [Email (SMTP)](#email-smtp)
  - [Push Notifications](#push-notifications)
  - [Feature Flags](#feature-flags)
  - [General Settings](#general-settings)
- [Security](#security)
  - [Encryption](#encryption)
  - [OAuth Configuration](#oauth-configuration)
  - [Access Control](#access-control)
- [Maintenance](#maintenance)
- [Monitoring](#monitoring)
- [Backup & Recovery](#backup--recovery)

---

## System Requirements

### Minimum Requirements

| Component | Requirement |
|-----------|-------------|
| CPU | 2 cores |
| RAM | 4 GB |
| Storage | 20 GB (plus photo storage) |
| Docker | 24+ |
| Docker Compose | 2.20+ |

### Recommended for Production

| Component | Requirement |
|-----------|-------------|
| CPU | 4+ cores |
| RAM | 8+ GB |
| Storage | SSD with adequate space for photos |
| Database | External PostgreSQL (RDS, Cloud SQL, etc.) |
| Storage | S3 or S3-compatible (AWS S3, MinIO, Backblaze B2) |

---

## Configuration Overview

MemoriaHub uses a layered configuration approach:

1. **Environment Variables** (`.env` file) - Infrastructure settings
2. **System Settings** (Database) - Application configuration
3. **User Preferences** (Database) - Per-user settings

### Environment Variables vs System Settings

| Use Environment Variables For | Use System Settings For |
|------------------------------|------------------------|
| Database connection | SMTP server details |
| S3 bucket configuration | Feature flags |
| OAuth client credentials | Site name/description |
| JWT secrets | Upload limits |
| Port bindings | Notification settings |

---

## System Settings

### Accessing System Settings

System settings are managed through the API. Future versions will include an admin UI.

**API Endpoints:**

```bash
# Get all system settings
GET /api/settings/system
Authorization: Bearer <token>

# Get specific category
GET /api/settings/system/:category
Authorization: Bearer <token>

# Update settings
PATCH /api/settings/system/:category
Authorization: Bearer <token>
Content-Type: application/json

{
  "settings": { ... }
}
```

### Email (SMTP)

Configure email delivery for notifications and alerts.

**Settings:**

```json
{
  "enabled": true,
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": true,
  "username": "your-email@gmail.com",
  "password": "app-specific-password",
  "fromAddress": "noreply@yourdomain.com",
  "fromName": "MemoriaHub"
}
```

**Provider Examples:**

| Provider | Host | Port | Secure | Notes |
|----------|------|------|--------|-------|
| Gmail | smtp.gmail.com | 587 | true | Requires App Password |
| Outlook | smtp.office365.com | 587 | true | Use account email |
| Amazon SES | email-smtp.{region}.amazonaws.com | 587 | true | IAM credentials |
| SendGrid | smtp.sendgrid.net | 587 | true | API key as password |
| Mailgun | smtp.mailgun.org | 587 | true | SMTP credentials |

**Testing SMTP:**

```bash
# Test SMTP configuration
curl -X POST /api/settings/system/smtp/test \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"recipientEmail": "test@example.com"}'
```

### Push Notifications

Configure browser push notifications.

**Web Push Settings:**

```json
{
  "enabled": true,
  "provider": "webpush",
  "vapidPublicKey": "BN...",
  "vapidPrivateKey": "..."
}
```

**Generate VAPID Keys:**

```bash
# Using npx
npx web-push generate-vapid-keys

# Output:
# Public Key: BN...
# Private Key: ...
```

### Feature Flags

Enable or disable application features.

```json
{
  "aiSearch": false,
  "faceRecognition": false,
  "webdavSync": true,
  "publicSharing": true,
  "guestUploads": false
}
```

| Flag | Default | Description |
|------|---------|-------------|
| `aiSearch` | false | AI-powered image search |
| `faceRecognition` | false | Automatic face detection |
| `webdavSync` | true | WebDAV protocol support |
| `publicSharing` | true | Public album links |
| `guestUploads` | false | Allow uploads via shared links |

### General Settings

```json
{
  "siteName": "MemoriaHub",
  "siteDescription": "Your family photo memories, secured.",
  "allowRegistration": true,
  "requireEmailVerification": false,
  "maxUploadSizeMB": 100,
  "supportedFormats": ["jpg", "jpeg", "png", "gif", "webp", "heic", "mp4", "mov", "avi"]
}
```

---

## Security

### Encryption

Sensitive settings (SMTP password, API keys) are encrypted at rest using AES-256-GCM.

**Enable Encryption:**

1. Generate an encryption key:
   ```bash
   openssl rand -base64 32
   ```

2. Add to your `.env` file:
   ```bash
   SETTINGS_ENCRYPTION_KEY=your-generated-key
   ```

3. Restart the API service

**Important:** Store the encryption key securely. If lost, encrypted settings cannot be recovered.

### OAuth Configuration

OAuth credentials are configured via environment variables for security:

```bash
# Google OAuth
OAUTH_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-xxx

# Microsoft OAuth (optional)
OAUTH_MICROSOFT_CLIENT_ID=xxx
OAUTH_MICROSOFT_CLIENT_SECRET=xxx

# GitHub OAuth (optional)
OAUTH_GITHUB_CLIENT_ID=xxx
OAUTH_GITHUB_CLIENT_SECRET=xxx
```

**Callback URLs to Register:**

For each OAuth provider, register these callback URLs:

- Development: `http://localhost:5173/api/auth/{provider}/callback`
- Production: `https://yourdomain.com/api/auth/{provider}/callback`

### Access Control

Currently, all authenticated users can access system settings. Future versions will include role-based access control (RBAC).

**Planned Roles:**
- `admin` - Full system access
- `user` - Standard user access
- `viewer` - Read-only access

---

## Maintenance

### Database Maintenance

**Vacuum and Analyze:**
```sql
-- Run periodically for PostgreSQL performance
VACUUM ANALYZE;
```

**View Table Sizes:**
```sql
SELECT
  relname as table,
  pg_size_pretty(pg_total_relation_size(relid)) as size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

### Cache Management

The settings cache automatically expires after 5 minutes. To manually clear:

```bash
# Restart the API service
docker compose restart api
```

### Log Rotation

Configure log rotation in Docker:

```yaml
# docker-compose.yml
services:
  api:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## Monitoring

### Health Checks

```bash
# Basic health check
curl http://localhost:3000/healthz
# Response: {"status":"ok","timestamp":"...","version":"0.1.0"}

# Ready check (includes dependencies)
curl http://localhost:3000/readyz
# Response: {"status":"ok","dependencies":{"database":"ok","storage":"ok"}}
```

### Metrics (Prometheus)

Metrics are exposed at `/metrics` in Prometheus format:

```bash
curl http://localhost:3000/metrics
```

**Key Metrics:**
- `http_requests_total` - Request count by method/path/status
- `http_request_duration_seconds` - Request latency histogram
- `db_query_duration_seconds` - Database query latency
- `settings_cache_hits_total` - Cache hit rate

### Grafana Dashboards

Access Grafana at `http://localhost:3001` (default: admin/admin)

Pre-configured dashboards:
- API Performance
- Database Health
- Storage Usage

### Distributed Tracing (Jaeger)

Access Jaeger at `http://localhost:16686`

Trace requests across services with correlation IDs.

---

## Backup & Recovery

### Database Backup

**Docker PostgreSQL:**
```bash
# Backup
docker compose exec postgres pg_dump -U memoriahub memoriahub > backup.sql

# Restore
docker compose exec -T postgres psql -U memoriahub memoriahub < backup.sql
```

**Cloud PostgreSQL:**
Use your provider's backup features (RDS snapshots, Cloud SQL backups, etc.)

### Settings Backup

Export system settings:

```bash
# Export all settings
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/settings/system > settings-backup.json
```

### Storage Backup

For S3-compatible storage:
```bash
# Using AWS CLI
aws s3 sync s3://memoriahub-bucket ./backup/

# Using rclone
rclone sync minio:memoriahub ./backup/
```

### Full Disaster Recovery

1. Restore database from backup
2. Restore storage from backup
3. Update `.env` with connection details
4. Start services
5. Verify with health checks

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Settings not updating | Use `--force-recreate` when restarting containers |
| SMTP not working | Check firewall allows outbound port 587 |
| Cache inconsistency | Restart API service to clear cache |
| Encryption errors | Verify `SETTINGS_ENCRYPTION_KEY` is set |

### Logs

```bash
# API logs
docker compose logs -f api

# All service logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100 api
```

### Debug Mode

Enable debug logging:

```bash
# In .env
LOG_LEVEL=debug
```

---

## Support

- **Documentation**: [docs/](/)
- **Issues**: [GitHub Issues](https://github.com/marinoscar/MemoriaHub/issues)
- **Security Issues**: Report privately via GitHub Security tab

---

*Last updated: January 2024*
