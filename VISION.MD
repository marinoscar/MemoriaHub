# MemoriaHub Vision

## Product Vision

MemoriaHub is an application designed to give people full ownership, control, and long-term protection of their most precious family memories: photos and videos.

Today, many families depend on platforms like Google Photos, Apple Photos, Microsoft OneDrive, and other cloud services to store years of personal history. These platforms are convenient, but they also create dependency. Moving away from them can be difficult, storage options are often limited, and users may not have a simple way to replicate, export, migrate, or preserve their data across different places.

MemoriaHub exists to solve that problem.

The goal of MemoriaHub is to become a personal media hub where users can store, organize, enrich, sync, replicate, import, clean up, and export their photos and videos while keeping full control of their data.

## Core Mission

MemoriaHub helps users protect their family memories by making media storage portable, flexible, searchable, and independent from any single provider.

The application should make it easy to:

* Store photos and videos in a user-controlled environment.
* Sync media from mobile devices, computers, cloud storage, and local drives.
* Import media from existing platforms and exported libraries.
* Replicate media across multiple storage locations.
* Move away from one provider without losing data or metadata.
* Export both media and metadata in open, usable formats.
* Enrich photos and videos over time with additional metadata and processing.
* Prioritize meaningful family memories over low-value media files.

The guiding principle is simple:

**Your family memories should belong to you, not to a platform.**

## MVP Focus

The MVP of MemoriaHub should focus on the essential capabilities required to prove the product vision:

1. Upload and store photos and videos.
2. Extract and store key media metadata.
3. Support AWS storage as the first cloud storage option.
4. Allow future support for other storage providers such as Azure and additional cloud platforms.
5. Enable syncing with local hard drives or local network storage.
6. Provide a web application for browsing, uploading, and managing media.
7. Provide an Android app for mobile photo and video sync.
8. Provide a CLI for importing and syncing media from a computer.
9. Provide API support so other applications, tools, and automations can interact with MemoriaHub.
10. Provide metadata export capabilities in formats such as JSON and CSV.
11. Allow future processors to enrich photos and videos after upload.
12. Provide an import path for existing media collections, starting with local folders and exported libraries.
13. Support the long-term goal of importing from platforms such as Google Photos, Microsoft OneDrive, Apple Photos, Dropbox, and others.
14. Provide a way to distinguish meaningful family memories from lower-value media such as screenshots, downloaded videos, memes, and temporary files.

The MVP should not try to replace every feature of Google Photos immediately. The first version should focus on ownership, portability, reliable storage, import, sync, metadata, export, and extensibility.

## Problem Statement

Families create thousands of photos and videos every year. These files capture vacations, birthdays, milestones, school events, family gatherings, holidays, celebrations, and everyday moments that become priceless over time.

However, most people store these memories in systems they do not fully control. This creates several problems:

* Data becomes locked into one provider.
* Exporting media and metadata can be difficult.
* Moving to another storage provider can be painful.
* Local backups are often incomplete or manual.
* Metadata may be lost, inconsistent, or hard to access.
* Users may have years of photos and videos spread across multiple platforms.
* Users may not have a clear way to enrich or organize their media over time.
* Large media libraries often contain noise such as screenshots, downloads, memes, and duplicate files.
* Long-term preservation depends on companies whose priorities may change.

MemoriaHub addresses this by giving users a central place to manage their media while keeping storage flexible, portable, and under their control.

## Target Users

MemoriaHub is initially designed for people who care deeply about protecting their personal and family media collections.

Primary users include:

* Families who want to preserve photos and videos long term.
* Users who want to reduce dependency on Google Photos, Apple Photos, Microsoft OneDrive, or similar platforms.
* Power users who want better control over where their media is stored.
* Users who want cloud storage, local storage, and backup flexibility.
* Users who want to sync photos from Android devices automatically.
* Users who want to import existing media collections from computers, local drives, exports, or cloud services.
* Users who want to organize, enrich, search, and clean up media metadata over time.

## Key Product Principles

### 1. Ownership First

The user should always feel that they own their data.

MemoriaHub should avoid lock-in. Media and metadata should remain portable, exportable, and understandable outside the application.

### 2. Family Memories First

MemoriaHub should focus on preserving meaningful family memories, not simply storing every media file a user has ever downloaded.

The product should help users protect what matters most: people, places, milestones, trips, celebrations, and everyday family moments.

