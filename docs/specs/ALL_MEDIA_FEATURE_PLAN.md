# Plan: All Media View, Upload Without Library, and Bulk Operations

## Summary

Implement a unified "All Media" view as the landing page with:
- **All Media page** as the default landing page
- **Upload without library** - media owned by user, not requiring library selection
- **Unified search component** - works identically across All Media and Libraries
- **Bulk operations** - select multiple items for: Add to Library, Delete, Update Metadata (lat/long, location, date)

---

## Current State Analysis

### What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| `GET /api/media` endpoint | ✅ Exists | Returns all accessible media (owned + shared + library) |
| `findAllAccessible()` repository | ✅ Exists | Complex UNION query for access control |
| `updateMediaMetadataSchema` | ✅ Exists | Validates lat, long, country, state, city, capturedAtUtc |
| `MediaGrid` component | ✅ Exists | Reusable grid display |
| `GalleryFilters` component | ✅ Exists | Type/sort filters (needs search enhancement) |
| `UploadButton` component | ✅ Exists | Currently requires library selection |
| `UploadDialog` component | ✅ Exists | Currently requires libraryId |
| Bulk add to library endpoint | ✅ Exists | `POST /api/libraries/:id/assets/bulk` |

### What's Missing

| Component | Status | Notes |
|-----------|--------|-------|
| All Media page | ❌ Missing | New page needed |
| Route for All Media | ❌ Missing | Need to add `/media` or `/all-media` route |
| Upload without library | ❌ Missing | Need to make libraryId optional in upload flow |
| Search component | ❌ Missing | Unified search across media |
| Bulk selection UI | ❌ Missing | Checkbox selection mode |
| Bulk operations toolbar | ❌ Missing | Actions for selected items |
| Bulk metadata update endpoint | ❌ Missing | `PATCH /api/media/bulk` |
| Bulk delete endpoint | ❌ Missing | `DELETE /api/media/bulk` |
| SideNav "All Media" item | ❌ Missing | Navigation entry |

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Landing page | All Media | User sees everything first, organizes later |
| Upload without library | Yes | Aligns with user-owned media model |
| Route path | `/media` | Clean, intuitive URL |
| Search scope | Current view | Search within All Media or within Library |
| Selection mode | Checkbox toggle | Click to view, checkbox to select |
| Bulk metadata update | Single endpoint | `PATCH /api/media/bulk` with array of updates |

---

## Implementation Phases

### Phase 1: Backend - Bulk Operations Endpoints

**New endpoints needed:**

#### 1.1 Bulk Update Metadata
```
PATCH /api/media/bulk
Body: {
  updates: [
    {
      assetId: string,
      capturedAtUtc?: string,
      latitude?: number | null,
      longitude?: number | null,
      country?: string | null,
      state?: string | null,
      city?: string | null,
      locationName?: string | null
    }
  ]
}
Response: {
  updated: string[],    // asset IDs successfully updated
  failed: { assetId: string, error: string }[]
}
```

#### 1.2 Bulk Delete Media
```
DELETE /api/media/bulk
Body: { assetIds: string[] }
Response: {
  deleted: string[],
  failed: { assetId: string, error: string }[]
}
```

**Files to create/modify:**

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/validation/media.schema.ts` | Modify | Add `bulkUpdateMediaMetadataSchema` |
| `packages/shared/src/types/media.types.ts` | Modify | Add `BulkUpdateMediaInput`, `BulkUpdateResult` types |
| `apps/api/src/infrastructure/database/repositories/media-asset.repository.ts` | Modify | Add `updateMetadata()`, `bulkUpdateMetadata()`, `bulkDelete()` |
| `apps/api/src/services/upload/upload.service.ts` | Modify | Add `updateAssetMetadata()`, `bulkUpdateMetadata()`, `bulkDeleteAssets()` |
| `apps/api/src/api/controllers/media.controller.ts` | Modify | Add `bulkUpdateMetadata()`, `bulkDelete()` handlers |
| `apps/api/src/api/routes/media.routes.ts` | Modify | Add `PATCH /api/media/bulk`, `DELETE /api/media/bulk` |
| `apps/api/src/api/validators/media.validator.ts` | Modify | Add bulk validation middleware |

---

### Phase 2: Backend - Upload Without Library

Make `libraryId` truly optional in the upload flow.

**Current behavior:** Upload requires library selection in UI (API already supports optional)
**New behavior:** Upload creates media owned by user, optionally adds to library

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/api/src/services/upload/upload.service.ts` | Verify | Confirm `libraryId` is truly optional |
| `apps/api/src/api/routes/media.routes.ts` | Verify | Proxy upload works without libraryId |

**Note:** Based on exploration, the API already supports optional `libraryId`. Changes are primarily frontend.

