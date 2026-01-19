# Testing Plan: Web & Worker Services

This document outlines the recommended test coverage for the web frontend and worker service, prioritized by importance to project health.

## Current State

| Service | Test Coverage | Status |
|---------|---------------|--------|
| API | 91% | ✅ Comprehensive |
| Web | ~0% | ❌ Needs tests |
| Worker | 0% | ⚠️ Placeholder code only |
| Shared | Coverage included in API | ✅ Tested via API |

---

## Web Frontend Testing Plan

### Priority Levels
- **P0 (Critical)**: Must have - core functionality that if broken, breaks the app
- **P1 (High)**: Should have - important business logic and user flows
- **P2 (Medium)**: Nice to have - improves confidence but lower risk
- **P3 (Low)**: Optional - pure UI, already covered by TypeScript

---

### P0 - Critical Tests

#### 1. AuthContext (Zustand Store)
**File**: `src/contexts/AuthContext.tsx`
**Why Critical**: Core authentication state management. Bugs here = users locked out or security issues.

| Test Case | Description |
|-----------|-------------|
| `login()` stores tokens correctly | Tokens saved to storage, user fetched |
| `login()` handles API errors | Graceful error handling, state cleanup |
| `logout()` clears all state | Tokens cleared, user nullified |
| `checkAuth()` with valid tokens | Returns authenticated state |
| `checkAuth()` with expired tokens | Attempts refresh |
| `checkAuth()` with no tokens | Returns unauthenticated |
| `refreshToken()` success | New tokens stored |
| `refreshToken()` failure | Logs out user |

**Estimated effort**: 2-3 hours
**Impact**: Prevents auth-related outages

#### 2. API Client Interceptors
**File**: `src/services/api/client.ts`
**Why Critical**: All API calls go through here. Token refresh logic is complex.

| Test Case | Description |
|-----------|-------------|
| Adds Bearer token to requests | Authorization header set |
| Handles 401 with token refresh | Queues requests, refreshes, retries |
| Handles concurrent 401s | Only one refresh, all requests retried |
| Redirect to login on refresh failure | Navigation triggered |
| Non-401 errors pass through | Other errors not intercepted |

**Estimated effort**: 3-4 hours
**Impact**: Prevents silent auth failures

#### 3. OAuthCallback Component
**File**: `src/components/auth/OAuthCallback.tsx`
**Why Critical**: Entry point after OAuth. Bugs = users can't log in.

| Test Case | Description |
|-----------|-------------|
| Extracts tokens from URL params | Parses access_token, refresh_token |
| Handles OAuth errors in URL | Shows error, redirects to login |
| Calls login() with valid tokens | Auth context updated |
| Navigates to home on success | Router navigation triggered |
| Handles missing tokens | Error state displayed |

**Estimated effort**: 1-2 hours
**Impact**: Critical login flow

#### 4. ProtectedRoute Component
**File**: `src/components/auth/ProtectedRoute.tsx`
**Why Critical**: Access control. Bugs = unauthorized access or blocked users.

| Test Case | Description |
|-----------|-------------|
| Shows loading while checking auth | Spinner displayed |
| Redirects unauthenticated to login | Navigate to /login |
| Allows authenticated users through | Children rendered |
| Redirects authenticated from login | Navigate to / |

**Estimated effort**: 1 hour
**Impact**: Security boundary

---

### P1 - High Priority Tests

#### 5. SettingsPage
**File**: `src/pages/SettingsPage.tsx`
**Why Important**: Complex state management, API integration, user preferences.

| Test Case | Description |
|-----------|-------------|
| Loads preferences on mount | API called, state populated |
| Syncs theme with server preference | Theme context updated |
| Updates nested preferences correctly | Deep object updates work |
| Shows saving indicator | UI feedback during save |
| Handles API errors | Error state displayed |
| Reset to defaults works | API called, state reset |

**Estimated effort**: 3-4 hours
**Impact**: User settings persistence

#### 6. ThemeContext
**File**: `src/theme/ThemeContext.tsx`
**Why Important**: Theme persistence, affects entire UI.

| Test Case | Description |
|-----------|-------------|
| Defaults to dark mode | Initial state correct |
| Persists theme to localStorage | Storage updated on change |
| Loads theme from localStorage | Initial state from storage |
| toggleTheme() switches mode | dark ↔ light |
| setTheme() sets specific mode | Explicit mode setting |
| MUI theme created correctly | Theme object valid |

**Estimated effort**: 1-2 hours
**Impact**: UX consistency

#### 7. UserMenu Component
**File**: `src/components/layout/UserMenu.tsx`
**Why Important**: User-facing, complex logic (initials, theme toggle).

| Test Case | Description |
|-----------|-------------|
| Displays user avatar | Image or initials shown |
| Calculates initials correctly | "John Doe" → "JD" |
| Handles single name | "John" → "J" |
| Handles empty name | Fallback character |
| Theme toggle switches theme | Context function called |
| Logout triggers auth logout | Auth context updated |
| Menu opens/closes correctly | UI state management |

**Estimated effort**: 2 hours
**Impact**: User interaction quality