### 3. Provider Independence

MemoriaHub should not depend on a single storage provider.

AWS should be supported first, but the product should be designed around the idea that users may later add Azure, another cloud provider, or local storage.

The user should be able to move away from one provider and replicate or upload their data somewhere else without losing their media collection.

### 4. Open Metadata

Metadata should be treated as a valuable part of the user’s memories.

MemoriaHub should store and expose metadata such as:

* Date and time
* Location
* Camera information
* File name
* File type
* File size
* Device information when available
* User-added tags or descriptions
* Enriched metadata created by future processors

Users should be able to export metadata in simple formats such as JSON and CSV.

### 5. Multiple Ways to Ingest Media

Users should not be forced into one upload method.

MemoriaHub should support multiple ways to bring media into the system:

* Web app upload
* Android app sync
* CLI import from a computer
* Sync from local hard drives or local network locations
* Import from exported libraries
* Future imports from Google Photos, Microsoft OneDrive, Apple Photos, Dropbox, and other services

### 6. Local and Cloud Flexibility

MemoriaHub should support both cloud and local storage strategies.

Some users may want to store everything in AWS. Others may want local storage at home. Others may want both.

The product should support a model where media can be stored, copied, and replicated across multiple locations.

### 7. Extensible Enrichment

Uploading a file should be only the beginning.

After a photo or video is uploaded, MemoriaHub should allow additional processes to enrich the media over time.

Examples of future enrichment include:

* Face recognition
* Object detection
* Location enrichment
* Event grouping
* Duplicate detection
* Scene classification
* Search improvement
* Automatic tagging
* Family member identification
* Low-value media detection

The MVP should establish the foundation for this extensibility, even if only basic metadata extraction is available at first.

### 8. Simple Export and Exit

A user should be able to leave MemoriaHub without losing access to their memories.

The application should make it easy to export metadata and understand where media files are stored.

This is central to the product philosophy: MemoriaHub should earn trust by not trapping the user.

## Core MVP Capabilities

## Web Application

The web app should provide a simple way for users to interact with their media library.

The MVP web app should allow users to:

* View uploaded photos and videos.
* Upload new media files.
* Browse media by date or basic metadata.
* View metadata associated with a file.
* Start or review media processing results.
* Export metadata.
* Manage basic storage settings.
* Review import and sync status.
* Identify media that may not be a meaningful family memory.

The web app should be clean, simple, and focused on control rather than social sharing.

## Android Application

The Android app should allow users to sync photos and videos from mobile devices into MemoriaHub.

The MVP Android app should allow users to:

* Select media folders to sync.
* Upload new photos and videos.
* Preserve available metadata from the device.
* Track sync status.
* Retry failed uploads.
* Support background sync when appropriate.
* Give the user visibility into what has been uploaded.

The Android app is critical because mobile devices are where most family memories are created.

## CLI

The CLI should provide a practical way to import and sync media from a computer or local machine.

The MVP CLI should allow users to:

* Import media from a folder.
* Sync new files from a local directory.
* Upload photos and videos into MemoriaHub.
* Preserve file and media metadata.
* Support repeatable imports without duplicating files.
* Provide clear status and results.
* Help users migrate existing media collections from old folders, external drives, exports, and backups.

The CLI is important for users migrating from existing folders, external drives, old backups, or exported collections from other platforms.

## API Support

MemoriaHub should provide API support so that media and metadata can be managed by other applications, scripts, and automations.

The MVP API should support core actions such as:

* Uploading media.
* Retrieving media information.
* Accessing metadata.
* Updating selected metadata.
* Starting or checking processing status.
* Exporting metadata.
* Managing storage-related actions.
* Supporting import and sync workflows.

API support is important because MemoriaHub should be open, extensible, and automation-friendly.

## Storage Support

The MVP should support AWS as the first cloud storage provider.

The storage vision should include:

* Cloud storage support starting with AWS.
* Future support for Azure and other providers.
* Local hard drive or local network storage support.
* The ability to replicate data across more than one location.
* The ability to move away from a provider without losing media or metadata.
* The ability to later upload an existing media collection to another provider.

Storage should be flexible because long-term ownership requires options.

## Local Hard Drive and Network Sync

MemoriaHub should support syncing with local hard drives or storage available on a local network.

This allows users to keep a copy of their media at home while still using cloud storage if they choose.

