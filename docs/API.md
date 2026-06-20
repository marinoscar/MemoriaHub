# API Reference

## Base URL

- **Development**: http://localhost:3535/api
- **Production**: https://yourdomain.com/api

## Authentication

All endpoints require JWT Bearer token authentication unless explicitly marked as **Public**.

**Authorization Header:**
```
Authorization: Bearer <access_token>
```

Access tokens are short-lived (15 minutes by default). Use the refresh token flow to obtain new access tokens.

## Response Format

### Success Response

```json
{
  "data": <response_data>,
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest"
}
```

For validation errors:
```json
{
  "statusCode": 400,
  "message": ["Field validation error 1", "Field validation error 2"],
  "error": "BadRequest"
}
```

## Pagination

Endpoints returning lists support pagination with the following query parameters:

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number (1-indexed) |
| `pageSize` | number | 20 | 100 | Items per page |

**Paginated Response Format:**
```json
{
  "data": [...],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

---

## Endpoints

### Authentication

#### GET /auth/providers
**Public endpoint** - List enabled OAuth providers.

**Response:**
```json
{
  "data": {
    "providers": [
      {
        "name": "google",
        "enabled": true
      }
    ]
  }
}
```

---

#### GET /auth/google
**Public endpoint** - Initiate Google OAuth flow. Redirects to Google consent screen.

**Response:** HTTP 302 redirect to Google

---

#### GET /auth/google/callback
**Public endpoint** - OAuth callback handler (called by Google).

**Query Parameters:**
- `code` (string) - Authorization code from Google
- `state` (string, optional) - CSRF protection state

**Response:** HTTP 302 redirect to frontend with access token in query parameter
- Sets HttpOnly refresh token cookie
- Redirects to `/auth/callback?accessToken=<token>`

**Error Cases:**
- Email not in allowlist → Redirects to `/auth/error?error=not_authorized`
- OAuth failure → Redirects to `/auth/error?error=oauth_failed`

---

#### GET /auth/me
**Requires Authentication** - Get current user profile.

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    }
  ],
  "permissions": ["users:read", "users:write", "system_settings:read", ...]
}
```

---

#### POST /auth/refresh
**Public endpoint** - Refresh access token using refresh token cookie.

**Request:** No body required (uses HttpOnly cookie)

**Response:**
```json
{
  "accessToken": "new_jwt_access_token",
  "expiresIn": 900
}
```

Sets new refresh token in HttpOnly cookie (token rotation).

**Error Cases:**
- 401 Unauthorized - Missing or invalid refresh token
- 403 Forbidden - User is disabled

---

#### POST /auth/logout
**Requires Authentication** - Logout and revoke refresh token.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes refresh token in database

---

#### POST /auth/logout-all
**Requires Authentication** - Logout from all devices and revoke all refresh tokens.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes ALL refresh tokens for the current user across all devices

**Use Case:** Security feature to force re-authentication on all sessions (e.g., after password change or suspected compromise).

---

### Device Authorization (RFC 8628)

The Device Authorization Flow enables input-constrained devices (CLI tools, IoT devices, Smart TVs) to obtain user authorization. See [DEVICE-AUTH.md](DEVICE-AUTH.md) for comprehensive guide and integration examples.

#### POST /auth/device/code
**Public endpoint** - Generate device code pair to initiate device authorization flow.

**Request Body:**
```json
{
  "clientInfo": {
    "name": "My CLI Tool",
    "version": "1.0.0",
    "platform": "linux"
  }
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clientInfo` | object | No | Optional metadata about client device |
| `clientInfo.name` | string | No | Application name |
| `clientInfo.version` | string | No | Application version |
| `clientInfo.platform` | string | No | Platform identifier |
| `clientInfo.tokenType` | string | No | Set to `"pat"` to request a long-lived Personal Access Token on approval instead of a short-lived JWT. The CLI uses this to obtain a 90-day PAT (lifetime controlled by `DEVICE_PAT_TTL_DAYS`, default 90). The PAT is visible and revocable from the web app's Personal Access Tokens screen. |

**Response:**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/device",
    "verificationUriComplete": "http://localhost:3535/device?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque code for device polling (keep secret) |
| `userCode` | string | Human-readable code for user entry (XXXX-XXXX format) |
| `verificationUri` | string | URL where user should authorize |
| `verificationUriComplete` | string | URL with user code pre-filled |
| `expiresIn` | number | Code lifetime in seconds (default: 900) |
| `interval` | number | Minimum polling interval in seconds (default: 5) |

---

#### POST /auth/device/token
**Public endpoint** - Poll for authorization status and obtain tokens when approved.

**Request Body:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (200 OK - Authorized):**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

**Error Responses (400 Bad Request):**

While authorization is pending:
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

Device polling too frequently:
```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

Code has expired:
```json
{
  "error": "expired_token",
  "error_description": "The device code has expired"
}
```

User denied authorization:
```json
{
  "error": "access_denied",
  "error_description": "User denied the authorization request"
}
```

**Error Response (401 Unauthorized):**

Invalid device code:
```json
{
  "error": "invalid_grant",
  "error_description": "Invalid device code"
}
```

**Usage:**
1. Device requests code from `/auth/device/code`
2. Device displays `userCode` and `verificationUri` to user
3. Device polls this endpoint every `interval` seconds
4. User visits verification page and approves device
5. Polling returns tokens when approved

---

#### GET /auth/device/activate
**Requires Authentication** - Get activation page information and validate user code.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | No | User verification code to validate |

**Request (No Code):**
```http
GET /auth/device/activate
Authorization: Bearer <token>
```

**Response (No Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device"
  }
}
```

**Request (With Code):**
```http
GET /auth/device/activate?code=ABCD-1234
Authorization: Bearer <token>
```

**Response (With Valid Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "name": "My CLI Tool",
      "version": "1.0.0",
      "platform": "linux"
    },
    "expiresAt": "2024-01-01T12:15:00.000Z"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### POST /auth/device/authorize
**Requires Authentication** - Approve or deny device authorization request.

**Request Body:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userCode` | string | Yes | User code from the device |
| `approve` | boolean | Yes | true to approve, false to deny |

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### GET /auth/device/sessions
**Requires Authentication** - List current user's approved device sessions.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number |
| `limit` | number | No | 10 | Items per page |

**Response:**
```json
{
  "data": {
    "sessions": [
      {
        "id": "uuid-1234",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "name": "My CLI Tool",
          "version": "1.0.0",
          "platform": "linux"
        },
        "createdAt": "2024-01-01T12:00:00.000Z",
        "expiresAt": "2024-01-01T12:15:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10
  }
}
```

**Use Case:** View all devices that have been authorized to access the account.

---

#### DELETE /auth/device/sessions/:id
**Requires Authentication** - Revoke a specific device session.

**Parameters:**
- `id` (UUID) - Session ID to revoke

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Session not found or doesn't belong to current user

**Use Case:** Revoke access for lost or compromised devices.

---

### Test Authentication (Development/Test Only)

**Security Notice:** These endpoints are completely disabled in production. They exist solely to enable automated E2E testing without requiring real OAuth credentials.

#### POST /auth/test/login
**Development/Test Only** - Authenticate as a test user without OAuth.

**Availability:** Only when `NODE_ENV !== 'production'`

**Request Body:**
```json
{
  "email": "test@test.local",
  "role": "admin",
  "displayName": "Test Admin"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Email address for test user |
| `role` | enum | No | Role to assign: `admin`, `contributor`, `viewer` (default: `viewer`) |
| `displayName` | string | No | Display name for the user |

**Response:** HTTP 302 redirect to `/auth/callback?token=<accessToken>&expiresIn=900`
- Sets HttpOnly refresh token cookie (same as OAuth flow)
- Creates user if not exists, assigns specified role

**Error Cases:**
- 403 Forbidden - Endpoint disabled (production environment)
- 400 Bad Request - Invalid email or role

**Use Case:** Playwright E2E tests use this endpoint to authenticate without Google OAuth.

---

### Users

**All user endpoints require Admin role (`users:read` or `users:write` permissions)**

#### GET /users
List all users with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email or display name |
| `isActive` | boolean | - | Filter by active status |
| `role` | string | - | Filter by role name |
| `sortBy` | enum | `createdAt` | Sort field: `email`, `createdAt`, `updatedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "John Doe",
      "profileImageUrl": "https://...",
      "providerDisplayName": "John Doe",
      "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "roles": [
        {
          "id": "uuid",
          "name": "contributor"
        }
      ]
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

---

#### GET /users/:id
Get user by ID.

**Parameters:**
- `id` (UUID) - User ID

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "providerDisplayName": "John Doe",
  "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "roles": [
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ],
  "identities": [
    {
      "provider": "google",
      "providerEmail": "user@example.com"
    }
  ]
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider.

**Error Cases:**
- 404 Not Found - User not found

---

#### PATCH /users/:id
Update user properties (activation status, display name).

**Requires:** `users:write` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "isActive": false,
  "displayName": "New Name"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `isActive` | boolean | No | Activate or deactivate user |
| `displayName` | string | No | Update user's display name |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "New Name",
  "isActive": false,
  "roles": [
    {
      "id": "uuid",
      "name": "viewer"
    }
  ]
}
```

**Error Cases:**
- 404 Not Found - User not found

---

#### PUT /users/:id/roles
Update user roles (replaces all current roles).

**Requires:** `rbac:manage` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "roleNames": ["admin", "contributor"]
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roleNames` | string[] | Yes | Array of role names to assign (min: 1) |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    },
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ]
}
```

**Validation Rules:**
- Cannot remove own admin role (prevents accidental lockout)
- At least one role must be assigned
- Role names must exist in the system

**Error Cases:**
- 400 Bad Request - Invalid role names, empty array, or attempting to remove own admin role
- 401 Unauthorized - Not authenticated
- 403 Forbidden - Missing `rbac:manage` permission
- 404 Not Found - User not found

---

### Allowlist

**All allowlist endpoints require Admin role (`allowlist:read` or `allowlist:write` permissions)**

The allowlist restricts application access to pre-authorized email addresses. Users must have their email in the allowlist before they can complete OAuth login.

#### GET /allowlist
List allowlisted emails with pagination, filtering, and sorting.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email |
| `status` | enum | `all` | Filter by status: `all`, `pending`, `claimed` |
| `sortBy` | enum | `addedAt` | Sort by: `email`, `addedAt`, `claimedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-01T00:00:00.000Z",
      "claimedBy": {
        "id": "uuid",
        "email": "user@example.com",
        "displayName": "John Doe"
      },
      "claimedAt": "2024-01-02T00:00:00.000Z",
      "notes": "New team member"
    },
    {
      "id": "uuid",
      "email": "pending@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-03T00:00:00.000Z",
      "claimedBy": null,
      "claimedAt": null,
      "notes": null
    }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`). `claimedBy` object contains `id`, `email`, and `displayName` when not null.

**Status Filters:**
- `all` - All allowlist entries
- `pending` - Emails not yet claimed by a user (claimedBy is null)
- `claimed` - Emails claimed by registered users (claimedBy is not null)

---

#### POST /allowlist
Add email to allowlist.

**Requires:** `allowlist:write` permission

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "notes": "Marketing team member - starts next week"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Valid email address (case-insensitive) |
| `notes` | string | No | Optional notes about this user |

**Response:**
```json
{
  "id": "uuid",
  "email": "newuser@example.com",
  "addedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "addedAt": "2024-01-01T00:00:00.000Z",
  "claimedBy": null,
  "claimedAt": null,
  "notes": "Marketing team member - starts next week"
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`).