#### 8. SideNav Component
**File**: `src/components/layout/SideNav.tsx`
**Why Important**: Navigation, route highlighting, responsive behavior.

| Test Case | Description |
|-----------|-------------|
| Highlights active route | Current path styled |
| Disabled items not clickable | No navigation triggered |
| Mobile drawer opens/closes | Temporary drawer state |
| Desktop drawer always visible | Permanent drawer |
| Navigation changes route | Router navigation |

**Estimated effort**: 2 hours
**Impact**: Navigation UX

---

### P2 - Medium Priority Tests

#### 9. ErrorBoundary Component
**File**: `src/components/common/ErrorBoundary.tsx`
**Why Useful**: Error recovery, prevents white screen of death.

| Test Case | Description |
|-----------|-------------|
| Catches child errors | Error state captured |
| Displays error UI | Error message shown |
| Reset button navigates home | Navigation triggered |
| Logs errors | Console logging verified |

**Estimated effort**: 1 hour
**Impact**: Error resilience

#### 10. Auth API Service
**File**: `src/services/api/auth.api.ts`
**Why Useful**: API contract verification.

| Test Case | Description |
|-----------|-------------|
| getProviders() returns providers | API response parsed |
| getMe() returns user | User object shaped correctly |
| refresh() returns new tokens | Token response parsed |
| logout() calls correct endpoint | API called |
| getOAuthUrl() builds correct URL | URL formatted properly |

**Estimated effort**: 1-2 hours
**Impact**: API integration confidence

#### 11. Settings API Service
**File**: `src/services/api/settings.api.ts`
**Why Useful**: Settings API contract verification.

| Test Case | Description |
|-----------|-------------|
| getPreferences() returns preferences | Response parsed |
| updatePreferences() sends partial update | Request formatted |
| resetPreferences() calls endpoint | API called |
| getFeatureFlags() returns flags | Response parsed |

**Estimated effort**: 1 hour
**Impact**: Settings integration

#### 12. Token Storage Service
**File**: `src/services/storage/token.storage.ts`
**Why Useful**: Storage strategy verification.

| Test Case | Description |
|-----------|-------------|
| Access token uses sessionStorage | Correct storage used |
| Refresh token uses localStorage | Correct storage used |
| clear() removes both tokens | Both storages cleared |
| hasTokens() checks both | Boolean logic correct |

**Estimated effort**: 30 minutes
**Impact**: Token security model

---

### P3 - Low Priority Tests

#### 13. Page Components (UI-focused)
**Files**: `LoginPage.tsx`, `HomePage.tsx`, `ProfilePage.tsx`, `NotFoundPage.tsx`

| Test Case | Description |
|-----------|-------------|
| LoginPage renders login button | Button present |
| HomePage shows greeting | User name displayed |
| ProfilePage shows user info | Profile data displayed |
| NotFoundPage shows 404 | Error message displayed |

**Estimated effort**: 1-2 hours total
**Impact**: Rendering verification

#### 14. Layout Components (UI-focused)
**Files**: `TopBar.tsx`, `AppLayout.tsx`

| Test Case | Description |
|-----------|-------------|
| TopBar shows logo | Logo rendered |
| AppLayout renders children | Outlet works |

**Estimated effort**: 30 minutes
**Impact**: Layout structure

#### 15. LoadingSpinner
**File**: `src/components/common/LoadingSpinner.tsx`
**Status**: ✅ Already has test

---

## Web Testing Summary

| Priority | Components | Est. Effort | Coverage Impact |
|----------|------------|-------------|-----------------|
| P0 | 4 | 7-10 hours | Auth flow secured |
| P1 | 4 | 8-10 hours | Core features tested |
| P2 | 4 | 3-5 hours | API contracts verified |
| P3 | 5 | 2-4 hours | UI rendering confirmed |
| **Total** | **17** | **20-29 hours** | **Comprehensive** |

### Recommended Implementation Order

1. **Week 1**: P0 tests (AuthContext, API client, OAuthCallback, ProtectedRoute)
2. **Week 2**: P1 tests (SettingsPage, ThemeContext, UserMenu, SideNav)
3. **Week 3**: P2 tests (ErrorBoundary, API services, Token storage)
4. **Later**: P3 tests as time permits

---

## Worker Service Testing Plan

### Current State

The worker service is a **placeholder** - it has infrastructure but no business logic:
- Entry point with Pino logger
- Heartbeat timer (keeps process alive)
- Test framework configured (empty test directories)

### When to Write Tests

Tests should be written **as features are implemented**. The worker will need:

---

### Future P0 - Critical Tests (When Implemented)

#### 1. Job Queue Consumer
**When**: Job queue integration added

| Test Case | Description |
|-----------|-------------|
| Connects to job queue | Connection established |
| Pulls jobs correctly | Jobs dequeued |
| Acknowledges completed jobs | Queue updated |
| Handles connection failures | Reconnection logic |
| Respects concurrency limit | Max parallel jobs |

#### 2. Media Processing Pipeline
**When**: Asset processing implemented

