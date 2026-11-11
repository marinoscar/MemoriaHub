---
"@marinoscar/memoriahub-web": minor
---

Add the admin port to `core` (private): `MemoriahubWebHost.admin` supplies the data table, the admin console page header and the deployment settings hook that the domain admin pages need and a host-neutral package cannot import, with `useMemoriahubAdmin`, the structural `MemoriahubDataTable*` and `MemoriahubSystemSettings` types and, for tests, `createFakeAdminPort` (a plain-HTML table, a header and an in-memory settings hook). The web app binds the platform `DataTable`, its `AdminPageHeader` and `useSystemSettings` in `apps/web/src/platform-memoriahub/admin.tsx`; nothing changes for users.
