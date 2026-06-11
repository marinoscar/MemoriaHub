# @memoriahub/cli

Command-line tool for importing and syncing photo/video folders into a MemoriaHub server. The CLI ships with a polished terminal UI: ASCII banner on startup, `ora` spinners during network and hash operations, color-coded status output (green/yellow/red), and `cli-table3` summary tables for import results and folder status. All color output honors the `NO_COLOR` environment variable and the `--no-color` flag; in non-TTY contexts (piped output, CI) the CLI automatically falls back to plain text with bracketed status labels.

---

## Install via curl

> **Repository visibility note**
> The raw-content URL below requires the repository to be **public**. While the repository is private, use one of the two alternative methods shown below instead.

**Public repo (or once the repo is made public):**

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash
```

**Private repo — install from a local clone:**

```bash
# 1. Clone the repository using your credentials
git clone https://github.com/marinoscar/MemoriaHub.git ~/MemoriaHub

# 2. Run the installer pointing at the local clone
MEMORIAHUB_SRC=~/MemoriaHub bash ~/MemoriaHub/install.sh
```

The installer auto-detects whether a previous installation exists and updates it in place — re-running the same command is safe and idempotent.

---

## Update

Re-run the same install command at any time to update to the latest version. The installer removes the old `~/.memoriahub/app` directory, rebuilds from source, and redeploys the standalone app.

```bash
# Public repo
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash

# Local clone
MEMORIAHUB_SRC=~/MemoriaHub bash ~/MemoriaHub/install.sh
```

---

## Uninstall

```bash
# If piping from curl
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash -s -- --uninstall

# From a local clone
bash ~/MemoriaHub/install.sh --uninstall
```

Removes `~/.memoriahub/app` and the `~/.local/bin/memoriahub` shim. Configuration and manifests in `~/.memoriahub/` are not removed.

---

## Requirements

The installer checks each dependency and prints the detected version before proceeding.

| Dependency | Minimum version | Notes |
|------------|-----------------|-------|
| Node.js    | 18              | Enforced by installer |
| npm        | bundled with Node | Any version that ships with Node 18+ |
| git        | any             | Used for shallow clone |
| curl       | any             | Used by the curl-pipe flow |

---

## What the installer does

1. Clones the repository (or copies `MEMORIAHUB_SRC`) to a temp directory.
2. Runs `npm install -w apps/cli` and `npm run build -w apps/cli` to compile TypeScript.
3. Copies `dist/` and `package.json` to `~/.memoriahub/app/`.
4. Runs `npm install --omit=dev` inside `~/.memoriahub/app/` to install only runtime dependencies.
5. Writes a shell shim at `~/.local/bin/memoriahub` that executes `node ~/.memoriahub/app/dist/index.js`.
6. Warns if `~/.local/bin` is not on `$PATH`.

### Installer environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORIAHUB_REPO` | `https://github.com/marinoscar/MemoriaHub.git` | Git clone URL |
| `MEMORIAHUB_REF` | `main` | Branch, tag, or commit to install |
| `MEMORIAHUB_HOME` | `~/.memoriahub` | Root directory for app install and config |
| `MEMORIAHUB_BIN_DIR` | `~/.local/bin` | Directory where the `memoriahub` shim is placed |
| `GITHUB_TOKEN` | _(unset)_ | GitHub PAT injected into the clone URL for private repos |
| `MEMORIAHUB_SRC` | _(unset)_ | Local source directory; skips git clone entirely |

### PATH note

If `~/.local/bin` is not in your `$PATH`, add this line to `~/.bashrc` or `~/.zshrc` and reload your shell:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

---

## Configuration and authentication

Before running `import` or `sync`, authenticate with your server:

```bash
memoriahub login
```

The command prompts interactively for:

- **Server URL** — the base URL of your MemoriaHub instance (e.g. `https://memoriahub.example.com`)
- **Personal Access Token (PAT)** — create one in the web app under **Settings > Personal Access Tokens**

The CLI validates the token by calling `GET /api/auth/me`. On success, credentials are written to `~/.memoriahub/config.json` with mode `0600`. Credentials are never accepted as positional arguments.

| Path | Purpose |
|------|---------|
| `~/.memoriahub/config.json` | Server URL and PAT (mode 0600) |
| `~/.memoriahub/app/` | Installed CLI app (dist + node_modules) |
| `~/.local/bin/memoriahub` | Shell shim |

---

## Commands

### Global options

| Flag | Short | Description |
|------|-------|-------------|
| `--no-color` | | Disable colored output; also respects `NO_COLOR` env variable |
| `--version` | `-V` | Print the installed version |

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

Each file is SHA-256 hashed locally before upload. The CLI queries `GET /api/media?contentHash=<sha256>` to check whether the file is already stored on the server. Files that match are skipped; only new files are uploaded. A per-folder manifest is written to `~/.memoriahub/manifests/<sha256-of-folder-path>.json` recording the result of each file. After the run, a boxed summary table shows total, uploaded, skipped, and failed counts.

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

Print a columnar status table for every folder that has been imported or synced.

```bash
memoriahub status
```

Output columns: Folder, Last Sync, Total, Uploaded, Pending, Failed. Pending and Failed counts are highlighted yellow and red respectively when non-zero.

---

## Deduplication

The CLI uses a two-layer dedup strategy:

1. **Local manifest** (`sync` only) — if a file's path and SHA-256 match a previous `uploaded` entry, the file is skipped entirely without a network call.
2. **Server content hash** — before uploading any file, the CLI sends `GET /api/media?contentHash=<sha256>`. If the server already holds a media item with that hash (regardless of filename or folder), the upload is skipped.

Re-running `sync` across multiple sessions or on overlapping folders never creates duplicates.

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

## Supported file types

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

## Large file uploads

Files are uploaded using the server's resumable multipart upload API (init → upload parts → complete). The default chunk size is 10 MB. There is no cap on the number of parts, so files larger than 500 MB are handled correctly. A progress bar (powered by `cli-progress`) updates after each part.

---

## Manual / from-source build (contributors)

Dependencies and the build step must be run from the repo root (npm workspaces):

```bash
# Install workspace dependencies
npm install

# Compile the CLI
npm run build -w apps/cli
```

The compiled output lands in `apps/cli/dist/` (gitignored). After building, invoke the CLI directly:

```bash
node apps/cli/dist/index.js <command>
```

The binary name registered in `package.json` is `memoriahub`.

---

## Related documentation

- [Phase 05 — CLI Importer](../../docs/plan/phase-05-cli-importer.md)
- [API Reference](../../docs/API.md)
- [Architecture](../../docs/ARCHITECTURE.md)
