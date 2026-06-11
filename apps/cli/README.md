# @memoriahub/cli

Command-line tool for importing and syncing photo/video folders into a MemoriaHub server.

---

## Build

Dependencies and the build step must be run from the repo root (npm workspaces):

```bash
# Install all workspace dependencies
npm install

# Build the CLI
npm run build -w apps/cli
```

The compiled output lands in `apps/cli/dist/` (gitignored). After building, the binary can be invoked in two ways:

```bash
# Directly
node apps/cli/dist/index.js <command>

# Via npm link (makes `memoriahub` available on PATH)
cd apps/cli && npm link
```

Node.js 18 or later is required.

---

## Authentication

Before running `import` or `sync`, authenticate with your server:

```bash
memoriahub login
```

The command prompts interactively for:

- **Server URL** — the base URL of your MemoriaHub instance (e.g. `https://memoriahub.example.com`)
- **Personal Access Token (PAT)** — create one in the web app under **Settings > Personal Access Tokens**

The CLI validates the token by calling `GET /api/auth/me`. On success, credentials are written to `~/.memoriahub/config.json` with mode `0600`. Credentials are never accepted as positional arguments.

---

## Commands

### `memoriahub login`

Authenticate with a MemoriaHub server. Prompts for server URL and PAT; stores config at `~/.memoriahub/config.json`.

```bash
memoriahub login
```

### `memoriahub import <folder>`

One-shot import of all supported files in a folder.

```bash
memoriahub import ~/Pictures/Vacation2024
memoriahub import ~/Pictures/Vacation2024 --recursive
memoriahub import ~/Pictures/Vacation2024 --dry-run
```

| Flag | Short | Description |
|------|-------|-------------|
| `--recursive` | `-r` | Descend into sub-directories |
| `--dry-run` | | Preview what would be uploaded without uploading anything |

Each file is SHA-256 hashed locally before upload. The CLI queries `GET /api/media?contentHash=<sha256>` to check whether the file is already stored on the server. Files that match are skipped; only new files are uploaded. A manifest is written to `~/.memoriahub/manifests/<folder-hash>.json` recording the result of each file.

### `memoriahub sync <folder>`

Incremental sync. Like `import`, but also consults the local manifest: any file already recorded with `status: uploaded` whose SHA-256 is unchanged is skipped without contacting the server. Only new files, changed files, and previously failed files are processed.

```bash
memoriahub sync ~/Pictures/Vacation2024
memoriahub sync ~/Pictures/Vacation2024 --recursive
memoriahub sync ~/Pictures/Vacation2024 --dry-run
```

| Flag | Short | Description |
|------|-------|-------------|
| `--recursive` | `-r` | Descend into sub-directories |
| `--dry-run` | | Preview without uploading |

`sync` is idempotent: re-running it on an already-synced folder uploads zero files.

### `memoriahub status`

Print a summary table for every folder that has been imported or synced.

```bash
memoriahub status
```

Output example:

```
Folder    : /home/alice/Pictures/Vacation2024
Last sync : 6/10/2026, 8:01:00 AM
Files     : 312 total  |  310 uploaded  |  0 pending  |  2 failed
```

---

## Deduplication

The CLI uses a two-layer dedup strategy:

1. **Local manifest** (`sync` only) — if a file's path and SHA-256 match a previous `uploaded` entry, the file is skipped entirely without a network call.
2. **Server content hash** — before uploading any file, the CLI sends `GET /api/media?contentHash=<sha256>`. If the server already holds a media item with that hash (regardless of filename or folder), the upload is skipped.

This means re-running `sync` across multiple sessions or on overlapping folders never creates duplicates.

---

## Manifest

Each synced folder has a manifest file at:

```
~/.memoriahub/manifests/<sha256-of-folder-path>.json
```

The manifest records per-file state:

```json
{
  "folderPath": "/home/alice/Pictures/Vacation2024",
  "lastSyncAt": "2026-06-10T08:01:00Z",
  "files": {
    "/home/alice/Pictures/Vacation2024/IMG_1234.jpg": {
      "sha256": "e3b0c44298fc1c149afb...",
      "mediaItemId": "uuid",
      "uploadedAt": "2026-06-10T08:01:00Z",
      "status": "uploaded"
    }
  }
}
```

Possible `status` values: `uploaded`, `pending`, `failed`.

---

## Supported File Types

| Extension | MIME type |
|-----------|-----------|
| jpg, jpeg | image/jpeg |
| png | image/png |
| heic | image/heic |
| webp | image/webp |
| mp4 | video/mp4 |
| mov | video/quicktime |
| avi | video/x-msvideo |

Files with other extensions are skipped and listed in the output.

---

## Large File Uploads

Files are uploaded using the server's resumable multipart upload API (init → upload parts → complete). The default chunk size is 10 MB. There is no cap on the number of parts, so files larger than 500 MB are handled correctly. A progress bar (powered by `cli-progress`) updates after each part.

---

## Related Documentation

- [Phase 05 — CLI Importer](../../docs/plan/phase-05-cli-importer.md)
- [API Reference](../../docs/API.md)
- [Architecture](../../docs/ARCHITECTURE.md)