---

### Phase 3: Frontend - All Media Page

Create the "All Media" page as the new landing page.

**Files to create:**

| File | Description |
|------|-------------|
| `apps/web/src/pages/AllMediaPage.tsx` | Main All Media page component |
| `apps/web/src/hooks/useAllMedia.ts` | Hook to fetch all accessible media (wraps existing API) |

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/routes/AppRoutes.tsx` | Modify | Add `/media` route, make it the default landing |
| `apps/web/src/components/layout/SideNav.tsx` | Modify | Add "All Media" nav item at top |
| `apps/web/src/pages/HomePage.tsx` | Modify | Redirect to `/media` or keep as dashboard |

**AllMediaPage.tsx structure:**
```tsx
- Header: "All Media" title + Upload button
- SearchBar component (unified)
- GalleryFilters component (enhanced)
- BulkActionsToolbar (when items selected)
- MediaGrid with selection support
- MediaLightbox
- Pagination (load more)
```

---

### Phase 4: Frontend - Upload Without Library

Modify upload flow to support "Upload to My Media" without library selection.

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/upload/UploadButton.tsx` | Modify | Add "Upload" option (no library) |
| `apps/web/src/components/upload/UploadDialog.tsx` | Modify | Make `libraryId` optional |
| `apps/web/src/services/api/media.api.ts` | Modify | Support upload without libraryId |
| `apps/web/src/hooks/useUpload.ts` | Modify | Handle optional library |

**New menu structure:**
```
+ Button dropdown:
  ├── Upload (to My Media)     ← NEW: Upload without library
  ├── Upload to Library A
  ├── Upload to Library B
  ├── ...
  └── Create Library
```

---

### Phase 5: Frontend - Unified Search Component

Create a search component that works across All Media and Library views.

**Files to create:**

| File | Description |
|------|-------------|
| `apps/web/src/components/search/SearchBar.tsx` | Unified search input with filters |
| `apps/web/src/components/search/SearchFilters.tsx` | Advanced filter panel (location, date range, camera) |

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/gallery/GalleryFilters.tsx` | Modify | Integrate with SearchBar |
| `apps/web/src/pages/AllMediaPage.tsx` | Modify | Use SearchBar |
| `apps/web/src/pages/LibraryGalleryPage.tsx` | Modify | Use same SearchBar |

**Search capabilities:**
- Text search (filename) - future: content search with AI
- Filter by media type (image/video)
- Filter by date range
- Filter by location (country, state, city)
- Filter by camera make/model
- Sort options (date captured, date uploaded, filename, file size)

---

### Phase 6: Frontend - Bulk Selection UI

Add selection mode to MediaGrid for bulk operations.

**Files to create:**

| File | Description |
|------|-------------|
| `apps/web/src/components/gallery/SelectableMediaGrid.tsx` | MediaGrid with checkbox selection |
| `apps/web/src/components/gallery/BulkActionsToolbar.tsx` | Floating toolbar with bulk actions |
| `apps/web/src/components/dialogs/BulkMetadataDialog.tsx` | Dialog for editing metadata of multiple items |
| `apps/web/src/components/dialogs/AddToLibraryDialog.tsx` | Dialog for adding items to library |
| `apps/web/src/components/dialogs/BulkDeleteDialog.tsx` | Confirmation dialog for bulk delete |
| `apps/web/src/hooks/useMediaSelection.ts` | Selection state management hook |

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/gallery/MediaCard.tsx` | Modify | Add checkbox overlay in selection mode |
| `apps/web/src/services/api/media.api.ts` | Modify | Add `bulkUpdateMetadata()`, `bulkDelete()` |

**Bulk Actions Toolbar:**
```
┌─────────────────────────────────────────────────────────────┐
│ ☑ 5 selected    [Add to Library] [Edit Metadata] [Delete]  │ ← Fixed at bottom
└─────────────────────────────────────────────────────────────┘
```

**Bulk Metadata Dialog fields:**
- Date Taken (capturedAtUtc)
- Latitude
- Longitude
- Country
- State
- City
- Location Name (optional)

---

### Phase 7: Update Library Gallery Page