The MVP should support the idea that a local hard drive can be part of the user’s storage strategy, not just an offline backup.

## Importing From Existing Platforms

MemoriaHub should provide a way to import media and metadata from existing platforms where users already have years of photos and videos stored.

This is an important part of the product vision because many users will not start with an empty library. They may already have family memories spread across services such as:

* Google Photos
* Microsoft OneDrive
* Apple Photos
* Dropbox
* External hard drives
* Old computer folders
* Phone backups
* Other cloud or local storage locations

MemoriaHub should make it easier to bring those memories into one user-controlled place.

The goal is not only to copy the media files, but also to preserve as much useful information as possible, including dates, locations, file names, album information, device information, and any other metadata that can help organize and protect the memory.

For the MVP, this capability can start with basic import support from local folders and exported media collections. Over time, MemoriaHub should support more direct migration paths from major platforms.

The long-term goal is simple:

**A user should be able to move their family memories out of another platform and into MemoriaHub without losing the meaning, history, or organization behind those memories.**

## Metadata Management

MemoriaHub should store metadata in a structured way so the application can organize, search, process, and export media information.

The MVP should capture and store basic metadata during upload, including:

* File name
* File type
* File size
* Created date when available
* Captured date when available
* Location when available
* Camera or device information when available
* Storage location
* Upload status
* Processing status
* Source of import when available

Metadata should be treated as a first-class part of the product.

## Media Processing and Enrichment

MemoriaHub should allow media to be enriched after upload.

The MVP should support basic metadata extraction first. Over time, the application should support additional processors that can analyze and enrich photos and videos.

Future processors may include:

* Face recognition
* Object detection
* Automatic tagging
* Duplicate detection
* Location enrichment
* Video metadata extraction
* Family member identification
* Event or album suggestions
* Low-value media detection
* Screenshot detection
* Downloaded video detection

The purpose of processing is to make memories easier to organize, search, clean up, and preserve.

## Future Search and Enrichment Capabilities

MemoriaHub should become smarter over time by enriching media after it is uploaded or imported.

### Search by Person

MemoriaHub should support face recognition so users can find photos and videos of specific family members or people.

For example:

* Show photos of Lucia.
* Show videos with Valeria.
* Show pictures where the whole family appears.
* Find photos with grandparents.

This should help users rediscover memories that are otherwise buried inside large media libraries.

### Search by Objects and Scenes

MemoriaHub should support object and scene detection so users can search based on what appears in the photo or video.

For example:

* Pictures at the beach
* Photos with a dog
* Pictures with cars
* Videos with a birthday cake
* Photos at a park
* Images with mountains
* Pictures with food
* Photos taken near water

This would make the media library more searchable and useful without requiring the user to manually tag every file.

### Duplicate Detection and Cleanup

MemoriaHub should help users identify duplicate or near-duplicate photos and videos.

This should include the ability to:

* Group exact duplicates.
* Identify very similar photos.
* Show duplicate videos.
* Help users decide what to keep.
* Safely remove low-value copies.
* Avoid accidental loss of meaningful files.

The goal is not aggressive deletion. The goal is controlled cleanup with user review.

### Filtering Low-Value Media

MemoriaHub should help users filter media that may not represent family memories.

Examples include:

* Screenshots
* Downloaded TikTok videos
* Memes
* Temporary downloads
* Reposted social media videos
* Random saved images
* Non-family media
* Files that were downloaded but not captured by the user

The user should be able to review these files and decide whether to delete, archive, ignore, or keep them.

This capability is important because many media libraries become noisy over time. MemoriaHub should help users focus on what matters most.

## Memory Prioritization

MemoriaHub should be focused on preserving family memories, not simply storing every media file a user has ever downloaded.

Many media libraries contain a mix of meaningful memories and low-value files, such as:

* Screenshots
* Downloaded TikTok videos
* Memes
* Temporary videos
* Duplicate downloads
* Work-related images
* Random saved images
* Receipts or documents
* Media that was downloaded but not personally captured

MemoriaHub should help users identify and separate meaningful family memories from media that may not need to be preserved long term.

The product should eventually provide ways to filter, review, tag, group, and clean up media based on what it likely represents. The user should stay in control, but the application should help surface what matters most.

The main focus should always be family memories: people, places, moments, trips, celebrations, milestones, and everyday life worth preserving.

## Export Capabilities

