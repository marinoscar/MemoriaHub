# Implementation Specifications

This folder contains detailed specifications for building the Enterprise App Foundation. Each spec is designed to be self-contained and sized appropriately for an AI coding agent to implement.

## Spec Organization

Specs are organized by implementation order and domain. Follow the dependencies to ensure proper sequencing.

## Specification Index

### Infrastructure & Setup

| Spec | Title | Domain | Dependencies | Complexity |
|------|-------|--------|--------------|------------|
| [01](01-project-setup.md) | Project Setup | Infrastructure | None | Low |
| [02](02-database-schema.md) | Database Schema | Database | 01 | Medium |
| [03](03-database-seeds.md) | Database Seeds | Database | 02 | Low |

### API Core

| Spec | Title | Domain | Dependencies | Complexity |
|------|-------|--------|--------------|------------|
| [04](04-api-core-setup.md) | API Core Setup | Backend | 01, 02 | Medium |
| [05](05-auth-google-oauth.md) | Google OAuth | Backend | 04, 03 | High |
| [06](06-auth-jwt-refresh.md) | JWT Refresh Tokens | Backend | 05 | Medium |
| [07](07-rbac-guards.md) | RBAC Guards | Backend | 05, 03 | Medium |

### API Endpoints

| Spec | Title | Domain | Dependencies | Complexity |
|------|-------|--------|--------------|------------|
| [08](08-users-endpoints.md) | Users Endpoints | Backend | 07 | Medium |
| [09](09-user-settings-endpoints.md) | User Settings Endpoints | Backend | 07, 02 | Medium |
| [10](10-system-settings-endpoints.md) | System Settings Endpoints | Backend | 07, 02 | Medium |
| [11](11-health-endpoints.md) | Health Endpoints | Backend | 04 | Low |
| [12](12-api-observability.md) | API Observability | Backend | 04 | Medium |

### Frontend

| Spec | Title | Domain | Dependencies | Complexity |
|------|-------|--------|--------------|------------|
| [13](13-web-project-setup.md) | Web Project Setup | Frontend | 01 | Medium |
| [14](14-web-auth-context.md) | Auth & Theme Context | Frontend | 13 | Medium |
| [15](15-web-login-page.md) | Login Page | Frontend | 14 | Low |
| [16](16-web-home-page.md) | Home Page | Frontend | 14 | Low |
| [17](17-web-user-settings-page.md) | User Settings Page | Frontend | 14 | Medium |
| [18](18-web-system-settings-page.md) | System Settings Page | Frontend | 14 | Medium |

### Testing

| Spec | Title | Domain | Dependencies | Complexity |
|------|-------|--------|--------------|------------|
| [19](19-api-test-framework.md) | API Test Framework | Testing | 04 | Medium |
| [20](20-api-auth-tests.md) | Auth Module Tests | Testing | 05, 06, 19 | High |
| [21](21-api-rbac-tests.md) | RBAC & Guards Tests | Testing | 07, 19 | Medium |
| [22](22-api-endpoints-tests.md) | API Endpoints Tests | Testing | 08, 09, 10, 11, 19 | High |
| [23](23-web-test-framework.md) | Web Test Framework | Testing | 13 | Medium |
| [24](24-web-component-tests.md) | Web Component Tests | Testing | 14, 15, 16, 17, 18, 23 | High |

## Dependency Graph

```
01-project-setup
├── 02-database-schema
│   └── 03-database-seeds
├── 04-api-core-setup
│   ├── 05-auth-google-oauth
│   │   ├── 06-auth-jwt-refresh
│   │   └── 07-rbac-guards
│   │       ├── 08-users-endpoints
│   │       ├── 09-user-settings-endpoints
│   │       └── 10-system-settings-endpoints
│   ├── 11-health-endpoints
│   ├── 12-api-observability
│   └── 19-api-test-framework
│       ├── 20-api-auth-tests (after 05, 06)
│       ├── 21-api-rbac-tests (after 07)
│       └── 22-api-endpoints-tests (after 08, 09, 10, 11)
└── 13-web-project-setup
    ├── 14-web-auth-context
    │   ├── 15-web-login-page
    │   ├── 16-web-home-page
    │   ├── 17-web-user-settings-page
    │   └── 18-web-system-settings-page
    └── 23-web-test-framework
        └── 24-web-component-tests (after 14-18)
```

