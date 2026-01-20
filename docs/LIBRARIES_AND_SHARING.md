# Libraries and Sharing Guide

This guide explains how libraries, media ownership, and sharing work in MemoriaHub.

---

## Table of Contents

- [Understanding Media Ownership](#understanding-media-ownership)
- [Libraries Overview](#libraries-overview)
- [Creating and Managing Libraries](#creating-and-managing-libraries)
- [Sharing Media Directly](#sharing-media-directly)
- [Library Membership and Roles](#library-membership-and-roles)
- [Access Control Explained](#access-control-explained)
- [Common Workflows](#common-workflows)
- [API Reference](#api-reference)
- [FAQ](#faq)

---

## Understanding Media Ownership

### Key Concept: User-Owned Media

In MemoriaHub, **all media belongs to users, not libraries**. This is a fundamental design decision that provides several benefits:

1. **True Ownership**: Your photos and videos are yours, regardless of which libraries they appear in
2. **Flexibility**: The same media can appear in multiple libraries
3. **Sharing Control**: You control who can see your media through direct sharing or library membership
4. **No Lock-in**: Removing media from a library doesn't delete it

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        User A (Owner)                           │
│                                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │  Photo 1    │   │  Photo 2    │   │  Photo 3    │           │
│  │  (owned)    │   │  (owned)    │   │  (owned)    │           │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│         │                 │                 │                   │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
   ┌──────────────────────────────────────────────────┐
   │           Library: "Family Vacation 2024"        │
   │           (Photos 1 & 2 added to library)        │
   └──────────────────────────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────────────────┐
   │           Library: "Best Photos"                 │
   │           (Photos 1 & 3 added to library)        │
   └──────────────────────────────────────────────────┘
```

**Photo 1** appears in both libraries, but it's only stored once and belongs to User A.

### Storage Path Structure

Media is stored using user-based paths:
```
users/{userId}/originals/{assetId}.jpg    # Original file
users/{userId}/thumbnails/{assetId}.jpg   # Thumbnail (300x300)
users/{userId}/previews/{assetId}.jpg     # Preview (1200px)
```

This ensures your media is organized by owner, making backups and data portability straightforward.

---

## Libraries Overview

Libraries are **logical collections** that help you organize and share your media. Think of them as albums or folders that can contain photos and videos from any user who has access.

### Library Properties

| Property | Description |
|----------|-------------|
| **Name** | Display name for the library (e.g., "Summer 2024") |
| **Description** | Optional description |
| **Visibility** | Who can access: `private`, `shared`, or `public` |
| **Owner** | The user who created the library |
| **Cover** | Optional cover photo shown in library listings |

### Visibility Levels

| Level | Who Can Access | Use Case |
|-------|----------------|----------|
| **Private** | Only the owner | Personal collections, work-in-progress |
| **Shared** | Owner + invited members | Family albums, group trips |
| **Public** | Anyone with the link | Portfolio, public galleries |

---

## Creating and Managing Libraries

### Creating a Library

1. Navigate to **Libraries** from the side menu
2. Click **"Create Library"**
3. Enter a name and optional description
4. Choose visibility (defaults to Private)
5. Click **Create**

### Adding Media to a Library

You can add media to a library in several ways:

#### During Upload
When uploading new photos or videos, you can optionally select a library. The media will be:
1. Uploaded and owned by you
2. Automatically added to the selected library

#### After Upload
1. Navigate to the library
2. Click **"Add Media"**
3. Select from your owned media or media shared with you
4. Click **Add**

#### From Media View
1. Open any media item you have access to
2. Click the **"Add to Library"** button
3. Select one or more libraries
4. Click **Add**

### Removing Media from a Library

Removing media from a library **does not delete the media**. It only removes the association.

1. Open the library
2. Select the media to remove
3. Click **"Remove from Library"**
4. Confirm the action

### Library Settings

Access library settings by clicking the gear icon on any library you own:

| Setting | Description |
|---------|-------------|
| **Edit Details** | Change name, description, cover |
| **Change Visibility** | Switch between private/shared/public |
| **Manage Members** | Add/remove members, change roles |
| **Delete Library** | Remove the library (media is not deleted) |

---

## Sharing Media Directly

Besides libraries, you can share individual media directly with other users.

### Direct Sharing vs Library Sharing

| Feature | Direct Share | Library Share |
|---------|--------------|---------------|
| Scope | Single media item | Entire library |
| Recipient | Specific user(s) | Library members |
| Permissions | Full access | Based on role |
| Organization | N/A | Grouped collection |

### How to Share Media Directly

1. Open a media item you own
2. Click the **Share** button
3. Search for users by email or name
4. Click **Share**

### Managing Shares

To see who has access to your media:

1. Open a media item you own
2. Click the **Share** button
3. View the list of users with access
4. Click **Revoke** to remove access

### What Shared Users Can Do

Users with direct share access can:
- View the media
- Download the original file
- Add the media to their own libraries

Users with direct share access **cannot**:
- Delete the media (only owner can)
- Share with others (only owner can)

---

## Library Membership and Roles

When you create a shared library, you can invite other users as members.

### Member Roles

| Role | Permissions |
|------|-------------|
| **Viewer** | View media in the library |
| **Contributor** | View + Add media to the library |
| **Admin** | View + Add + Remove media + Manage members |

### Adding Members

1. Open the library
2. Click **"Manage Members"**
3. Search for users by email
4. Select a role (defaults to Viewer)
5. Click **Invite**

### Changing Member Roles

1. Open **"Manage Members"**
2. Find the member
3. Select a new role from the dropdown
4. Changes apply immediately

### Removing Members

1. Open **"Manage Members"**
2. Find the member
3. Click **Remove**
4. Confirm the action

When a member is removed:
- They lose access to the library
- Media they added remains in the library
- Media they owned is still accessible if shared elsewhere

---

## Access Control Explained

MemoriaHub uses a layered access control system to determine who can see what.

### Access Types

A user can access media through one of these paths:

| Access Type | Description | Priority |
|-------------|-------------|----------|
| **Owner** | You uploaded/own the media | Highest |
| **Direct Share** | Owner shared directly with you | High |
| **Library Member** | You're a member of a library containing the media | Medium |
| **Public** | Media is in a public library | Lowest |

### Access Decision Flow

```
Can User X access Media Y?
        │
        ▼
┌───────────────────────┐
│ Is User X the owner?  │
└───────────┬───────────┘
            │
       Yes ─┼─> ✅ ALLOW (full control)
            │
            No
            │
            ▼
┌───────────────────────────────┐
│ Does a direct share exist     │
│ from owner to User X?         │
└───────────┬───────────────────┘
            │
       Yes ─┼─> ✅ ALLOW (view, download, add to library)
            │
            No
            │
            ▼
┌───────────────────────────────┐
│ Is User X a member of any     │
│ library containing Media Y?   │
└───────────┬───────────────────┘
            │
       Yes ─┼─> ✅ ALLOW (based on role)
            │
            No
            │
            ▼
┌───────────────────────────────┐
│ Is Media Y in a public        │
│ library?                      │
└───────────┬───────────────────┘
            │
       Yes ─┼─> ✅ ALLOW (view only)
            │
            No
            │
            ▼
        ❌ DENY
```

### Permission Matrix

| Action | Owner | Direct Share | Contributor | Viewer | Public |
|--------|-------|--------------|-------------|--------|--------|
| View media | ✅ | ✅ | ✅ | ✅ | ✅ |
| Download original | ✅ | ✅ | ✅ | ✅ | ⚙️* |
| View EXIF metadata | ✅ | ✅ | ✅ | ✅ | ⚙️* |
| Add to own library | ✅ | ✅ | ✅ | ❌ | ❌ |
| Add to shared library | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remove from library | ✅ | ❌ | ✅** | ❌ | ❌ |
| Share with others | ✅ | ❌ | ❌ | ❌ | ❌ |
| Delete media | ✅ | ❌ | ❌ | ❌ | ❌ |

*⚙️ Configurable by library owner*
***Only from libraries where user has Contributor role*

---

## Common Workflows

### Workflow 1: Family Photo Album

**Scenario**: You want to create a shared album for a family trip.

1. **Create the library**
   - Name: "Hawaii Trip 2024"
   - Visibility: Shared

2. **Upload your photos**
   - Select "Hawaii Trip 2024" during upload
   - Photos are owned by you, added to library

3. **Invite family members**
   - Add family members as Contributors
   - They can now view and add their own photos

4. **Family members contribute**
   - They upload photos selecting "Hawaii Trip 2024"
   - Their photos are added to the shared library
   - Each person still owns their own photos

### Workflow 2: Sharing a Single Photo

**Scenario**: You want to share one photo with a friend without creating a library.

1. **Find the photo** in your media
2. **Click Share**
3. **Enter your friend's email**
4. **They receive access** and can view/download

### Workflow 3: Organizing Personal Collections

**Scenario**: You want to organize your photos into multiple categories.

1. **Create private libraries**:
   - "Best Portraits"
   - "Nature Photography"
   - "Travel Highlights"

2. **Add photos to libraries**
   - The same photo can be in multiple libraries
   - Original file is stored only once

### Workflow 4: Building a Public Portfolio

**Scenario**: You want to showcase your best work publicly.

1. **Create a public library**
   - Name: "My Portfolio"
   - Visibility: Public

2. **Add your best photos**
   - Only add photos you own

3. **Share the link**
   - Anyone with the link can view
   - They cannot download or access private metadata

---

## API Reference

### Media Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/media` | List all accessible media |
| `GET` | `/api/media/:id` | Get single media item |
| `DELETE` | `/api/media/:id` | Delete media (owner only) |
| `POST` | `/api/media/upload/proxy` | Upload media |
| `POST` | `/api/media/:id/share` | Share media with users |
| `DELETE` | `/api/media/:id/share/:userId` | Revoke share |
| `GET` | `/api/media/:id/shares` | List shares |

### Library Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/libraries` | List accessible libraries |
| `POST` | `/api/libraries` | Create library |
| `GET` | `/api/libraries/:id` | Get library |
| `PUT` | `/api/libraries/:id` | Update library |
| `DELETE` | `/api/libraries/:id` | Delete library |
| `GET` | `/api/media/library/:id` | List media in library |

### Library Asset Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/libraries/:id/assets` | Add asset to library |
| `DELETE` | `/api/libraries/:id/assets/:assetId` | Remove asset from library |

### Library Member Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/libraries/:id/members` | List members |
| `POST` | `/api/libraries/:id/members` | Add member |
| `PUT` | `/api/libraries/:id/members/:userId` | Update role |
| `DELETE` | `/api/libraries/:id/members/:userId` | Remove member |

---

## FAQ

### Media Ownership

**Q: What happens to my photos if I leave a shared library?**
A: Photos you own remain yours. You can still access them from "All Media" view. Photos from other members become inaccessible unless shared with you directly.

**Q: Can someone delete my photos from a shared library?**
A: Contributors and Admins can remove photos from the library, but this only removes the association. The photo itself remains yours and is not deleted.

**Q: Can I see which libraries contain my photo?**
A: Yes, when viewing a media item, you can see all libraries it belongs to (that you have access to).

### Libraries

**Q: Is there a limit to how many libraries I can create?**
A: There is no fixed limit, but administrators may set quotas.

**Q: Can a photo be in multiple libraries?**
A: Yes, the same photo can be in as many libraries as you want. It's only stored once.

**Q: What happens when I delete a library?**
A: The library is removed, but all media remains. Photos return to being accessible only through their original ownership and sharing settings.

### Sharing

**Q: Can I share media I don't own?**
A: No, only the owner can share media directly with other users. However, if you're a member of a library, you can invite others to join that library.

**Q: Can shared users re-share my photos?**
A: No, only the original owner can share media. This gives you control over distribution.

**Q: How do I stop sharing with someone?**
A: For direct shares, go to the media item and revoke access. For library access, remove them from the library or change the library visibility.

### Privacy & Security

**Q: Who can see my photos by default?**
A: Only you. All media is private until you explicitly share it or add it to a shared/public library.

**Q: Can administrators see all photos?**
A: No, administrators do not have access to view private content. They can only manage system settings.

**Q: Is metadata (location, camera) shared?**
A: Metadata visibility follows the same rules as media visibility. If someone can view your photo, they can see its metadata.

---

## Summary

| Concept | Key Points |
|---------|-----------|
| **Ownership** | Media belongs to users, not libraries |
| **Libraries** | Logical collections that can contain media from multiple users |
| **Sharing** | Direct user-to-user sharing or through library membership |
| **Access** | Layered system: Owner > Direct Share > Library Member > Public |
| **Deletion** | Only owners can delete media; removing from library just removes the link |

---

*Last updated: January 2026*