MemoriaHub should provide an easy way to export metadata.

The MVP should support metadata export in common formats such as:

* JSON
* CSV

Exporting metadata is important because users should be able to analyze, migrate, back up, or reuse their media information outside of MemoriaHub.

## Family Circles — Collaborative Family Library

Family Circles is the central collaborative feature of MemoriaHub. It transforms MemoriaHub from a single-user media archive into a shared family memory platform, while preserving every user's full ownership and privacy of their personal library.

### What Family Circles Means

Every user belongs to at least one circle. On signup, a personal circle is automatically created for that user — all their previously imported media lives there. Family members can then create additional shared circles and invite others by email.

**Fully shared circle library.** Every media item belongs to exactly one circle and is visible to all members of that circle. There is no per-item private flag. MemoriaHub tracks who contributed each item via `addedById`, but all members with sufficient role can view, organize, and (if authorized) edit any item in the circle.

**Multiple circles per user.** A user may belong to several circles at the same time — their own personal library plus shared family circles or other groups. The web app and CLI both provide a circle switcher so users can move between active circles. The active circle is persisted in user settings as a convenience.

**Per-circle roles.** Each circle has three roles: `circle_admin` (manages the circle and its members), `collaborator` (adds and organizes media), and `viewer` (read-only access). These roles are independent of the global system roles.

**Invite flow.** A circle admin invites someone by email. Sending the invite automatically adds that email to the application allowlist so the invitee can log in. On first login, pending invites for that email are claimed and the user is added as a member of the relevant circles.

**Two-layer admin model.** The existing global Admin role is the super-admin layer: it can manage any circle, any media, and run admin-level backup operations, bypassing per-circle membership checks. Per-circle roles govern day-to-day access within each circle.

### Local-Drive Backup

System admins can trigger a server-side backup job (`POST /api/admin/backup`) that replicates ready media blobs from S3 (for a given circle or all circles) to a local disk path (`BACKUP_LOCAL_PATH`). A per-circle manifest is written alongside the blobs. Backup runs are tracked in the audit event log. The CLI provides a complementary `memoriahub backup` command for operators who prefer to pull blobs to their own machine using a Personal Access Token.

## What MemoriaHub Is Not in the MVP

The MVP should avoid trying to do too much too early.

MemoriaHub does not need to initially include:

* Advanced photo editing
* Social sharing
* Public albums
* Complex AI search
* Full replacement of every Google Photos feature
* Printed photo products
* Advanced mobile editing tools

These features may be considered later, but they are not part of the initial focus.

The MVP should stay focused on ownership, storage flexibility, importing, syncing, metadata, export, family collaboration through circles, memory prioritization, and extensibility.

## Long-Term Vision

Over time, MemoriaHub can become a complete personal memory platform.

The long-term vision includes:

* Importing media from Google Photos, Microsoft OneDrive, Apple Photos, Dropbox, local folders, external drives, and other sources.
* Multi-cloud storage support.
* Strong local storage support.
* Better search across photos and videos.
* Face recognition to search by person.
* Object and scene detection to search by content.
* Family-based organization.
* Event detection.
* Timeline views.
* Duplicate detection and cleanup.
* Filtering of screenshots, downloaded videos, memes, and other low-value media.
* Prioritization of meaningful family memories.
* Migration from existing platforms.
* Rich metadata enrichment.
* Backup and replication controls.
* Full media portability.
* Simple recovery if a provider is removed or replaced.

The ultimate goal is to give users peace of mind that their family memories are safe, organized, portable, searchable, and truly theirs.

## Success Criteria for the MVP

The MVP will be successful if a user can:

* Upload photos and videos into MemoriaHub.
* Sync media from an Android device.
* Import media from a computer using the CLI.
* Import media from local folders or exported collections.
* Store media in AWS.
* Connect or sync with local storage.
* View media through the web app.
* Extract and view basic metadata.
* Export metadata as JSON or CSV.
* Use the API for core media and metadata operations.
* Understand where their media is stored.
* Feel confident that their memories are not locked into one provider.
* Begin separating meaningful family memories from lower-value media files.

## North Star

MemoriaHub should give users confidence that their most precious family memories are protected, portable, searchable, and under their control.

The product should always prioritize ownership, simplicity, durability, trust, and family memory preservation.

**MemoriaHub is not just a media storage app. It is a personal memory ownership platform designed to protect what matters most.**
