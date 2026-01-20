# MemoriaHub User Guide

Welcome to MemoriaHub, your privacy-first family photo platform. This guide will help you get started and make the most of the application.

## Table of Contents

- [Getting Started](#getting-started)
- [Navigation](#navigation)
- [Settings](#settings)
  - [User Preferences](#user-preferences)
  - [System Settings (Admin)](#system-settings-admin)
- [Features](#features)
  - [Libraries](#libraries)
  - [Photo Gallery](#photo-gallery)
  - [Photo Upload](#photo-upload)
  - [Sharing](#sharing)
- [FAQ](#faq)

**Related Guides**:
- [Libraries and Sharing Guide](LIBRARIES_AND_SHARING.md) - Detailed guide on organizing and sharing media

---

## Getting Started

### First Login

1. **Open MemoriaHub** in your browser at the URL where it's hosted
2. **Click "Sign in with Google"** (or another configured OAuth provider)
3. **Authorize the application** to access your basic profile information
4. **You're in!** You'll be redirected to the home page

### Understanding the Interface

MemoriaHub uses a clean, modern interface with:

- **Top Bar**: Logo, page title, and user menu (your avatar)
- **Side Navigation**: Access to different sections of the app
- **Main Content Area**: Where photos, settings, and other content appear

---

## Navigation

### Side Menu

| Section | Description | Status |
|---------|-------------|--------|
| **Home** | Dashboard with overview and quick actions | Available |
| **Libraries** | Your photo collections and albums | Available |
| **Search** | Find photos by keywords, faces, or dates | Coming Soon |
| **People** | Photos organized by recognized faces | Coming Soon |
| **Tags** | Browse photos by tags and categories | Coming Soon |
| **Settings** | User preferences and app configuration | Available |

### User Menu

Click your avatar in the top-right corner to access:

- **Profile**: View your account information
- **Settings**: Quick link to preferences
- **Theme Toggle**: Switch between dark and light mode
- **Logout**: Sign out of MemoriaHub

---

## Settings

### User Preferences

Access settings via the side menu or user menu. You can customize:

#### Appearance

| Setting | Options | Description |
|---------|---------|-------------|
| **Theme** | Dark, Light, System | Color scheme for the interface |
| **Grid Size** | Small, Medium, Large | Photo thumbnail size in galleries |
| **Show Metadata** | On/Off | Display EXIF data and file information |

#### Notifications

Configure how you receive updates:

| Setting | Options | Description |
|---------|---------|-------------|
| **Email Notifications** | On/Off | Receive email updates |
| **Email Digest** | Instant, Daily, Weekly, Never | How often to receive email summaries |
| **Push Notifications** | On/Off | Browser push notifications |

> **Note**: Email notifications require SMTP to be configured by the administrator.

#### Privacy

| Setting | Options | Description |
|---------|---------|-------------|
| **Default Album Visibility** | Private, Shared, Public | Default privacy for new albums |
| **Allow Tagging** | On/Off | Let others tag you in photos |

### Resetting Preferences

Click the **"Reset to Defaults"** button at the top of the Settings page to restore all preferences to their original values.

---

## System Settings (Admin)

If you're the administrator of a self-hosted MemoriaHub instance, you can configure system-wide settings.

### Accessing Admin Settings

1. Navigate to **Settings**
2. Scroll to the **Admin** section (visible only to administrators)

### Email Configuration (SMTP)

Configure email delivery for notifications:

| Setting | Description |
|---------|-------------|
| **Enabled** | Turn email functionality on/off |
| **Host** | SMTP server hostname (e.g., smtp.gmail.com) |
| **Port** | SMTP port (typically 587 for TLS) |
| **Secure** | Use TLS encryption |
| **Username** | SMTP authentication username |
| **Password** | SMTP authentication password (stored encrypted) |
| **From Address** | Email address shown as sender |
| **From Name** | Display name for sent emails |

#### Example: Gmail SMTP Setup

```
Host: smtp.gmail.com
Port: 587
Secure: Yes
Username: your-email@gmail.com
Password: (App-specific password - not your Gmail password)
From Address: your-email@gmail.com
From Name: MemoriaHub
```

> **Important**: For Gmail, you'll need to generate an [App Password](https://myaccount.google.com/apppasswords).

### Push Notifications

Configure browser push notifications:

| Setting | Description |
|---------|-------------|
| **Enabled** | Turn push notifications on/off |
| **Provider** | Firebase or Web Push |
| **VAPID Keys** | Required for Web Push |

### Feature Flags

Enable or disable application features:

| Feature | Description |
|---------|-------------|
| **AI Search** | Smart search using image recognition |
| **Face Recognition** | Automatic face detection and grouping |
| **WebDAV Sync** | Sync with WebDAV-compatible apps |
| **Public Sharing** | Allow public album links |
| **Guest Uploads** | Allow uploads from shared links |

### General Settings

| Setting | Description |
|---------|-------------|
| **Site Name** | Your instance name (shown in browser tab) |
| **Site Description** | Short description of your instance |
| **Allow Registration** | Let new users sign up |
| **Max Upload Size** | Maximum file size for uploads (MB) |
| **Supported Formats** | Allowed file types |

---

## Features

### Libraries

Libraries are collections that help you organize your photos and videos. For a comprehensive guide, see [Libraries and Sharing Guide](LIBRARIES_AND_SHARING.md).

**Key Concepts**:
- **You own your media**: Photos belong to you, not to libraries
- **Flexible organization**: The same photo can appear in multiple libraries
- **Sharing control**: Share through library membership or directly with users

**Quick Start**:
1. **Navigate to Libraries** from the side menu
2. **Create a new library** by clicking the "Create Library" button
3. **Set visibility**: Private (only you), Shared (invited members), or Public (anyone with link)
4. **Add a description** to help you remember what the library contains

**Library Visibility**:

| Level | Who Can Access |
|-------|----------------|
| **Private** | Only you |
| **Shared** | You + invited members |
| **Public** | Anyone with the link |

### Photo Gallery

View and browse your photos:

1. **Click on a library** to open its gallery
2. **Browse thumbnails** in a responsive grid (4 columns on desktop, 2 on mobile)
3. **Filter by type**: Show all, images only, or videos only
4. **Sort by date**: Capture date or upload date, newest or oldest first
5. **Load more**: Click "Load More" to see additional photos

### Lightbox (Full-Size Viewing)

View photos and videos in detail:

1. **Click any thumbnail** to open the lightbox
2. **Navigate** using arrow buttons or keyboard (Left/Right arrows)
3. **View metadata** including filename, capture date, location, camera info, and dimensions
4. **Play videos** with full controls
5. **Close** by clicking the X button, pressing Escape, or clicking outside

### Keyboard Shortcuts in Lightbox

| Shortcut | Action |
|----------|--------|
| Arrow Left/Up | Previous photo |
| Arrow Right/Down/Space | Next photo |
| Escape | Close lightbox |

### Photo Upload

Upload photos and videos to MemoriaHub:

1. **Click the "Upload" button** from the toolbar or within a library
2. **Drag and drop** files or click to browse
3. **Optionally select a library** to add the media to
4. **Supported formats**: JPEG, PNG, GIF, WebP, HEIC, MP4, MOV, AVI, WebM
5. **Maximum file size**: 100MB per file
6. **Track progress** as files upload

**Understanding Uploads**:
- Uploaded media is **owned by you** regardless of which library it's in
- If you don't select a library, media appears in your "All Media" view
- You can add media to libraries later

### Sharing

Share your memories with family and friends. For detailed information, see [Libraries and Sharing Guide](LIBRARIES_AND_SHARING.md).

**Two Ways to Share**:

| Method | Best For |
|--------|----------|
| **Direct Share** | Sharing individual photos with specific people |
| **Library Share** | Sharing entire collections with groups |

**Direct Sharing**:
1. Open a photo or video you own
2. Click the **Share** button
3. Search for users by email
4. Click **Share** to grant access

**Library Sharing**:
1. Create or open a shared library
2. Click **Manage Members**
3. Invite users by email
4. Assign roles (Viewer, Contributor, Admin)

**Member Roles**:

| Role | Can View | Can Add Media | Can Manage |
|------|----------|---------------|------------|
| Viewer | Yes | No | No |
| Contributor | Yes | Yes | No |
| Admin | Yes | Yes | Yes |

**Revoking Access**:
- For direct shares: Open the photo, click Share, and revoke access
- For library access: Remove the member from the library

### Search

*(Coming Soon)*

- Full-text search across metadata
- Search by date range
- Search by location (if GPS data available)
- AI-powered visual search

### Backup & Sync

*(Coming Soon)*

- WebDAV access for desktop sync
- Automatic backup verification
- Multiple storage backends

---

## FAQ

### How do I change my email address?

Your email address comes from your OAuth provider (Google, Microsoft, etc.). To change it, update your email with that provider and log in again.

### Can I use multiple OAuth providers?

Currently, each account is linked to a single OAuth provider. You cannot link multiple providers to the same account.

### Is my data private?

Yes! MemoriaHub is designed to be self-hosted, meaning you control all your data. Photos are stored on your own infrastructure, and no data is sent to third parties (unless you configure external services like cloud storage).

### How do I backup my photos?

MemoriaHub stores photos in S3-compatible storage. You can:
- Use your storage provider's backup features
- Configure additional backup locations
- Use WebDAV sync to maintain local copies

### What file formats are supported?

By default: JPEG, PNG, GIF, WebP, HEIC, MP4, MOV, AVI

Administrators can customize this list in System Settings.

### How do I report a bug?

Visit our [GitHub Issues](https://github.com/marinoscar/MemoriaHub/issues) page to report bugs or request features.

---

## Keyboard Shortcuts

### Lightbox Navigation

| Shortcut | Action |
|----------|--------|
| Arrow Left/Up | Previous photo |
| Arrow Right/Down/Space | Next photo |
| Escape | Close lightbox |

### General (Coming Soon)

| Shortcut | Action |
|----------|--------|
| `?` | Show keyboard shortcuts help |
| `g h` | Go to Home |
| `g s` | Go to Settings |
| `/` | Focus search |

---

## Getting Help

- **Documentation**: Check the [docs folder](/) for technical details
- **Issues**: Report bugs at [GitHub Issues](https://github.com/marinoscar/MemoriaHub/issues)
- **Community**: Join discussions in GitHub Discussions

---

*Last updated: January 2026*