**Error Cases:**
- 409 Conflict - Email already exists in allowlist
- 400 Bad Request - Invalid email format

---

#### DELETE /allowlist/:id
Remove email from allowlist.

**Requires:** `allowlist:write` permission

**Parameters:**
- `id` (UUID) - Allowlist entry ID

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Allowlist entry not found
- 400 Bad Request - Cannot remove entry that has been claimed by a user

**Note:** Entries that have been claimed (user has logged in) cannot be removed. This prevents accidentally removing access for existing users.

---

### Settings

#### GET /user-settings
**Requires Authentication** - Get current user's settings.

**Response:**
```json
{
  "theme": "light",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `theme` | enum | UI theme: `light`, `dark`, `system` |
| `profile.displayName` | string \| null | User's display name override |
| `profile.useProviderImage` | boolean | Whether to use OAuth provider's profile image |
| `profile.customImageUrl` | string \| null | Custom profile image URL |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `version` | number | Version number for optimistic concurrency control |

---

#### PUT /user-settings
**Requires Authentication** - Replace all user settings.

**Request Body:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  }
}
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "useProviderImage": false,
    "customImageUrl": "https://example.com/avatar.jpg"
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Note:** This replaces the entire settings object. Use PATCH for partial updates.

---

#### PATCH /user-settings
**Requires Authentication** - Partially update user settings.

**Request Body:**
```json
{
  "theme": "dark"
}
```

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "John Doe",
    "useProviderImage": true,
    "customImageUrl": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates in concurrent scenarios

**Note:** This performs a shallow merge with existing settings.

---

#### GET /system-settings
**Requires:** `system_settings:read` permission (Admin only)

Get system-wide settings.

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `ui.allowUserThemeOverride` | boolean | Allow users to override system theme |
| `security.jwtAccessTtlMinutes` | number | JWT access token TTL in minutes |
| `security.refreshTtlDays` | number | Refresh token TTL in days |
| `features` | object | Feature flags (extensible) |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `updatedBy` | object | User who last updated settings |
| `version` | number | Version number for optimistic concurrency control |

---

#### PUT /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Replace all system settings.

**Request Body:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {}
}
```

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

---

#### PATCH /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Partially update system settings.

**Request Body:**
```json
{
  "ui": {
    "allowUserThemeOverride": false
  }
}
```

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "ui": {
    "allowUserThemeOverride": false
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {},
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates when multiple admins modify settings concurrently

---

### Storage Objects

The storage system provides file upload and management capabilities with support for large files (GB scale) through resumable multipart uploads.

#### Initialize Resumable Upload

`POST /api/storage/objects/upload/init`

**Requires Authentication** - Initialize a multipart upload for large files. Returns presigned URLs for direct-to-S3 uploads.

**Request Body:**
```json
{
  "name": "document.pdf",
  "size": 104857600,
  "mimeType": "application/pdf"
}
```

**Response:**
```json
{
  "data": {
    "objectId": "uuid",
    "uploadId": "s3-upload-id",
    "partSize": 10485760,
    "totalParts": 10,
    "presignedUrls": [
      { "partNumber": 1, "url": "https://..." },
      { "partNumber": 2, "url": "https://..." }
    ]
  }
}
```

---

#### Get Upload Status

`GET /api/storage/objects/:id/upload/status`

**Requires Authentication** - Check progress of an in-progress upload.

**Response:**
```json
{
  "data": {
    "status": "uploading",
    "uploadedParts": 5,
    "totalParts": 10,
    "progress": 50
  }
}
```

---

#### Complete Upload

`POST /api/storage/objects/:id/upload/complete`

**Requires Authentication** - Finalize multipart upload after all parts are uploaded.

**Request Body:**
```json
{
  "parts": [
    { "partNumber": 1, "eTag": "\"etag1\"" },
    { "partNumber": 2, "eTag": "\"etag2\"" }
  ]
}
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "processing"
  }
}
```

---

#### Abort Upload

`DELETE /api/storage/objects/:id/upload/abort`

**Requires Authentication** - Cancel an in-progress upload and clean up resources.

**Response:** HTTP 204 No Content

---

#### Simple Upload

`POST /api/storage/objects`

**Requires Authentication** - Direct upload for small files (< 100MB) using multipart/form-data.

**Request:**
- Content-Type: `multipart/form-data`
- Body: File attached as form data with key `file`

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 1048576,
    "mimeType": "application/pdf",
    "status": "uploading"
  }
}
```

---

#### List Objects

`GET /api/storage/objects`

**Requires Authentication** - List storage objects with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | Filter by status: `pending`, `uploading`, `processing`, `ready`, `failed` |
| `sortBy` | enum | `createdAt` | Sort field: `createdAt`, `name`, `size` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "document.pdf",
      "size": 104857600,
      "mimeType": "application/pdf",
      "status": "ready",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

---

#### Get Object

`GET /api/storage/objects/:id`

**Requires Authentication** - Get storage object metadata.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "ready",
    "metadata": {
      "customField": "value"
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

#### Get Download URL

`GET /api/storage/objects/:id/download`

**Requires Authentication** - Get a signed download URL for the object.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds |

**Response:**
```json
{
  "data": {
    "url": "https://s3.amazonaws.com/...",
    "expiresAt": "2024-01-01T01:00:00.000Z"
  }
}
```

---

#### Delete Object

`DELETE /api/storage/objects/:id`

**Requires Authentication** - Delete a storage object and its associated file.

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Object not found
- 403 Forbidden - User does not own object (non-admin)

---

#### Update Metadata

`PATCH /api/storage/objects/:id/metadata`

**Requires Authentication** - Update custom metadata for an object.

**Request Body:**
```json
{
  "metadata": {
    "customField": "value",
    "tags": ["document", "important"]
  }
}
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "metadata": {
      "customField": "value",
      "tags": ["document", "important"]
    },
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### Media

Media endpoints register uploaded `StorageObject` blobs as `MediaItem` records in the library and provide list/get/update/delete access to those records. All media endpoints require `media:read` or `media:write` permission. Admins holding `media:read_any` can read all users' items; `media:write_any` and `media:delete_any` extend that to mutations.

**Circle scope is required on all media endpoints.** Create and list endpoints require an explicit `circleId`. The caller must be a member of that circle with at least `viewer` (reads) or `collaborator` (writes) role. Item-level endpoints (GET/PATCH/DELETE by ID) derive the circle from the loaded resource — the caller does not pass `circleId` for those.

#### POST /api/media

**Requires:** `media:write` permission + `collaborator` role in the target circle

Register an uploaded `StorageObject` as a `MediaItem`.

**Idempotent deduplication behavior:** When `contentHash` is supplied the server checks for an existing non-deleted `MediaItem` with the same `(circleId, contentHash)` tuple. If one exists the redundant `StorageObject` blob is deleted best-effort and the **existing** item is returned. A concurrent registration of the same hash (race condition) is caught via the database partial unique index on `(circle_id, content_hash)` — the server fetches the winning row, cleans up the redundant blob, and returns the winner. The `deduplicated` field in the response indicates which path was taken.

| HTTP Status | Meaning |
|-------------|---------|
| `201 Created` | Fresh item created (`deduplicated: false`) |
| `200 OK` | Duplicate detected — existing item returned (`deduplicated: true`) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | **Yes** | Circle to add this item to. Caller must be a `collaborator` or `circle_admin` in this circle. |
| `storageObjectId` | UUID | Yes | ID of an already-uploaded `StorageObject` |
| `type` | `"photo"` \| `"video"` | Yes | Media type |
| `source` | `"web"` \| `"cli"` \| `"android"` \| `"import"` \| `"sync"` | Yes | Upload origin |
| `originalFilename` | string (1–1024 chars) | Yes | Original file name |
| `contentHash` | string (64 lowercase hex chars) | No | SHA-256 hex digest of the file bytes. When supplied the server deduplicates by `(circleId, contentHash)`. |
| `capturedAt` | ISO 8601 datetime | No | When the photo/video was taken |
| `capturedAtOffset` | integer (minutes) | No | UTC offset of `capturedAt` |
| `classification` | `"memory"` \| `"low_value"` \| `"unreviewed"` | No | Defaults to `"unreviewed"` |
| `title` | string (max 512) | No | |
| `caption` | string (max 2048) | No | |
| `description` | string (max 8192) | No | |
| `favorite` | boolean | No | Defaults to `false` |
| `metadata` | object | No | Arbitrary JSONB metadata |
| `originalCreatedAt` | ISO 8601 datetime | No | File system creation time |
| `sourcePath` | string (max 2048) | No | Original path on source device |
| `sourceDeviceId` | string (max 256) | No | |
| `sourceDeviceName` | string (max 256) | No | |

**Example request (with dedup hash):**

