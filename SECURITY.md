# MemoriaHub Security

## Security goals
- Prevent unauthorized access to private media.
- Make sharing explicit and revocable.
- Protect tokens and secrets.
- Provide audit trails for sensitive actions.

## Threat model (practical)

### Assets to protect
- Original media files (photos/videos)
- Derived media (thumbnails/previews)
- OAuth identities and session tokens
- Shared library membership
- Public link tokens
- Audit logs

### Likely threats
- Token theft (XSS, leaked logs, stolen device)
- Broken access control (IDOR) on libraries/media
- Misconfigured WebDAV allowing cross-library writes
- SSRF or object storage key traversal
- Excessive data exposure in logs/traces
- Abuse (mass uploads, DOS)

## Authentication

### OAuth (required)
- Support providers (initial): Google, Microsoft, GitHub
- Persist mapping: provider + subject → MemoriaHub user
- Do not store passwords

### Sessions / JWT
- API uses short-lived access tokens + refresh tokens (recommended)
- Tokens are:
  - signed with strong key material
  - rotated on compromise
  - never logged

## Authorization

### Library access rules
- **Private**: owner only
- **Shared**: owner + invited members
- **Public**: only via explicit public link or explicit public setting (define precisely)

### Object-level enforcement
Every endpoint that reads/writes media must validate:
- `userId` is authorized for `libraryId`
- `assetId` belongs to `libraryId`

No “trust the client.” No “security by UI.”

## WebDAV security

### Recommended approach
- App-specific tokens for WebDAV (preferred over user passwords)
- Token scope:
  - user
  - library
  - optional: allowed path prefix

### WebDAV requirements
- HTTPS only
- Rate limits + upload size limits
- MIME/type validation (allow-list)
- Prevent path traversal and key injection
- Log + audit each upload event (without sensitive tokens)

## Secrets management
- Secrets stored only in `.env` (local) and in secure secret store (prod)
- Never commit secrets to git
- CI must block obvious secret patterns

## Data protection
- Encrypt in transit (TLS)
- Encrypt at rest (S3 SSE + disk encryption where possible)
- Use least-privilege IAM for S3 buckets

## Audit logging (append-only)
Persist and query audit events:
- Login / logout
- Library visibility changes
- Membership invites/removals
- Public link create/revoke
- Media access in shared/public contexts
- WebDAV uploads

Audit logs must include:
- actor (userId)
- action
- target (libraryId/assetId)
- timestamp
- remote IP + user agent (where applicable)

## Secure logging / telemetry rules
- Never log tokens, secrets, or raw OAuth payloads
- PII in logs must be minimized
- Trace attributes must avoid sensitive fields

## Security testing checklist
- Automated authorization tests for every protected endpoint
- Fuzz/path traversal tests on WebDAV routes
- OWASP checks for common web vulnerabilities (XSS/CSRF)
- Dependency scanning
