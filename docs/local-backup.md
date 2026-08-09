# Local Media Backup — User Guide

A **backup node** is a machine you own — a home server, a NAS, a spare laptop — that keeps a second, independent copy of your MemoriaHub library on its own local disk (or an external drive, or a network share). It runs alongside, or instead of, a worker node's enrichment compute; the two are unrelated features that just happen to share the same `memoriahub node` identity.

This guide gets you from zero to a scheduled, self-healing backup in about ten minutes. For the architecture, data model, and API contract behind everything here, see the [Local Media Backup specification](specs/local-backup.md); for compute-node setup (a different feature that shares the same node registration), see [Worker Node Setup & Troubleshooting](worker-node-setup.md).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Set Up a Backup Node in 10 Minutes](#2-set-up-a-backup-node-in-10-minutes)
3. [Reading `backup status`](#3-reading-backup-status)
4. [Browsing the Folder](#4-browsing-the-folder)
5. [Querying the Catalog with `sqlite3`](#5-querying-the-catalog-with-sqlite3)
6. [Verifying Your Backup](#6-verifying-your-backup)
7. [What Quarantine Means, and How to Prune It](#7-what-quarantine-means-and-how-to-prune-it)
8. [Restoring After a Disaster](#8-restoring-after-a-disaster)
9. [Running Two Backup Nodes](#9-running-two-backup-nodes)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

- The [MemoriaHub CLI](../apps/cli/README.md) installed on the machine that will hold the backup (`curl ... | bash` — see the CLI README's install instructions).
- A MemoriaHub account with at least one circle you want backed up.
- Enough free disk space at the destination for your library — a photo/video library at its original resolution, uncompressed by this feature (backup stores original bytes, never a re-encoded or thumbnailed copy).
- (Recommended) A machine that can stay on and reachable at least occasionally — an always-on box is ideal for scheduled backups, but a laptop you plug in weekly works too; the sync is fully incremental and self-heals after any amount of downtime.

---

## 2. Set Up a Backup Node in 10 Minutes

### Step 1 — Log in

```bash
memoriahub login
```

Follow the browser prompt to approve the device. This issues a personal token stored at `~/.memoriahub/config.json`.

### Step 2 — Enroll a dedicated backup credential (recommended)

`backup init` will offer to do this for you interactively the first time, but you can also do it up front:

```bash
memoriahub node enroll
```

This mints a durable, least-privilege `nod_` credential scoped only to the node control plane — it can never be used to browse your library, change settings, or do anything a normal login token could. Since a backup node typically runs unattended for a long time, this is safer than leaving a regular 90-day personal token on the machine.

### Step 3 — Initialize the backup root

```bash
memoriahub backup init --dest /path/to/backup/folder
```

This creates the destination folder if it doesn't exist, registers the machine as a worker node (or reuses one you already registered), enables backup on the server for that node, and creates the SQLite catalog. By default it backs up **every circle you belong to** — narrow that with `--circles <id1>,<id2>`:

```bash
memoriahub backup init --dest /mnt/backup-drive/memoriahub --circles 3f2a...,9b1c...
```

Only one backup root is supported per machine. Re-running `init` against the same `--dest` is safe and simply re-binds/refreshes it.

### Step 4 — Run the first backup

```bash
memoriahub backup run
```

The first run backs up everything in scope, so expect it to take a while on a large library — it will print live progress (items downloaded, bytes, errors) as it goes. It's safe to `Ctrl-C` at any point; re-running `memoriahub backup run` picks up exactly where it left off, never re-downloading anything already saved.

### Step 5 — Set a schedule

```bash
memoriahub backup schedule "0 3 * * *" --tz America/Costa_Rica
```

This tells the server to consider a backup "due" every day at 3 AM in that timezone. **Scheduled backups only fire from a running daemon** — see the next step.

### Step 6 — Keep it running unattended

Pick one:

```bash
# Option A: an always-on background process (until you log out / reboot)
memoriahub node start --daemon

# Option B (recommended for a server/NAS): a systemd service that survives reboots
memoriahub node service install
loginctl enable-linger $USER   # keeps it running after you log out
```

That's it — the daemon polls the server once a minute, and starts a backup run whenever the schedule you set in Step 5 comes due. If the machine is off or asleep at the scheduled time, the very next time the daemon comes back up it notices the backup is overdue and runs it immediately — nothing is ever silently skipped.

---

## 3. Reading `backup status`

```bash
memoriahub backup status
```

This prints three independent sections, each labeled with where its information came from:

```
Local catalog (/mnt/backup-drive/memoriahub)  [local catalog]
  Items      : 18,204 (412.6 GB) — 18,190 present, 4 failed, 10 trashed, 812 archived
  Checkpoint : 2026-08-08T14:02:11.000Z
  Last run   : completed at 2026-08-08T14:00:03.000Z — 32 downloaded, 0 error(s)

Daemon  [daemon (IPC)]
  Run active : no (idle)
  Rate       : concurrency 2, max unlimited

Server  [server]
  Enabled    : yes
  Schedule   : 0 3 * * * (America/Costa_Rica)
  Next run   : 2026-08-09T09:00:00.000Z
  Pending    : 0 item(s), 0 B behind the checkpoint
  Recent runs:
    2026-08-08T09:00:00.000Z  completed (scheduled) — 32 downloaded, 0 error(s)
```

- **Local catalog** works completely offline — it just reads the SQLite file on disk. This is what you'd check to confirm the backup itself is healthy, even with no network at all.
- **Daemon** is live, over the local IPC socket, and only appears populated when `node start --daemon` (or the systemd service) is actually running.
- **Server** reflects what the server currently believes: whether backup is enabled, the schedule, when the next run is due, and how far behind ("pending") the checkpoint is if the node hasn't synced in a while.

Each section degrades gracefully and independently — if you're offline, the Server section just says so and the Local catalog section still reports fully.

Add `--json` for a machine-readable version of the same report.

---

## 4. Browsing the Folder

Open the backup root in any file manager. You'll find:

```
media/2024/07/IMG_4521.jpg          ← your July 2024 photos
media/2024/07/IMG_4521.jpg.json     ← a sidecar with everything MemoriaHub knows about it
media/unknown-date/scan0001.jpg     ← anything with no capture date
archived/2023/11/old-photo.heic     ← items you archived on the server
```

Files are organized by the month they were **taken** (using EXIF capture date, not the date they were uploaded or backed up), which makes browsing feel like a normal photo library. Archived items live in their own `archived/` tree so they're easy to tell apart from your active library, mirroring the Archive feature on the server.

Every media file has a matching `.json` sidecar next to it with its tags, album names, the people tagged in it, description, favorite status, location, and more — plain text, readable by anything.

---

## 5. Querying the Catalog with `sqlite3`

The backup catalog is a real SQLite database at `<your backup root>/.memoriahub/backup.db` — no special tool required, just [`sqlite3`](https://www.sqlite.org/cli.html) (pre-installed on macOS/Linux; `winget install sqlite.sqlite` on Windows).

```bash
# How much is backed up, in total?
sqlite3 /mnt/backup-drive/memoriahub/.memoriahub/backup.db \
  "SELECT COUNT(*) AS items, SUM(size) / 1e9 AS gb FROM items WHERE status = 'present'"

# Everything shot in a given month
sqlite3 /mnt/backup-drive/memoriahub/.memoriahub/backup.db \
  "SELECT rel_path FROM items WHERE captured_at LIKE '2024-07%'"

# Photos of a specific person
sqlite3 /mnt/backup-drive/memoriahub/.memoriahub/backup.db \
  "SELECT i.rel_path FROM items i
   JOIN item_people p ON p.media_item_id = i.media_item_id
   WHERE p.person_name = 'Grandma'"

# Any problems right now?
sqlite3 /mnt/backup-drive/memoriahub/.memoriahub/backup.db \
  "SELECT status, COUNT(*) FROM items GROUP BY status"
```

This is a deliberate feature, not an accident — you should never need to install MemoriaHub itself, or even have the CLI, to answer "do I have a backup of X" or "how big is my archive" from this file alone.

---

## 6. Verifying Your Backup

Trust, but verify — literally:

```bash
memoriahub backup verify
```

By default this checks that every backed-up file still exists and is the right size, and fully re-hashes (SHA-256) only the files that haven't been cryptographically proven yet — new downloads, or anything that previously failed. This is fast even on a huge library because it skips re-hashing files it already proved intact last time.

For a full, no-shortcuts integrity check (recommended occasionally, e.g. once a year, or after moving the backup to a new drive):

```bash
memoriahub backup verify --deep
```

Nothing is ever deleted or moved by `verify` — a problem it finds (a missing file, wrong size, or a bad hash) is simply flagged for re-download on your next `memoriahub backup run`.

Every backup run also automatically upgrades itself to a full **reconcile** pass — comparing your entire local catalog against everything the server currently has — about once a month, so drift (files the server deleted that you haven't noticed, or hash mismatches) gets caught on its own without you doing anything. Force one immediately with:

```bash
memoriahub backup run --reconcile
```

---

## 7. What Quarantine Means, and How to Prune It

If a reconcile pass finds a local file the server no longer has (because you permanently deleted it, emptied the Trash, or it fell out of the node's circle scope), it does **not** delete your local copy. Instead it moves the file into a `_quarantine/` folder inside your backup root, preserving its original path — so you always have one last chance to look at it before it's gone for good.

See what's in quarantine:

```bash
memoriahub backup prune
```

Without `--yes`, this only **lists** what's there — nothing is touched. When you're ready to actually free the space:

```bash
memoriahub backup prune --yes
```

You'll be asked to confirm (unless you're running non-interactively, in which case `--yes` is required). Only quarantine items older than N days:

```bash
memoriahub backup prune --older-than 90 --yes
```

`prune --yes` is the **only** command in the whole backup feature that permanently deletes anything from your backup root — an ordinary sync, verify, or even a failed reconcile can never do that on their own.

---

## 8. Restoring After a Disaster

If you ever need to rebuild a MemoriaHub library — a lost server, a fresh install, or moving to a new provider — your backup root is a complete, self-sufficient source to restore from.

```bash
memoriahub login    # log into the (new) server with a normal account, not a node credential
memoriahub backup restore --root /mnt/backup-drive/memoriahub --dry-run
```

`--dry-run` prints exactly what would happen — which circles would be created or matched, how many items and how much data, without writing anything. When you're happy with the plan, drop `--dry-run`:

```bash
memoriahub backup restore --root /mnt/backup-drive/memoriahub
```

This re-uploads every original file and reapplies its tags, album membership, people, description, favorite status, and (if manually set) location. Things that regenerate automatically from the photo itself — thumbnails, detected faces, AI tags — are **not** restored from the backup; the server's own enrichment pipeline rebuilds them fresh from the uploaded bytes.

By default, every source circle is matched to (or created as) a circle with the same name under your account. To land everything in one existing circle instead:

```bash
memoriahub backup restore --root /mnt/backup-drive/memoriahub --into-circle <targetCircleId>
```

Or map specific circles individually:

```bash
memoriahub backup restore --root /mnt/backup-drive/memoriahub \
  --map-circle 3f2a...=9b1c... --map-circle 4d5e...=1a2b...
```

Restore is interruption-safe — if it gets cut off partway through, just run it again; it picks up exactly where it left off and never re-uploads anything already restored.

---

## 9. Running Two Backup Nodes

There's no special setup for redundancy — just run `backup init` on a second machine, pointed at its own destination:

```bash
# On your home server
memoriahub backup init --dest /srv/memoriahub-backup

# On a laptop you sync less often, as a second, independent copy
memoriahub backup init --dest ~/memoriahub-backup
```

Each machine keeps its own catalog, its own schedule, and its own progress — they never talk to each other, and neither can interfere with the other's sync. Two nodes backing up the same circles will simply end up with the same content, each having independently replayed the same history from the server.

---

## 10. Troubleshooting

**"No backup root is configured on this machine."** — Run `memoriahub backup init --dest <dir>` first.

**Scheduled backups aren't firing.** — Scheduled backups only run from inside a live daemon. Confirm one is running with `memoriahub node status`, and if not, start it with `memoriahub node start --daemon` or install it as a service with `memoriahub node service install`. Check `memoriahub backup status` — the Server section shows whether a schedule is set and enabled, and the "Next run" timestamp.

**A backup run is stuck "already active."** — If a previous run crashed hard enough to never report back, the server automatically releases it as stale after about 15 minutes; just wait, or check `memoriahub backup status` for the currently active run.

**Some items keep failing.** — Run `memoriahub backup verify` to see exactly which ones and why; they'll be automatically retried on your next `memoriahub backup run`.

**I want to slow down / speed up the backup** (protect a shared home connection, or use more bandwidth on a fast link):

```bash
memoriahub backup set-rate --max-mbps 20   # cap at 20 Mbps
memoriahub backup set-rate --concurrency 4 # more parallel downloads
memoriahub backup set-rate --max-mbps 0    # remove the cap
```

If a daemon is currently running a backup, the new rate applies immediately — no restart needed.

For deeper diagnostics and the full command reference, see the [CLI README](../apps/cli/README.md#local-backup-mirror-your-library) and the [Local Media Backup specification](specs/local-backup.md).
