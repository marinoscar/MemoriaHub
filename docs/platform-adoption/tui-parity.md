# TUI parity: the 1.3 TUI against the platform TUI (RETRO-F4, #582)

Issue [#582](https://github.com/marinoscar/MemoriaHub/issues/582) moved MemoriaHub's terminal UI from its own ink application (`apps/cli/src/tui/app.tsx`, 920 lines) onto the platform TUI framework (`@marinoscar/platform-cli/tui`, `@marinoscar/platform-*@0.1.0-next.25`). This page is the parity record: where every menu entry and screen went, how it was proven, and every difference, with the reason.

## How parity is proven

| Evidence | Where |
|---|---|
| Frames of the 1.3 TUI (root menu, every submenu, the first frame of each network-free screen; 100 columns, logged out and in) | `apps/cli/test/fixtures/tui-snapshots/before` (committed before any change, `test(cli): pin TUI parity snapshots`) |
| The same frames through the platform TUI | `apps/cli/test/fixtures/tui-snapshots/after`, written by `apps/cli/test/tui/parity-snapshots.spec.tsx` |
| `diff -rq before after` | every screen frame is identical (factory reset, date range, convert file input, folder picker, folders, app settings, report, login); only the 14 menu frames differ, for the reasons in [Differences](#differences) |
| Every 1.3 menu assertion kept | `apps/cli/test/menu-config.spec.ts` (re-pointed at the platform helpers), `apps/cli/test/tui/menu-navigation.spec.tsx` (replaces `home-menu`, `menu-nav`, `backup-menu-nav`) |
| The platform `tui` conformance suite | `apps/cli/test/conformance.spec.ts`: menu references, lazy screens, no ink import, labels, reducer purity of the three dashboards, every screen at 80/40/24 columns, no colour in monochrome, the login gate |
| A real terminal | the built CLI in a pty: bare `memoriahub` opens the TUI, `Settings`, `Factory reset`, `File Tools`, `Help`, Esc one level at a time and `q` to quit |

The `before` set has no frames for `convert`, `date-infer` and `screenshots` logged out: the 1.3 generator did not pass the inherited `loggedOut` flag when rendering those submenus directly, so it skipped them. The `after` set has them.

## Menu map

The key path to every screen is unchanged. A leaf's route is the 1.3 action id; all routes are lazy (`tui/screens.ts`).

| Menu path | Route | Screen |
|---|---|---|
| Login / Change server (logged out only) | `memoriahub-login` | `LoginScreen` |
| Sync › Sync all folders… | `sync-all` | `DateRangeFilter` → `SyncDashboard` |
| Sync › Sync selected folders… | `sync-select` | `PickFolders` → `DateRangeFilter` → `SyncDashboard` |
| Sync › Retry failed files | `retry` | `SyncDashboard` (retry mode) |
| Scan › Scan all folders | `scan-all` | `ScanScreen` |
| Scan › Scan selected folders… | `scan-select` | `PickFolders` → `ScanScreen` |
| Scan › View last scan report | `scan-report` | `ScanScreen` (view) |
| Backup | `backup-dashboard` | `BackupDashboard` (→ `BackupVerify`, `BackupSettings`) |
| Worker Node › Node dashboard | `node-dashboard` | `NodeDashboard` (→ `NodeConfig`) |
| Worker Node › Start worker (background) | `node-start` | `NodeStart` (→ `NodeDashboard`) |
| Worker Node › Stop worker / Node logs / Node doctor | `node-stop`, `node-logs`, `node-doctor` | `NodeStop`, `NodeLogs`, `NodeDoctor` |
| Worker Node › Enroll node / Install dependencies / Register node / Node config / List nodes / Node service | `node-enroll`, `node-install-deps`, `node-register`, `node-config`, `node-list`, `node-service` | `NodeEnroll`, `NodeInstallDeps`, `NodeRegister`, `NodeConfig`, `NodeList`, `NodeService` |
| Reports › Overview / Runs / Storage / Duplicates | `report-<id>` (one per registered report) | `ReportView` |
| Reports › Job queue monitor | `jobs-monitor` | `JobsDashboard` |
| File Tools › Convert videos to MP4 › single file… / selected folders… / all | `convert-file`, `convert-select`, `convert-all` | `ConvertFileInput`/`PickFolders` → `ConvertScreen` |
| File Tools › Organize folder by date… | `organize` | `PickFolders` → `OrganizeScreen` |
| File Tools › Find/Clean Screenshots › find / move / delete… | `screenshots-find`, `screenshots-move`, `screenshots-delete` | `PickFolders` → `ScreenshotsScreen` |
| File Tools › Date Inference › Diagnose / Infer & write… | `date-infer-diagnose`, `date-infer-apply` | `PickFolders` → `DateInferenceScreen` |
| Settings › Manage folders / Manage circles / App settings | `folders`, `circles`, `app-settings` | `FolderManager`, `CircleManager`, `SettingsScreen` |
| Settings › Login / Change server | `memoriahub-login` | `LoginScreen` |
| Settings › Android app (build, publish, releases) | `android` | `AndroidScreen` (→ `LoginScreen`) |
| Settings › Factory reset | `factory-reset` | `FactoryResetScreen` |
| Help | `help` | `HelpRoute` (was inline in `app.tsx`) |
| Deploy (this server) | `deploy` | the platform's built-in (added, as the issue allows) |
| Quit | built in | the router's own Quit line |

A multi-step flow is one route with a step stack (`useViewStack` in `routes.tsx`), so Esc steps back through the flow as it did: Run → Pick folders → menu.

## Where each 1.3 file went

| 1.3 | Now |
|---|---|
| `app.tsx` (router, 920 lines), `HomeMenu`, `Menu`, `MenuList`, `menu-config.ts` | Deleted. `menu.ts` (data), `screens.ts`, `routes.tsx`; the pure helpers are the platform's (`buildTuiMenuTree`, `visibleTuiMenuChildren`, `tuiMenuItemLabel`, `tuiBreadcrumb`) |
| `raw-mode.ts` | Deleted. The terminal handling is the platform's (`resolveInteractiveStdin`); `render-tui.ts` is the 20-line safe launch the standalone `jobs` and `scan` dashboards use |
| `theme.ts` | Deleted. Colours resolve through the platform theme tokens (`ink.tsx`); brand hues in `src/brand.ts`, passed as `tuiTheme.brand` |
| `components/{StatusLine,ContextMeter,Legend,ActiveUploads,EventLog,Summary}` | Deleted. `StatusLine`, `SegmentMeter`, `MeterLegend`, `ActiveItems`, `EventLog`, `RunSummary` of `@marinoscar/platform-cli/tui/ui`, with the MemoriaHub vocabulary in `sync-view.tsx` |
| `node-dashboard-source.ts`, `backup-dashboard-source.ts` | The pure state and reducers stay; the source classes are a platform `DashboardSource` over `daemonAttachFeed` (attached) or a feed over the in-process engine (embedded) |
| `JobsDashboard` polling | `jobs-dashboard-source.ts`: a reducer over `pollFeed` |
| The F3 bridge (`extensions/legacy-tui*.ts(x)`, the `launchLegacyTui` seam of `run.ts`) | Deleted |
| Shared state in `App` (config, db, circles, update status, folder count) | `app-state.ts`: selection `circle`, selection `folders` (first-run hint), state loader `update-info`, the local database handle; each route reads the config it needs |

## Differences

Every difference, so the owner can approve or reverse it.

| Difference | Why | Reverse by |
|---|---|---|
| **Frame style.** The platform frame: header `MemoriaHub CLI v1.4.0 · Home › Sync`, `❯` cursor, footer `↑↓ move · enter select · 1-9 jump · esc back · ctrl-c exit`, a default subtitle `Choose an entry. Esc goes up one level.` (1.3: a `Menu › Sync` title, `>` cursor, `[1-9] jump [↑/↓] move [Enter] select [Esc] back`). The root breadcrumb reads `Home`, not `Menu` | The frame is the platform's | Platform frame options (seam request) |
| **No ASCII banner, identity box or DB path on the root menu.** The header shows the server; the active circle and the first-run folder hint are chips (`[Circle: …]`, `[Folders: none registered — start with Settings › Manage folders]`) | The platform menu has no free-text slot. The hint and the circle keep their information; the banner art and the `DB:` line are dropped. `ui.ts` still prints the banner for the headless `--help` | A banner/slot option upstream |
| **"Update available" is shown on Help, not on the root menu** (and, as before, once on stderr after a command by the platform's update notice) | No slot on the platform menu | A slot upstream |
| **Quit is the router's line after Deploy** (`Quit`, not numbered), and a `Deploy  (this server)` entry is added | The issue allows the platform `deploy`; Quit is always last in the platform router | none (decided) |
| **`q` no longer goes back from a submenu.** `Esc` goes back one level; `q` quits from the root only. Inside a screen `Esc` / `q` go back as before | The platform menu's keys | Platform menu keys |
| **The login gate for a logged-out user on a login-required entry shows the platform notice** (`[l] login  [q/Esc] back`), not the 1.3 text. A route that finds no CLI config still shows the 1.3 text | The platform owns the gate | none |
| **The node and backup dashboards reconnect by themselves** every 2 seconds after the daemon goes away (the memory valve restarts a worker). Header `connecting…` before the first attach. `[r]` while disconnected re-attaches at once | The platform attach feed reconnects. The 1.3 dashboard stayed disconnected until `[r]` | none |
| **The backup dashboard says "Reconnecting automatically…"** instead of "Reopen this screen to re-attach." | Follows from the line above | none |
| **The job monitor's `r` swaps in a fresh source seeded with the data on screen** (same effect: an immediate poll, last good data stays) | A poll feed has no "poll now" | `pollNow` upstream |
| **Colours come from the theme tokens**, with the same default hues (`cyan` primary, `green` success, `yellow` warning, `red` error, `blue` info, `gray` dim, `magenta` accent); a monochrome theme draws none | The issue asks for tokens | none |
| `Help` text: the `q` line now reads "Esc back one level … q quit from the main menu" | Matches the keys above | none |

## Behaviours that must survive (issue inventory C)

| Behaviour | Where it is proven |
|---|---|
| Breadcrumbs (`Home › Worker Node`) | `menu-navigation.spec.tsx`, `menu-config.spec.ts` |
| Digit accelerators 1–9 with aligned padding, `▸` and `…` | `menu-config.spec.ts` (`tuiMenuItemLabel`), `menu-navigation.spec.tsx` |
| `loggedOut` cascade and `hideWhenLoggedIn` | `menu-config.spec.ts` |
| Submenu subtitles, red destructive entries | `menu-navigation.spec.tsx`, `menu-config.spec.ts` |
| Esc = back one level (route history) | `menu-navigation.spec.tsx` (File Tools › Screenshots → File Tools → root) |
| Node dashboard attaches to a running daemon over `~/.memoriahub/node.sock` and detaches without stopping it | `dashboard-attach-smoke.spec.ts` (real daemon host on a throwaway socket) |
| `[s]` spawns the memory-tuned detached daemon, `[e]` runs in-process with the warning, the doctor overlay | `node-dashboard-daemon-start.spec.tsx`, `node-dashboard-doctor-overlay.spec.tsx` (unchanged) |
| Backup dashboard attaches to a daemon with a bound root, else runs embedded | `backup-dashboard.spec.tsx`, `backup-dashboard-source.spec.ts` |
| Live job monitor | `jobs-dashboard.spec.tsx` |
| Update notice after the TUI exits | The platform's `updateNotice` (F3), unchanged |
| Raw-mode restore on exit/crash | The platform router (`useApp().exit()`); `render-tui.spec.ts` for the standalone dashboards |
| No token or `nod_` credential in a frame; factory reset and `screenshots-delete` keep their confirm steps | Screens unchanged; `factory-reset` frame identical |

## Seam gaps found (for EnterpriseAppBase)

| Gap | Effect here | Workaround |
|---|---|---|
| A built-in TUI screen cannot be hidden, and a screen no entry opens is listed at the root | The platform `login`/`invoke`/`status`/`jobs`/`node`/`logout` would appear in MemoriaHub's menu | Parked in a never-visible section (`PLATFORM-ADOPTION-SHIM`, local-exceptions) |
| `runPlatformConformance({ suites: { tui: { skip: { check: reason } } } })`: the runner treats any `skip` key of a suite as "skip the whole suite" and throws on the object | A check cannot be skipped with a reason | `conformance.spec.ts` passes `nodes` without the parked section instead |
| `daemonAttachFeed` is read-only and speaks only the platform protocol | The 1.3 daemon needs a `connect` adapter and a command side channel | `tui/legacy-daemon.ts` until RETRO-C10 |
| A poll feed has no "poll now" | `[r]` on the job monitor | A seeded replacement source |
| The platform menu has no banner/footnote slot | Banner art, DB path, update banner | Chips and Help |