## Implementation Phases

### Phase 1: Foundation
1. **01-project-setup** - Initialize monorepo structure
2. **02-database-schema** - Create Prisma schema
3. **03-database-seeds** - Seed roles, permissions, defaults

### Phase 2: API Core
4. **04-api-core-setup** - NestJS with Fastify, Prisma, Swagger
5. **05-auth-google-oauth** - Google OAuth authentication
6. **06-auth-jwt-refresh** - Refresh token system
7. **07-rbac-guards** - Role and permission guards

### Phase 3: API Features
8. **08-users-endpoints** - User management (admin)
9. **09-user-settings-endpoints** - User settings CRUD
10. **10-system-settings-endpoints** - System settings (admin)
11. **11-health-endpoints** - Health checks
12. **12-api-observability** - OpenTelemetry, logging

### Phase 4: Frontend
13. **13-web-project-setup** - React, MUI, routing
14. **14-web-auth-context** - Auth and theme providers
15. **15-web-login-page** - OAuth login
16. **16-web-home-page** - Dashboard
17. **17-web-user-settings-page** - User preferences
18. **18-web-system-settings-page** - Admin settings

### Phase 5: Testing
19. **19-api-test-framework** - Jest, Supertest, test DB setup
20. **20-api-auth-tests** - Auth module unit and integration tests
21. **21-api-rbac-tests** - RBAC guards and authorization tests
22. **22-api-endpoints-tests** - API endpoint integration tests
23. **23-web-test-framework** - Vitest, RTL, MSW setup
24. **24-web-component-tests** - Component and page tests

## Spec Structure

Each specification follows this format:

```markdown
# Spec XX: Title

**Domain:** Backend | Frontend | Database | Infrastructure | Testing
**Agent:** `backend-dev` | `frontend-dev` | `database-dev` | `testing-dev` | etc.
**Depends On:** List of prerequisite specs
**Estimated Complexity:** Low | Medium | High

## Objective
Brief description of what this spec accomplishes.

## Deliverables
List of files and components to create.

## Implementation Details
Code examples and detailed instructions.

## Acceptance Criteria
Checklist of requirements that must be met.

## Notes
Additional context and considerations.
```

## Agent Assignments

| Agent | Specs |
|-------|-------|
| `database-dev` | 02, 03 |
| `backend-dev` | 04, 05, 06, 07, 08, 09, 10, 11, 12 |
| `frontend-dev` | 13, 14, 15, 16, 17, 18 |
| `testing-dev` | 19, 20, 21, 22, 23, 24 |
| Manual/Orchestration | 01 |

## Running Tests

After implementing the testing specs, use these commands:

```bash
# API Tests
cd apps/api && npm test              # Run all tests
cd apps/api && npm run test:cov      # Run with coverage
cd apps/api && npm run test:watch    # Watch mode

# Web Tests
cd apps/web && npm test              # Run all tests
cd apps/web && npm run test:coverage # Run with coverage
cd apps/web && npm run test:ui       # Visual test UI
```

## Using These Specs

1. **Read the spec thoroughly** before starting implementation
2. **Check dependencies** - ensure prerequisite specs are complete
3. **Follow acceptance criteria** - use as a checklist
4. **Reference code examples** - adapt to your specific needs
5. **Consult the System Specification Document** for broader context
6. **Run tests after implementation** - verify specs 19-24 for test coverage

## Related Documents

- [System Specification Document](../System_Specification_Document.md) - Complete system requirements
- [CLAUDE.md](../../CLAUDE.md) - Project overview and conventions