Apply same enhancements to Library view for consistency.

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/pages/LibraryGalleryPage.tsx` | Modify | Use SelectableMediaGrid, SearchBar, BulkActionsToolbar |

---

### Phase 8: Tests

#### Backend Tests

**Files to create:**

| File | Description |
|------|-------------|
| `apps/api/tests/unit/services/upload.service.bulk.test.ts` | Tests for bulk update/delete methods |
| `apps/api/tests/unit/repositories/media-asset.repository.bulk.test.ts` | Tests for repository bulk methods |
| `apps/api/tests/integration/bulk-operations.integration.test.ts` | Integration tests for bulk endpoints |

**Test cases:**
- Bulk update metadata - happy path
- Bulk update metadata - partial failure (some assets not owned)
- Bulk update metadata - validation errors
- Bulk delete - happy path
- Bulk delete - partial failure (some assets not owned)
- Bulk delete - cascade to library_assets and media_shares
- Authorization checks for all bulk operations

#### Frontend Tests

**Files to create:**

| File | Description |
|------|-------------|
| `apps/web/src/components/gallery/__tests__/SelectableMediaGrid.test.tsx` | Selection mode tests |
| `apps/web/src/components/gallery/__tests__/BulkActionsToolbar.test.tsx` | Toolbar action tests |
| `apps/web/src/hooks/__tests__/useMediaSelection.test.ts` | Selection hook tests |
| `apps/web/src/pages/__tests__/AllMediaPage.test.tsx` | Page integration tests |

---

## File Summary

### New Files (Create)

| File | Phase |
|------|-------|
| `apps/web/src/pages/AllMediaPage.tsx` | 3 |
| `apps/web/src/hooks/useAllMedia.ts` | 3 |
| `apps/web/src/components/search/SearchBar.tsx` | 5 |
| `apps/web/src/components/search/SearchFilters.tsx` | 5 |
| `apps/web/src/components/gallery/SelectableMediaGrid.tsx` | 6 |
| `apps/web/src/components/gallery/BulkActionsToolbar.tsx` | 6 |
| `apps/web/src/components/dialogs/BulkMetadataDialog.tsx` | 6 |
| `apps/web/src/components/dialogs/AddToLibraryDialog.tsx` | 6 |
| `apps/web/src/components/dialogs/BulkDeleteDialog.tsx` | 6 |
| `apps/web/src/hooks/useMediaSelection.ts` | 6 |
| `apps/api/tests/unit/services/upload.service.bulk.test.ts` | 8 |
| `apps/api/tests/unit/repositories/media-asset.repository.bulk.test.ts` | 8 |
| `apps/api/tests/integration/bulk-operations.integration.test.ts` | 8 |
| `apps/web/src/components/gallery/__tests__/SelectableMediaGrid.test.tsx` | 8 |
| `apps/web/src/components/gallery/__tests__/BulkActionsToolbar.test.tsx` | 8 |
| `apps/web/src/hooks/__tests__/useMediaSelection.test.ts` | 8 |
| `apps/web/src/pages/__tests__/AllMediaPage.test.tsx` | 8 |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `packages/shared/src/validation/media.schema.ts` | 1 | Add bulk schemas |
| `packages/shared/src/types/media.types.ts` | 1 | Add bulk types |
| `apps/api/src/infrastructure/database/repositories/media-asset.repository.ts` | 1 | Add bulk methods |
| `apps/api/src/services/upload/upload.service.ts` | 1 | Add bulk service methods |
| `apps/api/src/api/controllers/media.controller.ts` | 1 | Add bulk handlers |
| `apps/api/src/api/routes/media.routes.ts` | 1 | Add bulk routes |
| `apps/api/src/api/validators/media.validator.ts` | 1 | Add bulk validators |
| `apps/web/src/routes/AppRoutes.tsx` | 3 | Add /media route |
| `apps/web/src/components/layout/SideNav.tsx` | 3 | Add All Media nav |
| `apps/web/src/components/upload/UploadButton.tsx` | 4 | Add upload without library |
| `apps/web/src/components/upload/UploadDialog.tsx` | 4 | Optional libraryId |
| `apps/web/src/services/api/media.api.ts` | 4, 6 | Optional library upload, bulk ops |
| `apps/web/src/components/gallery/GalleryFilters.tsx` | 5 | Integrate search |
| `apps/web/src/components/gallery/MediaCard.tsx` | 6 | Add checkbox |
| `apps/web/src/pages/LibraryGalleryPage.tsx` | 7 | Use shared components |

---

## UI Mockups

### All Media Page
```
┌──────────────────────────────────────────────────────────────────┐
│ [≡] MemoriaHub                                    [+] [👤]       │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────┐                                                     │
│ │ All Media│  ← Active                                           │
│ │ Libraries│                                                     │
│ │ Search   │                                                     │
│ │ People   │                                                     │
│ │ Tags     │                                                     │
│ └──────────┘                                                     │
│                                                                  │
│   All Media                              [🔍 Search...] [Filters]│
│   1,234 items                                                    │
│                                                                  │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐              │
│   │☐ 📷│ │☐ 📷│ │☐ 📷│ │☐ 📷│ │☐ 🎬│ │☐ 📷│              │
│   │     │ │     │ │     │ │     │ │     │ │     │              │
│   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘              │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐              │
│   │☐ 📷│ │☐ 📷│ │☐ 📷│ │☐ 📷│ │☐ 📷│ │☐ 📷│              │
│   │     │ │     │ │     │ │     │ │     │ │     │              │
│   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘              │
│                                                                  │
│                        [Load More]                               │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ ☑ 3 selected    [Add to Library] [Edit Metadata] [Delete] │  │
│ └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Upload Menu (Updated)
```
┌─────────────────────────┐
│ 📤 Upload               │  ← NEW: Upload without library
├─────────────────────────┤
│ 📷 Upload to Family     │
│ 📷 Upload to Vacation   │
├─────────────────────────┤
│ 📁 Create Library       │
└─────────────────────────┘
```

