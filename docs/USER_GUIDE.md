# MemoriaHub User Guide

Welcome to MemoriaHub, your privacy-first family photo platform. This guide will help you get started and make the most of the application.

## Table of Contents

- [Getting Started](#getting-started)
- [Navigation](#navigation)
- [Settings](#settings)
  - [User Preferences](#user-preferences)
  - [System Settings (Admin)](#system-settings-admin)
- [Features](#features)
- [FAQ](#faq)

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
| **Libraries** | Your photo collections and albums | Coming Soon |
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

#### Language & Region

| Setting | Options | Description |
|---------|---------|-------------|
| **Language** | English, Spanish, French, German, Portuguese | Interface language |

#### Privacy

| Setting | Options | Description |
|---------|---------|-------------|
| **Default Album Visibility** | Private, Shared, Public | Default privacy for new albums |
| **Allow Tagging** | On/Off | Let others tag you in photos |

#### Security

| Setting | Status | Description |
|---------|--------|-------------|
| **Two-Factor Authentication** | Coming Soon | Additional login security |

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

### Photo Management

*(Coming Soon)*

- Upload photos and videos
- Organize into albums and libraries
- Add tags and descriptions
- View photo metadata (EXIF)

### Sharing

*(Coming Soon)*

- Share albums with family members
- Create public links for viewing
- Set expiration dates on shared links
- Control download permissions

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

| Shortcut | Action |
|----------|--------|
| `?` | Show keyboard shortcuts help |
| `g h` | Go to Home |
| `g s` | Go to Settings |
| `/` | Focus search |
| `Esc` | Close modal/dialog |

*(Keyboard shortcuts coming soon)*

---

## Getting Help

- **Documentation**: Check the [docs folder](/) for technical details
- **Issues**: Report bugs at [GitHub Issues](https://github.com/marinoscar/MemoriaHub/issues)
- **Community**: Join discussions in GitHub Discussions

---

*Last updated: January 2024*