| Test Case | Description |
|-----------|-------------|
| EXIF extraction works | Metadata parsed |
| Handles missing EXIF | Graceful fallback |
| Thumbnail generation works | Image resized |
| Preview generation works | Preview created |
| Handles corrupt images | Error logged, job failed |
| Status transitions correct | UPLOADED → READY lifecycle |

#### 3. Storage Operations
**When**: S3 integration added

| Test Case | Description |
|-----------|-------------|
| Downloads from S3 | Object retrieved |
| Uploads derivatives | Objects stored |
| Handles S3 errors | Retry logic works |
| Cleans up temp files | No orphaned files |

---

### Future P1 - High Priority Tests (When Implemented)

#### 4. Database Operations
**When**: Asset/job repositories added

| Test Case | Description |
|-----------|-------------|
| Updates asset status | DB updated correctly |
| Records processing events | Events logged |
| Handles DB errors | Transaction rollback |

#### 5. Retry Logic
**When**: Job retry system added

| Test Case | Description |
|-----------|-------------|
| Retries failed jobs | Attempt count incremented |
| Exponential backoff works | Delay increases |
| Max retries enforced | Job marked as failed |
| Records last error | Error message stored |

#### 6. Observability
**When**: Metrics/tracing added

| Test Case | Description |
|-----------|-------------|
| Logs include traceId | Correlation working |
| Metrics incremented | Counters updated |
| Spans created | Traces recorded |
| Duration recorded | Timing captured |

---

### Future P2 - Medium Priority Tests (When Implemented)

#### 7. Health Endpoints
**When**: HTTP server added

| Test Case | Description |
|-----------|-------------|
| /healthz returns ok | Process alive |
| /readyz checks deps | DB + S3 checked |
| /metrics returns prometheus | Metrics exposed |

#### 8. Enrichment Jobs (AI)
**When**: AI processing added

| Test Case | Description |
|-----------|-------------|
| Face detection works | Faces identified |
| Object tagging works | Tags generated |
| Handles AI service errors | Graceful degradation |

---

## Worker Testing Summary

| Priority | Feature Area | Tests Needed | Status |
|----------|--------------|--------------|--------|
| P0 | Job queue, Processing, Storage | ~15-20 | Not yet needed |
| P1 | Database, Retry, Observability | ~10-15 | Not yet needed |
| P2 | Health, AI enrichment | ~5-10 | Not yet needed |

**Total when implemented**: 30-45 tests

### Recommendation

Do **NOT** write worker tests now. The code doesn't exist yet. Instead:

1. **Write tests alongside implementation** (TDD recommended)
2. **Start with job queue consumer** - most critical piece
3. **Add processing tests** with sample images in test fixtures
4. **Integration tests** with containerized PostgreSQL + MinIO

---

## Project Health Impact Assessment

### Current Risk Analysis

| Area | Risk Level | Impact | Mitigation |
|------|------------|--------|------------|
| API | Low ✅ | High | 91% coverage |
| Web Auth | **High** ❌ | Critical | P0 tests needed |
| Web UI | Medium ⚠️ | Medium | P1-P2 tests |
| Worker | N/A | N/A | No code to test |

### Recommended Investment

1. **Immediate (1-2 weeks)**: Web P0 tests
   - Protects authentication flow
   - Prevents login/logout bugs
   - ROI: Very high

2. **Short-term (2-4 weeks)**: Web P1 tests
   - Protects core features
   - Improves refactoring confidence
   - ROI: High

3. **Medium-term**: Web P2-P3 tests
   - Improves overall confidence
   - Catches edge cases
   - ROI: Medium

4. **When implementing**: Worker tests
   - Written alongside code
   - Ensures processing reliability
   - ROI: High (for that milestone)

---

## Testing Infrastructure Notes

### Web Testing Stack (Ready)
- **Framework**: Vitest (configured in vite.config.ts)
- **DOM**: jsdom
- **Utilities**: @testing-library/react
- **Mocks**: Setup in src/test/setup.ts
- **Render wrapper**: src/test/utils.tsx (includes providers)

### Mocking Strategies

```typescript
// API mocking
vi.mock('../services/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  }
}));

// Auth context mocking
vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: vi.fn(() => ({
    user: mockUser,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
  }))
}));

// Navigation mocking
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// localStorage/sessionStorage mocking
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });
```

### Worker Testing Stack (Ready)
- **Framework**: Vitest (configured in vitest.config.ts)
- **Environment**: Node
- **Timeout**: 30s for integration tests
- **Setup**: tests/setup.ts with env vars

---

## Conclusion

### Key Priorities

1. **Web P0 tests are the highest ROI** - auth bugs are critical
2. **Worker tests should wait** - no code to test yet
3. **API is well-covered** - maintain existing tests

### Health Improvement Path

```
Current:  API ✅ | Web ❌ | Worker N/A
After P0: API ✅ | Web ⚠️ | Worker N/A  (+10% overall confidence)
After P1: API ✅ | Web ✅ | Worker N/A  (+25% overall confidence)
```

The project's health depends most critically on **web authentication tests** being implemented soon.