### Bulk Metadata Dialog
```
┌─────────────────────────────────────────────┐
│ Edit Metadata (3 items)              [✕]    │
├─────────────────────────────────────────────┤
│                                             │
│ Date Taken                                  │
│ ┌─────────────────────────────────────────┐ │
│ │ 2024-06-15 14:30:00                     │ │
│ └─────────────────────────────────────────┘ │
│ ☐ Apply to all selected                     │
│                                             │
│ Location                                    │
│ ┌─────────────────┐ ┌─────────────────────┐ │
│ │ Latitude        │ │ Longitude           │ │
│ │ 37.7749         │ │ -122.4194           │ │
│ └─────────────────┘ └─────────────────────┘ │
│ ☐ Apply to all selected                     │
│                                             │
│ ┌──────────────┐ ┌──────────────┐          │
│ │ Country      │ │ State        │          │
│ │ USA          │ │ California   │          │
│ └──────────────┘ └──────────────┘          │
│ ┌─────────────────────────────────────────┐ │
│ │ City                                    │ │
│ │ San Francisco                           │ │
│ └─────────────────────────────────────────┘ │
│ ☐ Apply to all selected                     │
│                                             │
│                      [Cancel] [Save Changes]│
└─────────────────────────────────────────────┘
```

---

## Verification Plan

### 1. TypeCheck
```bash
npm run typecheck
```

### 2. Unit Tests
```bash
npm run test:unit -- --run
```

### 3. Integration Tests
```bash
npm run test:integration -- --run
```

### 4. Manual Testing Checklist

**All Media Page:**
- [ ] Page loads and displays all accessible media
- [ ] Pagination works (Load More)
- [ ] Filters work (type, date, location)
- [ ] Sort options work
- [ ] Click media opens lightbox
- [ ] Navigate via sidebar "All Media"

**Upload Without Library:**
- [ ] "+ Upload" option appears in dropdown
- [ ] Can upload without selecting library
- [ ] Uploaded media appears in All Media
- [ ] Media has owner_id but no library_assets record

**Bulk Selection:**
- [ ] Checkbox appears on hover/touch
- [ ] Clicking checkbox selects item (doesn't open lightbox)
- [ ] Multiple items can be selected
- [ ] Toolbar appears when items selected
- [ ] "Select All" works
- [ ] Clicking elsewhere deselects

**Bulk Add to Library:**
- [ ] Dialog shows available libraries
- [ ] Can add selected items to library
- [ ] Items appear in library after add
- [ ] Items still appear in All Media

**Bulk Edit Metadata:**
- [ ] Dialog shows editable fields
- [ ] Can update lat/long
- [ ] Can update country/state/city
- [ ] Can update date taken
- [ ] Changes persist after save
- [ ] Partial apply works (only checked fields)

**Bulk Delete:**
- [ ] Confirmation dialog appears
- [ ] Shows count of items to delete
- [ ] Delete removes from All Media
- [ ] Delete cascades to library_assets
- [ ] Only owner can delete

**Search:**
- [ ] Search bar appears on All Media
- [ ] Search bar appears on Library view
- [ ] Same component, same behavior
- [ ] Filters work in combination with search

---

## Dependencies

| Dependency | Currently Installed | Notes |
|------------|---------------------|-------|
| @mui/material | ✅ Yes | For UI components |
| @mui/icons-material | ✅ Yes | For icons |
| react-router-dom | ✅ Yes | For routing |
| zod | ✅ Yes | For validation |
| No new dependencies needed | - | - |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bulk operations on large datasets | Performance | Limit to 100 items per request |
| Race conditions in bulk ops | Data integrity | Use transactions, return partial results |
| Search performance | User experience | Index commonly searched fields |
| Selection state lost on navigation | User experience | Consider persisting selection |

---

## Estimated Scope

- **Phase 1-2 (Backend):** 7 files modified, 0 new files
- **Phase 3-7 (Frontend):** 10 new files, 8 files modified
- **Phase 8 (Tests):** 8 new test files

**Total:** ~17 new files, ~15 modified files

---

*Last updated: January 2026*