```json
{
  "storageObjectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "photo",
  "source": "web",
  "originalFilename": "IMG_4521.jpg",
  "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

**Response (201 — fresh create):**

```json
{
  "id": "uuid",
  "circleId": "uuid",
  "addedById": "uuid",
  "storageObjectId": "uuid",
  "type": "photo",
  "source": "web",
  "originalFilename": "IMG_4521.jpg",
  "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "classification": "unreviewed",
  "favorite": false,
  "importedAt": "2026-06-12T10:00:00.000Z",
  "deduplicated": false
}
```

**Response (200 — dedup hit):**

Same shape as above but `deduplicated: true`. The returned item is the **existing** item already in the library; the `storageObjectId` in the response will differ from the one in the request.

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 400 | `storageObjectId` is already linked to another `MediaItem` |
| 403 | Caller does not own the referenced `StorageObject` |
| 404 | `StorageObject` not found |

---

#### GET /api/media

**Requires:** `media:read` permission + `viewer` role in the target circle

List active (non-deleted) media items for a circle. Admins holding `media:read_any` may omit `circleId` to query across all circles, but should normally scope to a specific circle.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `circleId` | UUID | **required** | Circle to query (caller must be a viewer or higher) |
| `page` | number | 1 | Page number (1-indexed) |
| `pageSize` | number | 20 | Items per page (max 100) |
| `type` | `"photo"` \| `"video"` | — | Filter by media type |
| `capturedAtFrom` | ISO 8601 datetime | — | Lower bound on `capturedAt` |
| `capturedAtTo` | ISO 8601 datetime | — | Upper bound on `capturedAt` |
| `classification` | enum | — | `memory`, `low_value`, or `unreviewed` |
| `albumId` | UUID | — | Return items in this album |
| `favorite` | boolean | — | Filter by favorite flag |
| `tag` | string | — | Exact tag name match (case-insensitive) |
| `country` | string | — | Matches `geoCountry` (contains) or `geoCountryCode` (exact) |
| `region` | string | — | Substring match on `geoAdmin1` |
| `locality` | string | — | Substring match on `geoLocality` |
| `place` | string | — | Substring match on `geoPlaceName` |
| `location` | string | — | Free-text match across all geo tiers |
| `contentHash` | string (64 hex chars) | — | Return the item matching this exact SHA-256 hash. Used as a deduplication pre-check: if the response contains at least one item the file is already in the library and the upload can be skipped. |
| `cameraMake` | string | — | Substring match on `cameraMake`, case-insensitive |
| `cameraModel` | string | — | Substring match on `cameraModel`, case-insensitive |
| `sourceDeviceId` | string | — | Exact match on `sourceDeviceId` |
| `sourceDeviceName` | string | — | Substring match on `sourceDeviceName`, case-insensitive |
| `missingGeo` | boolean | — | `true` = items with no GPS (`takenLat IS NULL`); `false` = items with GPS |
| `sortBy` | enum | `capturedAt` | `capturedAt`, `importedAt`, or `createdAt` |
| `sortOrder` | enum | `desc` | `asc` or `desc` |

**Deduplication pre-check usage:**

Before uploading, clients should query:

```
GET /api/media?circleId=<uuid>&contentHash=<sha256>&pageSize=1
```

If `items.length > 0` the file already exists in that circle and the upload can be skipped entirely. This saves both bandwidth and storage. The web upload dialog and the CLI sync engine both perform this check. Note that dedup is scoped to the circle: the same file may exist in two different circles.

**Response:**

```json
{
  "items": [
    {
      "id": "uuid",
      "circleId": "uuid",
      "addedById": "uuid",
      "type": "photo",
      "originalFilename": "IMG_4521.jpg",
      "contentHash": "e3b0c44298fc1c149afbf4c8996fb924...",
      "classification": "unreviewed",
      "capturedAt": "2024-07-15T14:30:00.000Z",
      "importedAt": "2026-06-12T10:00:00.000Z",
      "thumbnailUrl": "https://...",
      "favorite": false
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 142,
    "totalPages": 8
  }
}
```

---

#### GET /api/media/:id

**Requires:** `media:read` permission + `viewer` role in the item's circle

Get a single `MediaItem` by ID. Returns fresh signed URLs for the thumbnail and the original blob, plus the item's tag names.

**Response:**

```json
{
  "id": "uuid",
  "circleId": "uuid",
  "addedById": "uuid",
  "type": "photo",
  "originalFilename": "IMG_4521.jpg",
  "contentHash": "e3b0c44298fc1c149afbf4c8996fb924...",
  "capturedAt": "2024-07-15T14:30:00.000Z",
  "importedAt": "2026-06-12T10:00:00.000Z",
  "classification": "memory",
  "favorite": false,
  "tags": ["vacation", "summer"],
  "thumbnailUrl": "https://s3.amazonaws.com/...",
  "downloadUrl": "https://s3.amazonaws.com/..."
}
```

`tags` is a flat array of tag name strings. The array is empty (`[]`) when no tags are attached.

**Error Cases:**
- 404 Not Found — item does not exist or is soft-deleted
- 403 Forbidden — caller is not a member of the item's circle and lacks `media:read_any`

---

#### PATCH /api/media/:id

**Requires:** `media:write` permission

Update mutable fields on a `MediaItem`. Only supplied fields are updated.

**Mutable fields:** `capturedAt`, `capturedAtOffset`, `classification`, `metadata`, `title`, `caption`, `description`, `favorite`.

**Error Cases:**
- 404 Not Found
- 403 Forbidden

---

#### DELETE /api/media/:id

**Requires:** `media:delete` permission

Soft-delete a `MediaItem`. Sets `deletedAt`; does not remove the underlying `StorageObject` or blob.

**Response:** HTTP 204 No Content

**Note:** A soft-deleted item is excluded from `GET /api/media` results and from the dedup unique index, so the same content hash can be re-imported after deletion.

---

#### GET /api/media/geo/reverse

**Requires:** `media:read` permission

Reverse geocode a coordinate pair on demand. Uses the offline provider configured by `GEO_PROVIDER` (default `offline`). GPS coordinates are never sent to external services when the offline provider is active.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lat` | number | Yes | Latitude (-90 to 90) |
| `lng` | number | Yes | Longitude (-180 to 180) |

**Response:**

```json
{
  "country": "Costa Rica",
  "countryCode": "CR",
  "admin1": "San José",
  "admin2": null,
  "locality": "San José",
  "placeName": "San José, San José, Costa Rica"
}
```

Returns `null` if no result is found for the given coordinates.

**Error Cases:**
- 401 Unauthorized — missing or expired JWT
- 403 Forbidden — caller lacks `media:read` permission

---

#### GET /api/media/geo/search

**Requires:** `media:read` permission

Forward geocode — search places by typed name. Supports real street addresses when `GEO_FORWARD_PROVIDER=google`. **Disabled by default** (`GEO_FORWARD_SEARCH_ENABLED=false`). When disabled the endpoint returns 503.

**Privacy note:** Only the typed place name query leaves the server — photo GPS coordinates are never sent by this endpoint. Provider is selected by `GEO_FORWARD_PROVIDER` (default `nominatim`). When `google` is selected, the typed query is sent to Google Maps Geocoding API; `GOOGLE_MAPS_API_KEY` is required (server-side only). If the key is absent the service falls back to Nominatim automatically.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | — | Place name to search |
| `limit` | number | No | 5 | Max results (1–20) |

**Response (200 — enabled):**

```json
[
  {
    "lat": 9.9281,
    "lng": -84.0907,
    "label": "San José, Costa Rica"
  }
]
```

**Error Cases:**
- 503 Service Unavailable — `GEO_FORWARD_SEARCH_ENABLED` is `false`
- 401 Unauthorized — missing or expired JWT

---

#### GET /api/media/dashboard

**Requires:** `media:read` permission + `viewer` role in the target circle

Returns aggregated dashboard data for a circle: On This Day (same month/day across all years), recent uploads, favorites, and review-queue counts.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to aggregate (caller must be a viewer or higher) |

**Response:**

```json
{
  "onThisDay": [
    {
      "id": "uuid",
      "type": "photo",
      "capturedAt": "2022-07-15T14:30:00.000Z",
      "thumbnailUrl": "https://...",
      "..."
    }
  ],
  "recent": [ /* up to 12 most recently imported items */ ],
  "favorites": [ /* up to 12 favorited items ordered by capturedAt desc */ ],
  "counts": {
    "total": 1842,
    "unreviewed": 304,
    "lowValue": 92,
    "missingGeo": 517
  }
}
```

**Response fields:**

| Field | Description |
|-------|-------------|
| `onThisDay` | Up to 24 items where `MONTH(capturedAt) = today_month AND DAY(capturedAt) = today_day` across all years, ordered `capturedAt DESC`. Uses the functional index `media_items_captured_md_idx`. |
| `recent` | Up to 12 items ordered by `importedAt DESC` |
| `favorites` | Up to 12 favorited items ordered by `capturedAt DESC` |
| `counts.total` | Non-deleted items in the circle |
| `counts.unreviewed` | Items with `classification = 'unreviewed'` |
| `counts.lowValue` | Items with `classification = 'low_value'` |
| `counts.missingGeo` | Items with `takenLat IS NULL` |

All items include a freshly signed `thumbnailUrl`.

**Error Cases:**
- 403 Forbidden — caller is not a member of the circle
- 404 Not Found — circle does not exist

---

#### GET /api/media/explore/places

**Requires:** `media:read` permission + `viewer` role in the target circle

Return a summary of distinct geographic places represented in a circle, ordered by item count descending. Used by the Explore section of the UI to show a browsable grid of places.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to aggregate (caller must be a viewer or higher) |

**Response:**

```json
[
  {
    "name": "San José, Costa Rica",
    "count": 312,
    "coverThumbnailUrl": "https://s3.amazonaws.com/..."
  },
  {
    "name": "New York, United States",
    "count": 88,
    "coverThumbnailUrl": "https://s3.amazonaws.com/..."
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Reverse-geocoded place name (typically `geoPlaceName`) |
| `count` | number | Number of media items at this place |
| `coverThumbnailUrl` | string \| null | Signed thumbnail URL from a representative item |

**Error Cases:**
- 403 Forbidden — caller is not a member of the circle

---

#### GET /api/media/explore/tags

**Requires:** `media:read` permission + `viewer` role in the target circle

Return a summary of tags used in a circle, ordered by item count descending. Used by the Explore section of the UI to show a browsable grid of tags.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to aggregate (caller must be a viewer or higher) |

**Response:**

```json
[
  {
    "name": "vacation",
    "count": 204,
    "coverThumbnailUrl": "https://s3.amazonaws.com/..."
  },
  {
    "name": "family",
    "count": 155,
    "coverThumbnailUrl": null
  }
]
```

Same response shape as `/explore/places`. `coverThumbnailUrl` is null when no tagged item has a processable thumbnail.

**Error Cases:**
- 403 Forbidden — caller is not a member of the circle

---

#### PATCH /api/media/bulk

**Requires:** `media:write` permission + `collaborator` role in the target circle

Bulk update location, classification, or favorite flag on up to 500 media items in a single operation. All IDs must belong to the specified circle and must not be soft-deleted; any mismatch returns 404 without updating any items.

When `set.location` contains coordinates, the server immediately performs an on-demand reverse geocode using the configured provider and overwrites all geo columns (`geoCountry`, `geoAdmin1`, `geoLocality`, etc.) with `geoSource = 'manual'`. When `set.location` is explicitly `null`, all geo columns and coordinates are cleared.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle that owns all IDs |
| `ids` | UUID[] | Yes | 1–500 MediaItem IDs |
| `set` | object | Yes | Fields to update (at least one required) |
| `set.location` | `{lat, lng, altitude?}` \| `null` | No | Set (reverse-geocodes) or clear (`null`) GPS + geo columns |
| `set.location.lat` | number | Conditional | -90 to 90 |
| `set.location.lng` | number | Conditional | -180 to 180 |
| `set.location.altitude` | number | No | Altitude in metres |
| `set.classification` | `"memory"` \| `"low_value"` \| `"unreviewed"` | No | New classification |
| `set.favorite` | boolean | No | New favorite flag |

**Example request:**

```json
{
  "circleId": "a1b2c3d4-...",
  "ids": ["uuid-1", "uuid-2", "uuid-3"],
  "set": {
    "location": { "lat": 9.9281, "lng": -84.0907 },
    "classification": "memory"
  }
}
```

**Response:**

```json
{ "updated": 3 }
```

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 400 | `set` is empty; `ids` empty or > 500; invalid lat/lng |
| 403 | Caller lacks `media:write` or is not a `collaborator` in the circle |
| 404 | Any ID not found, soft-deleted, or in a different circle |

---

#### POST /api/media/bulk/tags

**Requires:** `media:write` permission + `collaborator` role in the target circle

Add and/or remove tags on up to 500 media items atomically. All IDs are verified against the circle before any writes. Tag names are matched case-sensitively; tags are created if they do not exist (idempotent per `(circleId, name)`). At least one of `add` or `remove` must be non-empty.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle that owns all IDs |
| `ids` | UUID[] | Yes | 1–500 MediaItem IDs |
| `add` | string[] | No | Tag names to attach (max 128 chars each) |
| `remove` | string[] | No | Tag names to detach |

**Example request:**

```json
{
  "circleId": "a1b2c3d4-...",
  "ids": ["uuid-1", "uuid-2"],
  "add": ["vacation", "summer"],
  "remove": ["untagged"]
}
```

**Response:**

```json
{ "added": 4, "removed": 2 }
```

`added` is the count of new `MediaTag` join rows created (skips duplicates). `removed` is the count of `MediaTag` rows deleted.

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 400 | Both `add` and `remove` are empty; `ids` empty or > 500 |
| 403 | Caller lacks `media:write` or is not a `collaborator` in the circle |
| 404 | Any ID not found, soft-deleted, or in a different circle |

---

#### POST /api/media/bulk/delete

**Requires:** `media:delete` permission + `collaborator` role in the target circle

Soft-delete up to 500 media items in a single operation. Sets `deletedAt` on each item; underlying `StorageObject` blobs are preserved. All IDs must be non-deleted members of the circle; any mismatch returns 404 without deleting any items.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle that owns all IDs |
| `ids` | UUID[] | Yes | 1–500 MediaItem IDs |

**Response:**

```json
{ "deleted": 3 }
```

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 400 | `ids` empty or > 500 |
| 403 | Caller lacks `media:delete` or is not a `collaborator` in the circle |
| 404 | Any ID not found, soft-deleted, or in a different circle |

---

#### GET /api/media/locations

**Requires:** `media:read` permission

Return all of the caller's geotagged, non-deleted media items as a flat array — no pagination. This endpoint is the data source for the `/map` clustered map view. Admins holding `media:read_any` see all users' items.

Only items with non-null `takenLat` **and** `takenLng` are included. `thumbnailUrl` is a freshly-signed S3 URL generated at response time (the same `signThumb` helper used by `GET /api/media`).

The route is registered before `GET /api/media/:id` in the controller so that the literal path segment `locations` is never treated as a UUID parameter.

**Query Parameters** (all optional — same geo/date/type filters as `GET /api/media`):

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | `"photo"` \| `"video"` | Filter by media type |
| `capturedAtFrom` | ISO 8601 datetime | Lower bound on `capturedAt` |
| `capturedAtTo` | ISO 8601 datetime | Upper bound on `capturedAt` |
| `country` | string | Matches `geoCountry` (contains) or `geoCountryCode` (exact), case-insensitive |
| `region` | string | Substring match on `geoAdmin1`, case-insensitive |
| `locality` | string | Substring match on `geoLocality`, case-insensitive |
| `place` | string | Substring match on `geoPlaceName`, case-insensitive |
| `location` | string | Free-text search across all geo tiers |

**Response:** Array of location objects.

```json
[
  {
    "id": "uuid",
    "takenLat": 9.9281,
    "takenLng": -84.0907,
    "capturedAt": "2024-07-15T14:30:00.000Z",
    "geoLocality": "San José",
    "thumbnailUrl": "https://s3.amazonaws.com/..."
  }
]
```

**Response item fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | `MediaItem` identifier |
| `takenLat` | number | GPS latitude (always non-null) |
| `takenLng` | number | GPS longitude (always non-null) |
| `capturedAt` | ISO 8601 datetime \| null | When the photo/video was taken |
| `geoLocality` | string \| null | Reverse-geocoded city/locality name |
| `thumbnailUrl` | string \| null | Fresh signed S3 URL for the thumbnail |

**Error Cases:**
- 401 Unauthorized — missing or expired JWT
- 403 Forbidden — caller lacks `media:read` permission

**DTO source:** `apps/api/src/media/dto/media-locations-query.dto.ts`
**Service method:** `MediaService.listLocations`

---

### Media — Albums (media:read / media:write / media:delete)

Albums are circle-scoped named collections of `MediaItem` records. An album does not own its items — deleting an album removes the membership join rows only; the underlying `MediaItem` records are preserved. All album endpoints derive circle membership from the album's `circleId`; the caller must be a member of that circle with at least `viewer` (reads) or `collaborator` (writes/deletes).

---

#### GET /api/media/albums

**Requires:** `media:read` permission + `viewer` role in the target circle

List albums in a circle, paginated.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `circleId` | UUID | Yes | — | Circle to list albums for |
| `page` | number | No | 1 | Page number (1-indexed) |
| `pageSize` | number | No | 20 | Items per page (1–100) |
| `sortBy` | enum | No | `createdAt` | Sort field: `name`, `createdAt`, `updatedAt` |
| `sortOrder` | enum | No | `desc` | `asc` or `desc` |

**Example response:**

```json
{
  "items": [
    {
      "id": "uuid",
      "circleId": "uuid",
      "addedById": "uuid",
      "name": "Summer 2024",
      "description": "Beach trip photos",
      "createdAt": "2024-08-01T10:00:00.000Z",
      "updatedAt": "2024-08-15T12:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 5,
    "totalPages": 1
  }
}
```

**Error Cases:**
- 403 Forbidden — caller is not a member of the circle
- 404 Not Found — circle does not exist

---

#### POST /api/media/albums

**Requires:** `media:write` permission + `collaborator` role in the target circle

Create a new album.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to create the album in |
| `name` | string (1–256 chars) | Yes | Album name |
| `description` | string (max 2048 chars) | No | Optional album description |

**Example request:**

```json
{
  "circleId": "a1b2c3d4-...",
  "name": "Summer 2024",
  "description": "Beach trip photos"
}
```

**Example response (201 Created):**

```json
{
  "id": "uuid",
  "circleId": "uuid",
  "addedById": "uuid",
  "name": "Summer 2024",
  "description": "Beach trip photos",
  "createdAt": "2024-08-01T10:00:00.000Z",
  "updatedAt": "2024-08-01T10:00:00.000Z"
}
```

**Error Cases:**
- 400 Bad Request — validation error (name missing or too long, invalid circleId)
- 403 Forbidden — caller is not a `collaborator` in the circle

---

#### GET /api/media/albums/:id

**Requires:** `media:read` permission + `viewer` role in the album's circle

Get a single album with its item list. Items are ordered by `addedAt` ascending.

**Path Parameter:** `id` — Album UUID

**Response:**

```json
{
  "id": "uuid",
  "circleId": "uuid",
  "addedById": "uuid",
  "name": "Summer 2024",
  "description": "Beach trip photos",
  "createdAt": "2024-08-01T10:00:00.000Z",
  "updatedAt": "2024-08-15T12:00:00.000Z",
  "items": [
    {
      "id": "uuid",
      "albumId": "uuid",
      "mediaItemId": "uuid",
      "addedAt": "2024-08-02T09:00:00.000Z",
      "mediaItem": {
        "id": "uuid",
        "type": "photo",
        "originalFilename": "IMG_4521.jpg",
        "capturedAt": "2024-07-15T14:30:00.000Z",
        "thumbnailUrl": "https://s3.amazonaws.com/..."
      }
    }
  ]
}
```

**Error Cases:**
- 403 Forbidden — caller is not a member of the album's circle
- 404 Not Found — album does not exist

---

#### PATCH /api/media/albums/:id

**Requires:** `media:write` permission + `collaborator` role in the album's circle

Rename or update the description of an album. Only supplied fields are changed. Pass `description: null` to clear the description.

**Path Parameter:** `id` — Album UUID

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string (1–256 chars) | No | New album name |
| `description` | string (max 2048 chars) \| null | No | New description; `null` clears it |

**Response 200:** Updated album object (same shape as POST response, without `items`).

**Error Cases:**
- 403 Forbidden — caller is not a `collaborator` in the album's circle
- 404 Not Found — album does not exist

---

#### DELETE /api/media/albums/:id

**Requires:** `media:delete` permission + `collaborator` role in the album's circle

Delete an album. Cascades to `album_items` join rows; the underlying `MediaItem` records are NOT deleted.

**Path Parameter:** `id` — Album UUID

**Response:** HTTP 204 No Content

**Error Cases:**
- 403 Forbidden — caller is not a `collaborator` in the album's circle
- 404 Not Found — album does not exist

---

#### POST /api/media/albums/:id/items

**Requires:** `media:write` permission + `collaborator` role in the album's circle

Add up to 500 specific media items to an album. Items already in the album are skipped (insert is idempotent with `skipDuplicates`). All supplied `mediaItemIds` must belong to the same circle as the album.

**Path Parameter:** `id` — Album UUID

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mediaItemIds` | UUID[] (1–500) | Yes | IDs of `MediaItem` records to add |

**Example request:**

```json
{
  "mediaItemIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

**Response 201:**

```json
{ "added": 3 }
```

`added` is the count of new `AlbumItem` join rows created (duplicates are skipped without error).

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 400 | `mediaItemIds` is empty or contains more than 500 entries |
| 403 | Caller is not a `collaborator` in the album's circle |
| 404 | Album not found, or one or more `mediaItemIds` do not exist in the circle |

---

#### DELETE /api/media/albums/:id/items/:itemId

**Requires:** `media:write` permission + `collaborator` role in the album's circle

Remove a single media item from an album. The `MediaItem` record itself is not deleted.

**Path Parameters:**
- `id` — Album UUID
- `itemId` — The `MediaItem` UUID to remove (not the `AlbumItem` join-row UUID)

**Response:** HTTP 204 No Content

**Error Cases:**
- 403 Forbidden — caller is not a `collaborator` in the album's circle
- 404 Not Found — album not found, or item is not in the album

---

#### POST /api/media/albums/:id/items/by-filter

**Requires:** `media:write` permission + `collaborator` role in the album's circle

Add all media items matching a set of filters to an album in a single operation. Uses the same filter semantics as `GET /api/media` (minus pagination and sort parameters). Items already in the album are skipped (`skipDuplicates`). `circleId` is required in the body and must match the album's circle.

This endpoint is useful for bulk-populating an album from a date range, tag, location, or any combination of the standard media filters.

**Path Parameter:** `id` — Album UUID

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Must match the album's circle |
| `type` | `"photo"` \| `"video"` | No | Filter by media type |
| `capturedAtFrom` | ISO 8601 datetime | No | Lower bound on `capturedAt` |
| `capturedAtTo` | ISO 8601 datetime | No | Upper bound on `capturedAt` |
| `classification` | `"memory"` \| `"low_value"` \| `"unreviewed"` | No | Filter by classification |
| `favorite` | boolean | No | Filter by favorite flag |
| `tag` | string | No | Exact tag name match (case-insensitive) |
| `country` | string | No | Matches `geoCountry` (contains) or `geoCountryCode` (exact) |
| `region` | string | No | Substring match on `geoAdmin1` |
| `locality` | string | No | Substring match on `geoLocality` |
| `place` | string | No | Substring match on `geoPlaceName` |
| `location` | string | No | Free-text search across all geo tiers |
| `cameraMake` | string | No | Substring match on `cameraMake`, case-insensitive |
| `cameraModel` | string | No | Substring match on `cameraModel`, case-insensitive |
| `sourceDeviceId` | string | No | Exact match on `sourceDeviceId` |
| `sourceDeviceName` | string | No | Substring match on `sourceDeviceName`, case-insensitive |
| `personId` | UUID | No | Items containing faces assigned to this person |
| `personIds` | UUID[] | No | Comma-separated or repeated; combined with `peopleMatch` |
| `peopleMatch` | `"any"` \| `"all"` | No | Match mode for `personIds` (default: `any`) |
| `missingGeo` | boolean | No | `true` = items with no GPS; `false` = items with GPS |

**Example request (add all photos from July 2024 tagged "vacation"):**

```json
{
  "circleId": "a1b2c3d4-...",
  "capturedAtFrom": "2024-07-01T00:00:00.000Z",
  "capturedAtTo": "2024-07-31T23:59:59.999Z",
  "tag": "vacation",
  "type": "photo"
}
```

**Response 200:**

```json
{ "added": 47 }
```

`added` is the count of new `AlbumItem` rows inserted. Items already in the album do not count toward this total.

**Error Cases:**

| Status | Condition |
|--------|-----------|
| 403 | Caller is not a `collaborator` in the album's circle |
| 404 | Album not found |

---

### Health

**Public endpoints** - Used for Kubernetes liveness/readiness probes.

#### GET /health
Full health check - includes database connectivity test. Equivalent to GET /health/ready.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

#### GET /health/live
Liveness check - always returns 200 if service is running.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

#### GET /health/ready
Readiness check - includes database connectivity test.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

## Family Circles

### Circle-Scoped Media Note

All media, album, and tag endpoints now require a `circleId` to scope queries:
- **List endpoints** (`GET /media`, `/albums`, `/tags`, `/locations`, `/export`): `circleId` is a required query parameter
- **Create endpoints** (`POST /media`, `/albums`): `circleId` is a required body field
- **Item endpoints** (`GET/PATCH/DELETE /media/:id`, etc.): derive the circle from the loaded resource — callers do not need to pass `circleId`

The `circleId` must be a circle the caller is a member of (minimum `viewer` for reads, `collaborator` for writes).

---

### Circles CRUD

#### POST /circles
**Requires:** `circles:write` permission

Create a new circle.

**Request Body:**
```json
{
  "name": "Smith Family",
  "description": "Photos for the whole family"
}
```

**Response 201:**
```json
{
  "id": "uuid",
  "name": "Smith Family",
  "description": "Photos for the whole family",
  "ownerId": "uuid",
  "isPersonal": false,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

---

#### GET /circles
**Requires:** `circles:read` permission

List circles the caller belongs to. Admins may pass `?all=true` to list all circles in the system.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `all` | boolean | Admin-only: return all circles across all users |

**Response 200:** Array of circle objects

---

#### GET /circles/:id
**Requires:** `circles:read` + viewer membership (or super-admin)

**Response 200:** Circle object with member count

**Error Cases:**
- 403 - Not a member of this circle
- 404 - Circle not found

---

#### PATCH /circles/:id
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

**Request Body:** Partial circle fields (`name`, `description`)

**Response 200:** Updated circle object

---

#### DELETE /circles/:id
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

Cannot delete a personal circle (`isPersonal: true`).

**Response 204 No Content**

**Error Cases:**
- 400 - Cannot delete a personal circle

---

### Circle Members

#### GET /circles/:id/members
**Requires:** `circles:read` + viewer membership (or super-admin)

**Response 200:** Array of `{ id, circleId, userId, role, createdAt, updatedAt, user: { id, email, displayName } }`

---

#### POST /circles/:id/members
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

Add an existing registered user by ID.

**Request Body:**
```json
{
  "userId": "uuid",
  "role": "collaborator"
}
```
`role` must be `circle_admin`, `collaborator`, or `viewer`.

**Response 201:** Created member object

---

#### PATCH /circles/:id/members/:userId
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

Change a member's per-circle role.

**Request Body:**
```json
{
  "role": "viewer"
}
```

**Response 200:** Updated member object

**Error Cases:**
- 400 - Cannot demote the last circle_admin

---

#### DELETE /circles/:id/members/:userId
**Requires:** `circles:read` + (circle_admin OR caller === :userId)

Remove a member, or self-leave the circle.

**Response 204 No Content**

**Error Cases:**
- 400 - Cannot remove the last circle_admin (use delete circle instead)

---

### Circle Invites

#### GET /circles/:id/invites
**Requires:** `circles:read` + `circle_admin` membership (or super-admin)

**Response 200:** Array of invite objects

---

#### POST /circles/:id/invites
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

Create an invite and automatically upsert the email into the application allowlist.

**Request Body:**
```json
{
  "email": "family@example.com",
  "role": "collaborator",
  "notes": "Cousin joining the family circle"
}
```

**Response 201:** Invite object `{ id, circleId, email, role, addedById, addedAt, claimedById, claimedAt, notes }`

**Side effect:** The email is upserted into `allowed_emails` so the invitee can log in. If the invitee is already a registered user, they are immediately added as a member (invite is auto-claimed).

---

#### DELETE /circles/:id/invites/:inviteId
**Requires:** `circles:write` + `circle_admin` membership (or super-admin)

Revoke a pending invite. Cannot revoke a claimed invite.

**Response 204 No Content**

**Error Cases:**
- 400 - Cannot revoke a claimed invite
- 404 - Invite not found in this circle

---

## Admin: Backup

All backup endpoints require the global `admin` role and `backup:run` or `backup:read` permission.

#### POST /admin/backup
**Requires:** Admin role + `backup:run` permission

Trigger a local-drive replication job. Copies ready `MediaItem` blobs from S3 to `BACKUP_LOCAL_PATH`. Writes a per-circle manifest alongside the blobs.

**Request Body:**
```json
{
  "circleId": "uuid"
}
```
Omit `circleId` to back up all circles.

**Response 200:**
```json
{
  "runId": "audit-event-uuid",
  "status": "started",
  "circleId": "uuid | null",
  "startedAt": "ISO8601"
}
```

---

#### GET /admin/backup/runs
#### GET /admin/backup/status
**Requires:** Admin role + `backup:read` permission

List recent backup runs (sourced from `audit_events`).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Number of runs to return |

**Response 200:** Array of run summary objects

---

#### GET /admin/backup/runs/:runId
**Requires:** Admin role + `backup:read` permission

Get the status and result of a specific backup run.

**Response 200:** Run detail object including item count, errors, and timing

---

#### GET /admin/backup/objects
**Requires:** Admin role + `backup:read` permission

List media objects available for backup, each with a signed download URL.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `circleId` | uuid (optional) | Filter to one circle |

**Response 200:** Array of `{ storageKey, downloadUrl, mediaItemId, circleId, size }`

---

## Admin: Job Queue

All job queue endpoints require the global `admin` role. Read endpoints additionally require `jobs:read`; mutating endpoints require `jobs:write`. Both permissions are seeded to the Admin role in `prisma/seed.ts` (no migration required).

The queue backs `enrichment_jobs` — the generic async job table used by face detection and all future enrichment handlers. The frontend admin page at `/admin/jobs` provides a live view of the same data with auto-refresh every 5 seconds.

---

### GET /admin/jobs/stats

**Requires:** Admin role + `jobs:read` permission

Return aggregate counts for the entire enrichment queue.

**Response:**
```json
{
  "total": 1042,
  "byStatus": {
    "pending": 18,
    "running": 2,
    "succeeded": 1014,
    "failed": 8
  },
  "byType": [
    {
      "type": "face_detection",
      "pending": 18,
      "running": 2,
      "succeeded": 1014,
      "failed": 8,
      "total": 1042
    }
  ],
  "stuckRunning": 1
}
```

**Response fields:**

| Field | Description |
|-------|-------------|
| `total` | Total enrichment job rows across all statuses |
| `byStatus` | Counts keyed by `pending` / `running` / `succeeded` / `failed` |
| `byType` | Per-job-type breakdown with the same four status counts plus a `total`; sorted alphabetically by type |
| `stuckRunning` | Count of jobs with `status=running` and `startedAt` older than 10 minutes |

---

### GET /admin/jobs

**Requires:** Admin role + `jobs:read` permission

Paginated, filterable list of enrichment job rows. Ordered by `createdAt DESC`.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | enum | No | — | Filter by status: `pending` \| `running` \| `succeeded` \| `failed` |
| `type` | string | No | — | Filter by job type string (exact match) |
| `page` | number | No | 1 | Page number (1-indexed) |
| `pageSize` | number | No | 20 | Items per page (1–100) |

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "type": "face_detection",
      "status": "failed",
      "reason": "upload",
      "priority": 0,
      "mediaItemId": "uuid",
      "circleId": "uuid",
      "attempts": 3,
      "lastError": "Connection refused at http://compreface-core:3000",
      "providerKey": "compreface",
      "modelVersion": "compreface-arcface-mobilefacenet-128",
      "createdAt": "2026-06-17T10:00:00.000Z",
      "startedAt": "2026-06-17T10:01:00.000Z",
      "finishedAt": "2026-06-17T10:01:05.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 8,
    "totalPages": 1
  }
}
```

**Item fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Job identifier |
| `type` | string | Job type string (e.g. `face_detection`) |
| `status` | enum | `pending` \| `running` \| `succeeded` \| `failed` |
| `reason` | enum | Why the job was created: `upload` \| `rerun` \| `backfill` |
| `priority` | number | Scheduling priority (higher = picked sooner) |
| `mediaItemId` | UUID | Target media item |
| `circleId` | UUID | Circle the media item belongs to |
| `attempts` | number | Number of processing attempts made |
| `lastError` | string \| null | Error message from the most recent failure |
| `providerKey` | string \| null | Provider that processed or will process the job |
| `modelVersion` | string \| null | Model version used |
| `createdAt` | ISO 8601 | When the job was enqueued |
| `startedAt` | ISO 8601 \| null | When the most recent attempt started |
| `finishedAt` | ISO 8601 \| null | When the job last completed (success or failure) |

---

### POST /admin/jobs/:id/retry

**Requires:** Admin role + `jobs:write` permission

Reset a single failed or succeeded job to `pending` so the worker will re-process it. Resets `attempts` to 0 and clears `lastError`, `startedAt`, and `finishedAt`.

**Path Parameter:** `id` — enrichment job UUID

**Response 201:**
```json
{
  "id": "uuid",
  "type": "face_detection",
  "status": "pending",
  "attempts": 0,
  "lastError": null,
  "startedAt": null,
  "finishedAt": null,
  "..."
}
```

Returns the full updated job object (same shape as a list item).

**Error Cases:**
- 400 Bad Request — Job is currently `running` and cannot be retried
- 404 Not Found — Job does not exist

---

### POST /admin/jobs/retry-failed

**Requires:** Admin role + `jobs:write` permission

Bulk-reset all `failed` jobs to `pending`. Optionally scope to a specific job type. Resets `attempts` to 0 and clears `lastError`, `startedAt`, and `finishedAt` on all matched rows.

**Request Body (optional):**
```json
{
  "type": "face_detection"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Limit the retry to failed jobs of this type. Omit to retry all failed jobs regardless of type. |

**Response 201:**
```json
{ "retried": 8 }
```

`retried` is the count of jobs reset to `pending`.

---

### POST /admin/jobs/reset-stuck

**Requires:** Admin role + `jobs:write` permission

Reset `running` jobs whose `startedAt` is older than the specified threshold back to `pending`. This recovers jobs that crashed or were interrupted without updating their status. Does not reset `attempts`.

**Request Body (optional):**
```json
{
  "olderThanMinutes": 10
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `olderThanMinutes` | number (int ≥ 1) | No | 10 | Reset jobs stuck in `running` for longer than this many minutes |

**Response 201:**
```json
{ "reset": 1 }
```

`reset` is the count of jobs moved from `running` back to `pending`.

---

### DELETE /admin/jobs/:id

**Requires:** Admin role + `jobs:write` permission

Permanently delete an enrichment job row. Cannot delete a job that is currently `running`.

**Path Parameter:** `id` — enrichment job UUID

**Response 200:**
```json
{ "deleted": true }
```

**Error Cases:**
- 400 Bad Request — Job is currently `running`
- 404 Not Found — Job does not exist

---

## Admin: Storage Insights

All storage insights endpoints require the global `admin` role. Reading the latest snapshot additionally requires `system_settings:read`; triggering a refresh requires `system_settings:write`. No new permissions were added — the feature reuses the existing system settings permission pair.

Metrics are precomputed into a snapshot table and refreshed on a configurable schedule (default every 4 hours). The `storage.insights.refreshIntervalHours` system setting (integer, 1–168) controls the automatic refresh cadence; the cron fires every hour and **enqueues** a `storage_insights` enrichment job only when the configured interval has elapsed and no job is already pending/running. Computation runs asynchronously on the shared enrichment worker (MAX_ATTEMPTS=3; visible and retryable in the `/admin/jobs` dashboard).

---

### GET /admin/insights

**Requires:** Admin role + `system_settings:read` permission

Return the latest precomputed storage metrics snapshot plus a `refresh` object describing the current state of the enrichment job. If no snapshot has ever been computed (or the last compute failed and was pruned), returns the `empty` DTO.

**Request body:** none

**Response 200 (snapshot available, no job in flight):**
```json
{
  "status": "ready",
  "metrics": {
    "totalBytes": "128849018880",
    "photoBytes": "107374182400",
    "videoBytes": "21474836480",
    "totalItems": 4200,
    "photoCount": 4100,
    "videoCount": 100,
    "totalFaces": 9300,
    "taggedItems": 2100
  },
  "computedAt": "2026-06-20T08:00:00.000Z",
  "durationMs": 312,
  "refresh": {
    "state": "idle",
    "jobId": null,
    "lastError": null
  }
}
```

**Response 200 (snapshot available, refresh job running):**
```json
{
  "status": "ready",
  "metrics": { "...": "previous snapshot data" },
  "computedAt": "2026-06-20T08:00:00.000Z",
  "durationMs": 312,
  "refresh": {
    "state": "running",
    "jobId": "a1b2c3d4-...",
    "lastError": null
  }
}
```

**Response 200 (no snapshot):**
```json
{
  "status": "empty",
  "metrics": null,
  "computedAt": null,
  "durationMs": null,
  "refresh": {
    "state": "idle",
    "jobId": null,
    "lastError": null
  }
}
```

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `ready` — snapshot is available; `empty` — no ready snapshot exists |
| `metrics` | object \| null | Null when `status` is `empty`; see metrics fields below |
| `computedAt` | ISO 8601 \| null | When the snapshot was computed; null when `status` is `empty` |
| `durationMs` | number \| null | Wall-clock milliseconds the aggregation took; null when `status` is `empty` |
| `refresh` | object | In-flight enrichment job state; always present |
| `refresh.state` | enum | `idle` — no job in flight or job succeeded; `pending` — job queued; `running` — job being processed; `failed` — last job failed permanently |
| `refresh.jobId` | UUID \| null | ID of the active or most-recently-failed job; null when `state` is `idle` |
| `refresh.lastError` | string \| null | Error message from the most recent failure; null unless `state` is `failed` |

**Metrics fields:**

| Field | Type | Notes |
|-------|------|-------|
| `totalBytes` | string | Total bytes across all non-deleted media items; serialized as a string for BigInt safety |
| `photoBytes` | string | Bytes consumed by photos; string for BigInt safety |
| `videoBytes` | string | Bytes consumed by videos; string for BigInt safety |
| `totalItems` | number | Non-deleted photo + video count |
| `photoCount` | number | Non-deleted photo count |
| `videoCount` | number | Non-deleted video count |
| `totalFaces` | number | Total rows in the `faces` table across all circles |
| `taggedItems` | number | Non-deleted media items with at least one AI-assigned tag (`tag_count > 0`) |

**Notes:**
- Byte fields (`totalBytes`, `photoBytes`, `videoBytes`) are JSON **strings**, not numbers. Parse as `BigInt` for arithmetic; use a formatting utility for display.
- All item counts exclude soft-deleted media items (`deleted_at IS NULL`). `totalFaces` is the sole exception — the `faces` table has no soft-delete column.
- Byte totals reflect media storage (INNER JOIN `media_items → storage_objects`) and exclude orphan or in-progress upload objects that are not yet linked to a media item.
- The `refresh` object reflects the enrichment job row state. When `refresh.state` is `pending` or `running`, the snapshot data shown is from the previous successful compute — the page should poll until state becomes `idle` or `failed`.

---

### POST /admin/insights/refresh

**Requires:** Admin role + `system_settings:write` permission

Enqueue a `storage_insights` enrichment job at priority 0 (highest priority; pre-empts any scheduled job at priority 100) and return immediately. The aggregation runs asynchronously — the caller must poll `GET /admin/insights` and check `refresh.state` until it becomes `idle` (success) or `failed` (permanent failure after 3 attempts).

If a job is already pending or running, the existing job is returned (idempotent enqueue).

**Request body:** none (body-less)

**Response 201:**
```json
{
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "state": "pending"
}
```

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | UUID | ID of the enqueued (or already in-flight) enrichment job |
| `state` | string | `pending` or `running` — the job state at the time of this response |

**Polling pattern:**
```
POST /admin/insights/refresh → { jobId, state: "pending" }
GET  /admin/insights         → refresh.state === "running"  (still computing)
GET  /admin/insights         → refresh.state === "idle"     (done; metrics updated)
```

**Error Cases:**
- 500 Internal Server Error — Failed to enqueue the job (check API logs)

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | OK - Request successful |
| 201 | Created - Resource created successfully |
| 204 | No Content - Request successful, no response body |
| 400 | Bad Request - Invalid request format or validation error |
| 401 | Unauthorized - Missing or invalid authentication token |
| 403 | Forbidden - Insufficient permissions or user disabled |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Resource already exists or version mismatch (optimistic concurrency) |
| 500 | Internal Server Error - Server error occurred |
| 503 | Service Unavailable - Service temporarily unavailable |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_REQUIRED` | 401 | No valid authentication token provided |
| `INVALID_TOKEN` | 401 | JWT token is invalid or expired |
| `FORBIDDEN` | 403 | User does not have required permissions |
| `USER_DISABLED` | 403 | User account is disabled |
| `NOT_FOUND` | 404 | Requested resource not found |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Resource already exists or version mismatch |
| `NOT_AUTHORIZED` | 403 | Email not in allowlist |
| `VERSION_MISMATCH` | 409 | Optimistic concurrency conflict (If-Match header) |

---

## Rate Limits

> **Note:** Rate limiting is recommended for production deployments but is not currently implemented in the application. Consider adding `@nestjs/throttler` or Nginx rate limiting before production deployment.

**Recommended limits:**

| Endpoint Pattern | Recommended Limit | Window |
|------------------|-------------------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/allowlist` (POST) | 30 requests | 1 minute |
| `/api/system-settings` (PUT/PATCH) | 30 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

---

## Swagger/OpenAPI Documentation

Interactive API documentation with request/response examples is available at:

**Development:** http://localhost:3535/api/docs

The Swagger UI allows you to:
- Explore all endpoints
- View request/response schemas
- Test API calls directly from the browser
- Authenticate with JWT tokens

---

## CORS Policy

The API uses a **same-origin architecture**. Both the frontend and API are served from the same host (via Nginx reverse proxy):

- Frontend: `http://localhost:3535/`
- API: `http://localhost:3535/api`

This eliminates CORS complexity and improves security. No cross-origin requests are required.

---

## Security Headers

All API responses include security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Versioning

The API currently does not use versioning (v1, v2, etc.). Breaking changes will be avoided when possible. When breaking changes are necessary, they will be:

1. Announced in advance
2. Documented in migration guides
3. Implemented with a transition period when feasible

For future versions, the API may adopt URL-based versioning: `/api/v2/...`

---

## Face Recognition — Face Settings

All endpoints in this group require the Admin system role plus the listed permission. This group mirrors the [AI Settings](#ai-settings) group in structure and credential-handling approach. Only the settings API is active in Phase 1; detection, people management, and recognition endpoints ship in later phases.

**Provider abstraction:** The face domain supports pluggable providers via a `FaceProvider` interface. Three providers are shipped:

| Provider key | Type | Embeddings | Notes |
|---|---|---|---|
| `human` | Keyless in-process WASM (no external container) | 1024-d, owned by app | Runs in-process; no credentials needed. |
| `compreface` | Keyless core sidecar (default) | 128-d ArcFace mobilefacenet, owned by app | `compreface-core` container (no DB, no API key); API calls directly to `http://compreface-core:3000`. |
| `rekognition` | AWS managed (opt-in) | None returned | Delegated recognition — AWS performs matching against a gallery indexed by the app; only `externalFaceId` is stored. |

Adding a new provider requires implementing the `FaceProvider` interface and adding one registry entry.

**Credential encryption:** Face provider credentials are encrypted at rest using AES-256-GCM via the same `SECRETS_ENCRYPTION_KEY` used for AI provider credentials. The raw key is never returned — only `last4`.

---

### GET /face/settings

**Permission:** `face_settings:read`

Returns configured and known (unconfigured) face providers, per-provider capabilities, and the active detection feature configuration. Raw credentials are never returned — only `last4`.

**Response:**
```json
{
  "providers": [
    {
      "provider": "compreface",
      "configured": true,
      "enabled": true,
      "last4": null,
      "baseUrl": "http://compreface-core:3000",
      "updatedAt": "2026-06-17T10:00:00.000Z"
    }
  ],
  "knownProviders": [
    {
      "provider": "rekognition",
      "configured": false,
      "enabled": false,
      "last4": null,
      "baseUrl": null,
      "region": null
    }
  ],
  "capabilities": {
    "human": { "detect": true, "embed": true, "delegatedRecognize": false, "requiresCredentials": false },
    "compreface": { "detect": true, "embed": true, "delegatedRecognize": false, "requiresCredentials": false },
    "rekognition": { "detect": true, "embed": false, "delegatedRecognize": true }
  },
  "features": {
    "detection": { "provider": "compreface", "model": "compreface-arcface-mobilefacenet-128" }
  }
}
```

---

### PUT /face/credentials/:provider

**Permission:** `face_settings:write`

Upsert credentials for the given provider key. The API key (and region for Rekognition) is encrypted at rest with AES-256-GCM; the plaintext is never stored or returned.

**Path Parameter:** `provider` — `human` | `compreface` | `rekognition`

**Request Body:**
```json
{
  "apiKey": "...",
  "baseUrl": "http://compreface-core:3000",
  "region": "us-east-1",
  "enabled": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | No | Provider API key or secret. Not applicable for keyless providers (`human`, `compreface`). |
| `baseUrl` | string | No | Override default base URL. For `compreface` this is the only meaningful field; for `human` and `rekognition` it is not used. |
| `region` | string | No | AWS region (Rekognition only) |
| `enabled` | boolean | No | Enable or disable this provider (default: `true`) |

**Response:**
```json
{
  "provider": "compreface",
  "configured": true,
  "enabled": true,
  "last4": null,
  "baseUrl": "http://compreface-core:3000"
}
```

---

### DELETE /face/credentials/:provider

**Permission:** `face_settings:write`

Remove stored credentials for the given provider. Returns 404 if no credential exists.

**Response:**
```json
{ "deleted": true, "provider": "compreface" }
```

---

### POST /face/test

**Permission:** `face_settings:read`

Test provider connectivity by issuing a minimal API call to the provider's endpoint.

**Request Body:**
```json
{
  "provider": "compreface"
}
```

**Response:**
```json
{ "ok": true }
```

On failure:
```json
{ "ok": false, "error": "Connection refused at http://compreface-core:3000" }
```

---

### GET /face/models

**Permission:** `face_settings:read`

List available models for a configured provider using its stored credentials.

**Query Parameters:** `provider` (required) — provider key

**Response:**
```json
{
  "provider": "compreface",
  "models": ["compreface-arcface-mobilefacenet-128"]
}
```

---

### PUT /face/features/detection

**Permission:** `face_settings:write`

Set the active face provider and model used for background face detection. Stored in system settings under `face.features.detection`. Only one provider/model pair can be active at a time — mixing providers across a library is not supported (embeddings from different models are not cross-comparable).

**Request Body:**
```json
{
  "provider": "compreface",
  "model": "compreface-arcface-mobilefacenet-128"
}
```

**Response:**
```json
{
  "provider": "compreface",
  "model": "compreface-arcface-mobilefacenet-128"
}
```

---

## Face Recognition — Detection

These endpoints expose face detection results for individual media items. Authentication requires a valid JWT plus `media:read` (GET) or `media:write` (POST). Authorization is enforced at the circle level using per-circle roles — the caller must be at least a **viewer** for read operations and at least a **collaborator** for write/rerun operations.

---

### GET /media/:id/faces

**Permissions:** `media:read` + circle viewer role

List all detected faces for a media item. The embedding vector is omitted from this response (it is large and is only used internally for matching).

**Path Parameter:** `id` — media item UUID

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "boundingBox": { "x": 0.1, "y": 0.15, "width": 0.2, "height": 0.3 },
      "confidence": 0.98,
      "landmarks": null,
      "externalFaceId": null,
      "providerKey": "compreface",
      "modelVersion": "compreface-arcface-mobilefacenet-128",
      "manuallyAssigned": false,
      "personId": "uuid-or-null",
      "createdAt": "2026-06-17T10:00:00.000Z"
    }
  ]
}
```

`boundingBox` coordinates are normalized fractions of the image dimensions (0.0–1.0). `personId` is `null` for unknown (unassigned) faces.

---

### GET /media/:id/faces/status

**Permissions:** `media:read` + circle viewer role

Get the detection status for a specific media item. Returns a sentinel `not_processed` response if no `MediaFaceStatus` row exists yet.

**Path Parameter:** `id` — media item UUID

**Response:**
```json
{
  "data": {
    "status": "processed",
    "faceCount": 2,
    "providerKey": "compreface",
    "modelVersion": "compreface-arcface-mobilefacenet-128",
    "processedAt": "2026-06-17T10:05:00.000Z",
    "lastError": null,
    "updatedAt": "2026-06-17T10:05:00.000Z"
  }
}
```

**Status values:** `not_processed` | `pending` | `processing` | `processed` | `failed` | `no_faces`

---

### POST /media/:id/faces/rerun

**Permissions:** `media:write` + circle collaborator role

Enqueue a new face detection job for the media item. Returns the job ID immediately; detection runs asynchronously.

**Path Parameter:** `id` — media item UUID

**Response:** 201 Created
```json
{
  "data": {
    "jobId": "uuid",
    "status": "pending"
  }
}
```

---

### POST /face/backfill

**Permissions:** `face_settings:write` (Admin only)

Bulk-enqueue unprocessed photos in a circle for face detection. The circle must have `faceRecognitionEnabled=true` (set via `PUT /circles/:id/face-settings`); returns 400 otherwise.

**Request Body:**
```json
{
  "circleId": "uuid",
  "force": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to backfill |
| `force` | boolean | No | When `true`, re-enqueues items already marked `processed` or `no_faces`. Default: `false` |

**Response:** 201 Created
```json
{
  "data": {
    "queued": 147
  }
}
```

---

### DELETE /face/biometrics

**Permissions:** `face_settings:write` (system Admin) **or** `circle_admin` role in the target circle

Permanently delete all biometric data for a circle (GDPR right to erasure). In a single transaction: deletes all `Face`, `Person`, and `MediaFaceStatus` rows for the circle; cancels all pending `FaceJob` rows; sets `faceRecognitionEnabled=false` on the circle. **This action is irreversible.** Emits `face:biometrics_delete` audit event.

**Query Parameters:** `circleId` (required) — UUID of the circle

**Response:** 200 OK
```json
{
  "data": {
    "deletedFaces": 312,
    "deletedPeople": 8
  }
}
```

**Error Cases:**
- 400 — `circleId` query parameter missing
- 403 — Caller is not system Admin and does not hold `circle_admin` in the target circle
- 404 — Circle not found

---

## Face Recognition — People

People endpoints manage identity records within a circle. `media:read` + viewer role is required for reads; `media:write` + collaborator or circle_admin role is required for writes.

---

### GET /people

**Permissions:** `media:read` + circle viewer role

List person records in a circle. Includes a `coverFace` thumbnail reference and a `faceCount`.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `circleId` | UUID (required) | — | Circle to query |
| `includeUnlabeled` | boolean | `false` | Include persons with no name (provisional clusters) |
| `page` | integer | 1 | Page number |
| `pageSize` | integer | 20 (max 100) | Items per page |

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "Oscar",
      "isUnlabeled": false,
      "faceCount": 47,
      "coverFace": {
        "faceId": "uuid",
        "mediaItemId": "uuid",
        "boundingBox": { "x": 0.1, "y": 0.15, "width": 0.2, "height": 0.3 }
      },
      "createdAt": "2026-06-01T00:00:00.000Z",
      "updatedAt": "2026-06-17T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 5,
    "totalPages": 1
  }
}
```

---

### GET /people/:id

**Permissions:** `media:read` + circle viewer role

Get a person with their full list of associated face references. Embedding vectors are not included.

**Path Parameter:** `id` — person UUID

**Response:**
```json
{
  "id": "uuid",
  "name": "Oscar",
  "isUnlabeled": false,
  "circleId": "uuid",
  "coverFace": {
    "faceId": "uuid",
    "mediaItemId": "uuid",
    "boundingBox": { "x": 0.1, "y": 0.15, "width": 0.2, "height": 0.3 }
  },
  "faces": [
    {
      "faceId": "uuid",
      "mediaItemId": "uuid",
      "boundingBox": { "x": 0.1, "y": 0.15, "width": 0.2, "height": 0.3 },
      "confidence": 0.98,
      "manuallyAssigned": true,
      "createdAt": "2026-06-17T10:00:00.000Z"
    }
  ],
  "createdAt": "2026-06-01T00:00:00.000Z",
  "updatedAt": "2026-06-17T10:00:00.000Z"
}
```

---

### POST /people

**Permissions:** `media:write` + circle collaborator role

Create a new person in a circle, optionally assigning initial faces at creation time.

**Request Body:**
```json
{
  "circleId": "uuid",
  "name": "Oscar",
  "faceIds": ["uuid", "uuid"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle this person belongs to |
| `name` | string (1–100 chars) | No | Display name (omit to create an unlabeled provisional cluster) |
| `faceIds` | UUID[] (max 500) | No | Face IDs to assign at creation |

**Response:** 201 Created — person object (same shape as `GET /people/:id`, without full faces array)

---

### PATCH /people/:id

**Permissions:** `media:write` + circle collaborator role

Rename a person or update their cover face.

**Path Parameter:** `id` — person UUID

**Request Body:**
```json
{
  "name": "Oscar Marin",
  "coverFaceId": "uuid"
}
```

Both fields are optional. Pass `coverFaceId: null` to clear the cover face.

**Response:** 200 OK — updated person object

---

### POST /people/:id/faces

**Permissions:** `media:write` + circle collaborator role

Manually assign one or more faces to a person. Sets `manuallyAssigned=true` on the face rows, protecting them from future re-clustering.

**Path Parameter:** `id` — person UUID

**Request Body:**
```json
{
  "faceIds": ["uuid", "uuid"]
}
```

`faceIds` is required (1–500 items); all faces must belong to the same circle as the person.

**Response:** 200 OK
```json
{
  "personId": "uuid",
  "assignedCount": 2
}
```

---

### DELETE /people/:id/faces/:faceId

**Permissions:** `media:write` + circle collaborator role

Unassign a single face from a person. The face is returned to the unknown pool (`personId=null`, `manuallyAssigned=false`). The face row and its embedding are retained.

**Response:** 204 No Content

---

### POST /people/cluster

**Permissions:** `media:write` + circle_admin role

Trigger clustering of all unassigned faces in a circle into provisional Person records. Uses greedy union-find over cosine similarity (`FACE_CLUSTER_THRESHOLD`). Clusters meeting `FACE_CLUSTER_MIN_SIZE` create new unlabeled Person records; singletons remain unassigned. The circle must have `faceRecognitionEnabled=true`.

**Request Body:**
```json
{
  "circleId": "uuid"
}
```

**Response:** 200 OK — clustering summary
```json
{
  "data": {
    "clustersCreated": 3,
    "facesAssigned": 42,
    "singletonsSkipped": 7
  }
}
```

---

### POST /people/merge

**Permissions:** `media:write` + circle collaborator role

Merge two persons into one. In a single transaction: all faces belonging to `sourceId` are reassigned to `targetId`; `sourceId` is soft-deleted with `mergedIntoId` set to `targetId` as an audit breadcrumb; the target person's embedding centroid is recomputed. Both persons must belong to the same circle. Emits `person:merge` audit event.

**Request Body:**
```json
{
  "sourceId": "uuid",
  "targetId": "uuid"
}
```

`sourceId` and `targetId` must differ.

**Response:** 200 OK — updated target person object

**Error Cases:**
- 400 — `sourceId === targetId`, or persons are in different circles
- 403 — Collaborator role not held in target circle
- 404 — Source or target person not found

---

### DELETE /people/:id

**Permissions:** `media:write` + circle collaborator role

Soft-delete a person. All associated face rows have their `personId` set to `null` and `manuallyAssigned` set to `false`, returning them to the unknown pool. Face rows and embeddings are **not** deleted (use `DELETE /face/biometrics` for full erasure). Emits `person:delete` audit event.

**Response:** 204 No Content

---

## Face Recognition — Circle Face Settings

### GET /circles/:id/face-settings

**Permissions:** `circles:read` (any circle member)

Return the per-circle face recognition opt-in flag.

**Response:** 200 OK
```json
{
  "data": {
    "faceRecognitionEnabled": false
  }
}
```

---

### PUT /circles/:id/face-settings

**Permissions:** `circles:write` + circle_admin role

Enable or disable face recognition for a circle. When disabled, the auto-enqueue listener skips new uploads for this circle. Setting `enabled: false` does **not** erase existing biometric data — use `DELETE /face/biometrics` for that. Emits `circle:face_settings_update` audit event.

**Request Body:**
```json
{
  "enabled": true
}
```

**Response:** 200 OK
```json
{
  "data": {
    "faceRecognitionEnabled": true
  }
}
```

---

## AI Settings

All endpoints in this group require the Admin system role plus the listed permission.

### GET /ai/settings

**Permission:** `ai_settings:read`

Returns configured and known (unconfigured) AI providers and the active search feature configuration. The raw API key is never returned — only `last4`.

**Response:**
```json
{
  "providers": [
    {
      "provider": "anthropic",
      "configured": true,
      "enabled": true,
      "last4": "Ab1Z",
      "baseUrl": null,
      "updatedAt": "2026-06-15T12:00:00.000Z"
    }
  ],
  "knownProviders": [
    { "provider": "openai", "configured": false, "enabled": false, "last4": null, "baseUrl": null }
  ],
  "features": {
    "search": { "provider": "anthropic", "model": "claude-opus-4-8" }
  }
}
```

---

### PUT /ai/credentials/:provider

**Permission:** `ai_settings:write`

Upsert credentials for the given provider key (`anthropic` or `openai`). The API key is encrypted at rest with AES-256-GCM; the plaintext is never stored or returned.

**Path Parameter:** `provider` — `anthropic` | `openai`

**Request Body:**
```json
{
  "apiKey": "sk-...",
  "baseUrl": "https://api.moonshot.cn/v1",
  "enabled": true
}
```

`baseUrl` is optional and enables OpenAI-compatible providers (see [Agentic Search spec](specs/agentic-search.md#10-how-to-add-a-new-ai-provider)).

**Response:**
```json
{
  "provider": "openai",
  "configured": true,
  "enabled": true,
  "last4": "Ab1Z",
  "baseUrl": "https://api.moonshot.cn/v1"
}
```

---

### DELETE /ai/credentials/:provider

**Permission:** `ai_settings:write`

Remove stored credentials for the given provider. Returns 404 if no credential exists.

**Response:**
```json
{ "deleted": true, "provider": "anthropic" }
```

---

### POST /ai/test

**Permission:** `ai_settings:read`

Test provider connectivity by issuing a minimal chat completion request.

**Request Body:**
```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-8"
}
```

**Response:**
```json
{ "ok": true }
```

On failure:
```json
{ "ok": false, "error": "Invalid API key" }
```

---

### GET /ai/models

**Permission:** `ai_settings:read`

List available models for a configured provider using its stored credentials.

**Query Parameters:** `provider` (required) — provider key

**Response:**
```json
{
  "provider": "anthropic",
  "models": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]
}
```

---

### PUT /ai/features/search

**Permission:** `ai_settings:write`

Set the active AI provider and model used by the conversational search feature. Stored in system settings under `ai.features.search`.

**Request Body:**
```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-8"
}
```

**Response:**
```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-8"
}
```

---

## Deterministic Media Search

### POST /search

**Permissions:** `media:read` + `search:use`

Execute a deterministic media search using explicit filter criteria. Filter semantics are identical to `GET /api/media`. Unknown filter keys return 400. Returns the same paginated envelope as `GET /api/media`.

**Request Body:**
```json
{
  "circleId": "uuid",
  "filters": {
    "type": "photo",
    "capturedAt": { "from": "2024-06-01T00:00:00Z", "to": "2024-08-31T23:59:59Z" },
    "country": "Costa Rica",
    "classification": "memory"
  },
  "page": 1,
  "pageSize": 20,
  "sort": "capturedAt_desc"
}
```

All `filters` fields are optional and AND-composed. Available filter keys are returned by `GET /api/search/fields`.

**Error Cases:**
- 400 — Unknown filter key(s)
- 403 — Not a member of the circle or insufficient permissions

---

### GET /search/fields

**Permission:** `search:use`

Return the registry of all available filter dimensions. The frontend uses this to render the filter builder dynamically. The AI agent uses the `description` and `type` fields to generate the `search_media` tool schema.

**Response:**
```json
[
  {
    "key": "type",
    "label": "Media type",
    "type": "enum",
    "enumValues": ["photo", "video"],
    "description": "Filter by media type. Accepts \"photo\" or \"video\"."
  },
  {
    "key": "capturedAt",
    "label": "Capture date range",
    "type": "date-range",
    "description": "Filter by capture date. Pass an object { from?: ISO8601, to?: ISO8601 }."
  }
]
```

---

## Agentic Search

Agentic search is **stateless** — no conversation or message data is stored server-side. The client holds the full message history in memory and sends it with every request.

For the complete SSE protocol, architecture, and extensibility guide, see [docs/specs/agentic-search.md](specs/agentic-search.md).

---

### POST /search/agent

**Permission:** `search:use`

Send the full message history for a circle and receive a streamed AI response. The server verifies circle viewer membership for `circleId`, runs the tool-calling loop, and streams events. Nothing is persisted.

**Request Body:**

```json
{
  "circleId": "uuid",
  "messages": [
    { "role": "user", "content": "Show me photos from our trip to Costa Rica last summer" },
    { "role": "assistant", "content": "I found 42 photos from Costa Rica in July 2024..." },
    { "role": "user", "content": "Only show the ones from San José" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `circleId` | UUID | Yes | Circle to search within. Caller must be a `viewer` or higher. |
| `messages` | array | Yes | Full conversation history. The last entry must have `role: 'user'`. |
| `messages[].role` | `'user'` \| `'assistant'` | Yes | Message author |
| `messages[].content` | string | Yes | Message text |

**Response:** `200 OK`, `Content-Type: text/event-stream`

SSE event types:

| Event | Payload | Description |
|-------|---------|-------------|
| `token` | `{ text: string }` | A chunk of the model's response text |
| `tool_call` | `{ name: "search_media", args: { ... } }` | Model is executing a search |
| `results` | `{ items: [...], meta: { total, ... } }` | Search results returned to the model |
| `done` | `{}` | Stream complete |
| `error` | `{ message: string }` | Error occurred |

**Error Cases:**
- 400 — AI not configured, invalid input, or last message is not `role: 'user'`
- 403 — Not a member of the circle or insufficient permissions
