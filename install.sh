#!/usr/bin/env bash
# install.sh — MemoriaHub CLI installer / updater
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash
#   # or, locally:
#   bash install.sh
#   bash install.sh --uninstall
#   bash install.sh --help
#
# Configuration (set via environment variables before running):
#   MEMORIAHUB_REPO     Git repo URL (default: https://github.com/marinoscar/MemoriaHub.git)
#   MEMORIAHUB_REF      Branch/tag/commit to install (default: main)
#   MEMORIAHUB_HOME     App install root (default: $HOME/.memoriahub)
#   MEMORIAHUB_BIN_DIR  Directory for the `memoriahub` shim (default: $HOME/.local/bin)
#   GITHUB_TOKEN        Optional GitHub PAT for private-repo clones
#   MEMORIAHUB_SRC      Optional: local directory to install from (skips git clone).
#                       Useful for offline installs and local testing:
#                         MEMORIAHUB_SRC=/path/to/repo bash install.sh
#
# NOTE: The public `curl | bash` flow requires the repository to be public (or
# GITHUB_TOKEN set for private repos). The MEMORIAHUB_SRC path lets you verify
# installer logic locally without any network access.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# ANSI color helpers (honor NO_COLOR)
# ---------------------------------------------------------------------------
_use_color() {
  [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]
}

_c() {
  # _c <code> <text>
  if _use_color; then
    printf '\033[%sm%s\033[0m' "$1" "$2"
  else
    printf '%s' "$2"
  fi
}

GREEN=32; CYAN=36; YELLOW=33; RED=31; BOLD=1; DIM=2

ok()   { printf '%s %s\n'  "$(_c $GREEN  "✔")" "$1"; }
err()  { printf '%s %s\n'  "$(_c $RED    "✖")" "$1" >&2; }
warn() { printf '%s %s\n'  "$(_c $YELLOW "⚠")" "$1"; }
info() { printf '%s %s\n'  "$(_c $CYAN   "ℹ")" "$1"; }
step() { printf '\n%s %s\n' "$(_c $BOLD  "→")" "$(_c $BOLD "$1")"; }
dim()  { printf '  %s\n'   "$(_c $DIM   "$1")"; }

# ---------------------------------------------------------------------------
# Box printer (ANSI, no external deps)
# ---------------------------------------------------------------------------
print_box() {
  local title="${1:-}"
  shift
  local lines=("$@")
  local width=60
  local pad="  "

  local border_h
  border_h=$(printf '─%.0s' $(seq 1 $width))

  if _use_color; then
    printf '\033[36m╭%s╮\033[0m\n' "$border_h"
    if [[ -n "$title" ]]; then
      local tpad=$(( (width - ${#title} - 2) / 2 ))
      printf '\033[36m│\033[0m%*s\033[1m%s\033[0m%*s\033[36m│\033[0m\n' \
        "$tpad" "" "$title" "$tpad" ""
      printf '\033[36m├%s┤\033[0m\n' "$border_h"
    fi
    for line in "${lines[@]}"; do
      printf '\033[36m│\033[0m %s%-*s \033[36m│\033[0m\n' \
        "${pad}" "$((width - ${#pad} - 1))" "$line"
    done
    printf '\033[36m╰%s╯\033[0m\n' "$border_h"
  else
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    if [[ -n "$title" ]]; then
      printf '| %-*s |\n' "$((width - 1))" "$title"
      printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    fi
    for line in "${lines[@]}"; do
      printf '| %-*s |\n' "$((width - 1))" "${pad}${line}"
    done
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
  fi
}

# ---------------------------------------------------------------------------
# Environment detection helpers
# ---------------------------------------------------------------------------
# Detect Windows Subsystem for Linux (WSL 1 or 2). WSL exports WSL_DISTRO_NAME
# and the kernel release / /proc/version advertise "microsoft" or "WSL".
is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null && return 0
  uname -r 2>/dev/null | grep -qiE '(microsoft|wsl)' && return 0
  return 1
}

# Best-effort guess at the interactive shell's rc file so PATH guidance points
# at the right place. Defaults to ~/.bashrc (the WSL default shell).
detect_shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "$HOME/.zshrc" ;;
    *)     printf '%s' "$HOME/.bashrc" ;;
  esac
}

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
MEMORIAHUB_REPO="${MEMORIAHUB_REPO:-https://github.com/marinoscar/MemoriaHub.git}"
MEMORIAHUB_REF="${MEMORIAHUB_REF:-main}"
MEMORIAHUB_HOME="${MEMORIAHUB_HOME:-$HOME/.memoriahub}"
MEMORIAHUB_BIN_DIR="${MEMORIAHUB_BIN_DIR:-$HOME/.local/bin}"
MEMORIAHUB_SRC="${MEMORIAHUB_SRC:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

APP_DIR="$MEMORIAHUB_HOME/app"
BIN_SHIM="$MEMORIAHUB_BIN_DIR/memoriahub"

# ---------------------------------------------------------------------------
# Read the "version" field from a package.json using node (a hard dependency).
# Falls back to a grep/sed parse if node is unavailable for any reason.
# ---------------------------------------------------------------------------
read_pkg_version() {
  local pkg_file="$1"
  [[ -f "$pkg_file" ]] || { printf 'unknown'; return; }
  if command -v node &>/dev/null; then
    node -p "require('$pkg_file').version" 2>/dev/null && return
  fi
  grep -m1 '"version"' "$pkg_file" 2>/dev/null \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
    || printf 'unknown'
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION="uninstall" ;;
    --help|-h)   ACTION="help" ;;
    --no-color)  export NO_COLOR=1 ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
show_help() {
  cat <<EOF

$(_c $BOLD "MemoriaHub CLI Installer")

USAGE
  bash install.sh [options]

OPTIONS
  (none)        Install or update the CLI
  --uninstall   Remove the CLI and its shim
  --help        Show this message
  --no-color    Disable ANSI colors

ENVIRONMENT VARIABLES
  MEMORIAHUB_REPO      Git clone URL  (default: $MEMORIAHUB_REPO)
  MEMORIAHUB_REF       Branch/tag     (default: $MEMORIAHUB_REF)
  MEMORIAHUB_HOME      Install root   (default: \$HOME/.memoriahub)
  MEMORIAHUB_BIN_DIR   Shim directory (default: \$HOME/.local/bin)
  GITHUB_TOKEN         GitHub PAT for private repos (optional)
  MEMORIAHUB_SRC       Local source directory — skip git clone (optional)
                       Example: MEMORIAHUB_SRC=/path/to/repo bash install.sh

NOTE
  The public curl | bash flow requires the repo to be public (or GITHUB_TOKEN
  set). Use MEMORIAHUB_SRC for offline / local testing.

EOF
}

if [[ "$ACTION" == "help" ]]; then
  show_help
  exit 0
fi

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
  step "Uninstalling MemoriaHub CLI"

  if [[ -d "$APP_DIR" ]]; then
    rm -rf "$APP_DIR"
    ok "Removed app directory: $APP_DIR"
  else
    warn "App directory not found: $APP_DIR"
  fi

  if [[ -f "$BIN_SHIM" ]]; then
    rm -f "$BIN_SHIM"
    ok "Removed shim: $BIN_SHIM"
  else
    warn "Shim not found: $BIN_SHIM"
  fi

  ok "MemoriaHub CLI uninstalled."
}

if [[ "$ACTION" == "uninstall" ]]; then
  do_uninstall
  exit 0
fi

# ---------------------------------------------------------------------------
# Install / update
# ---------------------------------------------------------------------------

# Print header
printf '\n'
if _use_color; then
  printf '\033[36m  MemoriaHub CLI Installer\033[0m\n'
else
  printf '  MemoriaHub CLI Installer\n'
fi
printf '\n'

# Detect update vs fresh install, and capture the currently-installed version
# (if any) so we can show an old → new transition at the end.
PREV_VERSION=""
if [[ -d "$APP_DIR" ]]; then
  PREV_VERSION="$(read_pkg_version "$APP_DIR/package.json")"
  info "Updating existing installation at $APP_DIR"
  [[ -n "$PREV_VERSION" && "$PREV_VERSION" != "unknown" ]] && dim "Currently installed: v$PREV_VERSION"
else
  info "Installing MemoriaHub CLI to $APP_DIR"
fi

# ---------------------------------------------------------------------------
# Step 1: Dependency checks
# ---------------------------------------------------------------------------
step "Checking dependencies"

# Report platform so native-module (better-sqlite3) issues are easier to triage.
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"
info "Platform  $(_c $DIM "${UNAME_S} ${UNAME_M}")"

check_tool() {
  local name="$1"
  local min_major="${2:-0}"
  if ! command -v "$name" &>/dev/null; then
    err "$name is required but not found."
    case "$name" in
      node) warn "Install Node.js >= 20 from https://nodejs.org or via nvm: https://github.com/nvm-sh/nvm" ;;
      npm)  warn "npm ships with Node.js; reinstall from https://nodejs.org" ;;
      git)  warn "Install git from https://git-scm.com" ;;
      curl) warn "Install curl via your package manager (e.g. apt install curl)" ;;
    esac
    exit 1
  fi

  local version
  version="$("$name" --version 2>&1 | head -1)"

  # Node.js version gate
  if [[ "$name" == "node" && "$min_major" -gt 0 ]]; then
    local major
    major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
    if [[ "$major" -lt "$min_major" ]]; then
      err "Node.js >= ${min_major} is required (found: $version)"
      warn "Upgrade via nvm: nvm install --lts"
      exit 1
    fi
  fi

  ok "$name  $(_c $DIM "$version")"
}

check_tool node 20
check_tool npm
check_tool git
check_tool curl

# Informational note about native dependencies.
# better-sqlite3 v12 ships prebuilt binaries for Node 20, 22, 23, 24, 25, 26
# on linux-x64, linux-arm64, and macOS (x64 + arm64).  Most users will NOT
# need a C compiler.  If a prebuild is unavailable for your platform/Node
# version, the install will fall back to compiling from source — in that case
# build-essential + python3 (Linux) or Xcode Command Line Tools (macOS) are
# required.
if ! command -v cc &>/dev/null && ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
  info "No C compiler found — this is fine if a prebuilt SQLite binary is available for your platform."
  dim "  If the sqlite probe below fails, install build tools and re-run:"
  dim "    Debian/Ubuntu : sudo apt install build-essential python3"
  dim "    macOS         : xcode-select --install"
  dim "  Or force source build: npm_config_build_from_source=true bash install.sh"
fi

# Warn (don't fail) if the install target looks low on free space. The CLI plus
# its node_modules (better-sqlite3, ink, react, …) needs roughly 150 MB.
if command -v df &>/dev/null; then
  avail_kb="$(df -Pk "$MEMORIAHUB_HOME" 2>/dev/null || df -Pk "$HOME" 2>/dev/null)"
  avail_kb="$(printf '%s\n' "$avail_kb" | awk 'NR==2 {print $4}')"
  if [[ -n "${avail_kb:-}" && "$avail_kb" =~ ^[0-9]+$ ]]; then
    if (( avail_kb < 204800 )); then
      warn "Low disk space at install target ($(( avail_kb / 1024 )) MB free; ~150 MB needed)"
    else
      ok "Disk space  $(_c $DIM "$(( avail_kb / 1024 )) MB free")"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Get source (clone or use local)
# ---------------------------------------------------------------------------
step "Preparing source"

TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
    dim "Cleaned up temp dir: $TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -n "$MEMORIAHUB_SRC" ]]; then
  if [[ ! -d "$MEMORIAHUB_SRC" ]]; then
    err "MEMORIAHUB_SRC directory not found: $MEMORIAHUB_SRC"
    exit 1
  fi
  info "Using local source: $MEMORIAHUB_SRC"
  # Copy to a temp dir so we don't pollute the working tree
  TMP_DIR="$(mktemp -d)"
  cp -r "$MEMORIAHUB_SRC/." "$TMP_DIR/"
  ok "Copied source to temp dir"
else
  TMP_DIR="$(mktemp -d)"
  local_repo="$MEMORIAHUB_REPO"

  # Inject GitHub token for private-repo support
  if [[ -n "$GITHUB_TOKEN" ]]; then
    # Replace https://github.com/ with https://<token>@github.com/
    local_repo="${MEMORIAHUB_REPO/https:\/\/github.com\//https:\/\/$GITHUB_TOKEN@github.com\/}"
    info "Using GITHUB_TOKEN for authentication"
  fi

  info "Cloning $MEMORIAHUB_REPO @ $MEMORIAHUB_REF …"
  git clone --depth 1 --branch "$MEMORIAHUB_REF" "$local_repo" "$TMP_DIR" 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done || {
    err "Git clone failed. If the repo is private, set GITHUB_TOKEN or use MEMORIAHUB_SRC."
    exit 1
  }
  ok "Cloned repository"
fi

# ---------------------------------------------------------------------------
# Announce the version we are about to install (read from the source manifest),
# and classify the transition relative to any currently-installed version.
# ---------------------------------------------------------------------------
SRC_VERSION="$(read_pkg_version "$TMP_DIR/apps/cli/package.json")"
if [[ -n "$SRC_VERSION" && "$SRC_VERSION" != "unknown" ]]; then
  if [[ -z "$PREV_VERSION" || "$PREV_VERSION" == "unknown" ]]; then
    ok "Installing MemoriaHub CLI $(_c $BOLD "v$SRC_VERSION")"
  elif [[ "$PREV_VERSION" == "$SRC_VERSION" ]]; then
    ok "Reinstalling MemoriaHub CLI $(_c $BOLD "v$SRC_VERSION") (same version)"
  else
    ok "Updating MemoriaHub CLI $(_c $BOLD "v$PREV_VERSION") → $(_c $BOLD "v$SRC_VERSION")"
  fi
else
  warn "Could not determine the version from the source manifest"
fi

# ---------------------------------------------------------------------------
# Step 3: Build the CLI workspace
# ---------------------------------------------------------------------------
step "Building CLI"

info "Installing CLI workspace dependencies …"
# -w apps/cli installs only the CLI workspace plus the root-level devDeps
# needed for TypeScript compilation, without triggering api/web workspace
# installs.
(
  cd "$TMP_DIR"
  npm install -w apps/cli --no-audit --no-fund 2>&1 \
    | grep -v "^$" \
    | grep -v "^npm warn deprecated" \
    | grep -v "^npm warn" \
    | while IFS= read -r line; do dim "$line"; done
) || {
  err "npm install failed"
  warn "If the error mentions node-gyp or node-pre-gyp, install build tools and re-run:"
  dim "    Debian/Ubuntu : sudo apt install build-essential python3"
  dim "    macOS         : xcode-select --install"
  exit 1
}
ok "Dependencies installed"

# apps/cli imports the shared @memoriahub/enrichment-compute package by
# subpath (e.g. .../clip, .../dto) resolved against its built dist/ — that
# output is git-ignored, so it must be built here on every fresh checkout
# before the CLI's TypeScript can compile (mirrors the identical fix already
# applied to .github/workflows/ci.yml).
info "Building shared enrichment-compute package …"
(
  cd "$TMP_DIR"
  npm run build --workspace=@memoriahub/enrichment-compute 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done
) || {
  err "Failed to build @memoriahub/enrichment-compute"
  exit 1
}
ok "Shared package built"

info "Compiling TypeScript …"
(
  cd "$TMP_DIR"
  npm run build -w apps/cli --no-audit --no-fund 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done
) || {
  err "Build failed"
  exit 1
}
ok "Build complete"

# ---------------------------------------------------------------------------
# Step 4: Deploy standalone app
# ---------------------------------------------------------------------------
step "Deploying standalone app"

# Remove old install
if [[ -d "$APP_DIR" ]]; then
  rm -rf "$APP_DIR"
fi
mkdir -p "$APP_DIR"

# Copy only the built artifacts + package manifest (not the full repo)
cp -r "$TMP_DIR/apps/cli/dist"        "$APP_DIR/dist"
cp    "$TMP_DIR/apps/cli/package.json" "$APP_DIR/package.json"
if [[ -f "$TMP_DIR/apps/cli/README.md" ]]; then
  cp "$TMP_DIR/apps/cli/README.md" "$APP_DIR/README.md"
fi

ok "Copied dist + package.json to $APP_DIR"

# ---------------------------------------------------------------------------
# Step 4a: Vendor the shared enrichment-compute package
# ---------------------------------------------------------------------------
# $APP_DIR runs OUTSIDE the monorepo, but apps/cli/package.json lists
# @memoriahub/enrichment-compute as a real runtime dependency (its compiled
# dist/*.js does `require()`/`import` the package by subpath, e.g. .../clip,
# .../dto — the same reason it had to be built in Step 3). It is a private,
# unpublished workspace package, so the runtime `npm install --omit=dev`
# below can never resolve it from the npm registry by name/version. Vendor
# the already-built package into the deployed app directory and repoint the
# dependency at it via a local `file:` reference so npm links it from disk
# instead of trying (and failing) to fetch it from the registry.
info "Vendoring shared enrichment-compute package …"
mkdir -p "$APP_DIR/vendor/enrichment-compute"
cp -r "$TMP_DIR/packages/enrichment-compute/dist"         "$APP_DIR/vendor/enrichment-compute/dist"
cp    "$TMP_DIR/packages/enrichment-compute/package.json" "$APP_DIR/vendor/enrichment-compute/package.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies["@memoriahub/enrichment-compute"] = "file:./vendor/enrichment-compute";
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$APP_DIR/package.json" || {
  err "Failed to vendor @memoriahub/enrichment-compute into $APP_DIR"
  exit 1
}
ok "Vendored enrichment-compute package"

info "Installing runtime dependencies (omitting devDeps) …"
# This runs OUTSIDE the monorepo, so npm installs only the CLI's own
# runtime deps (better-sqlite3, ink, react, commander, chalk, cli-table3, etc.).
# --legacy-peer-deps is required because react-reconciler@0.29.2 declares a
# peer on react@^18 while the CLI uses react@19; ink handles this at runtime.
(
  cd "$APP_DIR"
  npm install --omit=dev --legacy-peer-deps --no-audit --no-fund 2>&1 \
    | grep -v "^$" \
    | grep -v "^npm warn" \
    | while IFS= read -r line; do dim "$line"; done
) || {
  err "Runtime npm install failed"
  exit 1
}
ok "Runtime dependencies installed"

# ---------------------------------------------------------------------------
# Step 4b: Verify native SQLite module
# ---------------------------------------------------------------------------
info "Verifying native SQLite module …"
if ! node -e "require('$APP_DIR/node_modules/better-sqlite3')" 2>/dev/null; then
  err "better-sqlite3 native module did not load correctly."
  warn "The prebuilt SQLite binary is unavailable for this platform/Node version."
  warn "Remediation options:"
  dim "  1. Install build tools and re-run the installer:"
  dim "       Debian/Ubuntu : sudo apt install build-essential python3"
  dim "       macOS         : xcode-select --install"
  dim "  2. Force a source build:"
  dim "       npm_config_build_from_source=true bash install.sh"
  exit 1
fi
ok "$(_c $GREEN "SQLite native module OK")"

# ---------------------------------------------------------------------------
# Step 5: Write bin shim
# ---------------------------------------------------------------------------
step "Installing CLI shim"

mkdir -p "$MEMORIAHUB_BIN_DIR"

cat > "$BIN_SHIM" <<SHIM
#!/usr/bin/env bash
exec node "$APP_DIR/dist/index.js" "\$@"
SHIM

chmod +x "$BIN_SHIM"
ok "Shim written: $BIN_SHIM"

# ---------------------------------------------------------------------------
# Step 6: PATH check
# ---------------------------------------------------------------------------
BIN_ON_PATH=0
if echo ":$PATH:" | grep -q ":$MEMORIAHUB_BIN_DIR:"; then
  BIN_ON_PATH=1
fi

# Plain PATH guidance for non-WSL shells. WSL users get a dedicated, nicer
# call-out box printed after the completion summary (see below), so we skip
# this generic block for them to avoid duplicate messaging.
if [[ "$BIN_ON_PATH" != "1" ]] && ! is_wsl; then
  warn "$MEMORIAHUB_BIN_DIR is not on your PATH"
  printf '\n'
  info "Add the following line to your shell config (~/.bashrc or ~/.zshrc):"
  printf '\n'
  printf '    %s\n' "export PATH=\"\$PATH:$MEMORIAHUB_BIN_DIR\""
  printf '\n'
  info "Then reload: source ~/.bashrc  (or source ~/.zshrc)"
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Step 7: Print installed version
# ---------------------------------------------------------------------------
step "Verifying installation"

INSTALLED_VERSION="$("$BIN_SHIM" --version 2>/dev/null | head -1 || echo "unknown")"
if [[ "$INSTALLED_VERSION" == "unknown" || -z "$INSTALLED_VERSION" ]]; then
  err "Installed binary did not report a version — the install may be broken."
  dim "  Try running: $BIN_SHIM --version"
  exit 1
fi
ok "Installed version: $(_c $BOLD "v$INSTALLED_VERSION")"

# Sanity check: the running binary should report the version we just built.
if [[ -n "$SRC_VERSION" && "$SRC_VERSION" != "unknown" && "$INSTALLED_VERSION" != "$SRC_VERSION" ]]; then
  warn "Version mismatch: expected v$SRC_VERSION from source but binary reports v$INSTALLED_VERSION"
fi

INSTALL_SIZE="unknown"
if command -v du &>/dev/null; then
  INSTALL_SIZE="$(du -sh "$APP_DIR" 2>/dev/null | cut -f1)"
fi
ok "Install size: $INSTALL_SIZE"

VERSION_LINE="CLI version : v$INSTALLED_VERSION"
if [[ -n "$PREV_VERSION" && "$PREV_VERSION" != "unknown" && "$PREV_VERSION" != "$INSTALLED_VERSION" ]]; then
  VERSION_LINE="CLI version : v$PREV_VERSION -> v$INSTALLED_VERSION"
fi

print_box "Installation Complete" \
  "$VERSION_LINE" \
  "Install size: $INSTALL_SIZE" \
  "Location    : $APP_DIR" \
  "Shim        : $BIN_SHIM" \
  "" \
  "Get started:" \
  "  memoriahub login" \
  "  memoriahub import ~/Pictures/MyAlbum" \
  "  memoriahub --help"

# ---------------------------------------------------------------------------
# Step 8: Windows / WSL PATH call-out
# ---------------------------------------------------------------------------
# On Windows 11 + WSL the default shell rarely has ~/.local/bin on PATH, so the
# freshly-installed `memoriahub` command is "not found" until the user appends
# it. Print an explicit, copy-pasteable box with the exact two commands.
if is_wsl && [[ "$BIN_ON_PATH" != "1" ]]; then
  RC_FILE="$(detect_shell_rc)"
  RC_SHORT="${RC_FILE/#"$HOME"/\~}"
  printf '\n'
  print_box "Windows 11 · WSL — one more step" \
    "Detected Windows Subsystem for Linux (WSL)." \
    "" \
    "The 'memoriahub' command was installed to:" \
    "$MEMORIAHUB_BIN_DIR" \
    "but that directory is not on your PATH yet, so" \
    "your shell reports 'command not found'." \
    "" \
    "Run these two commands to finish setup:" \
    "" \
    "echo 'export PATH=\"\$PATH:$MEMORIAHUB_BIN_DIR\"' >> $RC_SHORT" \
    "source $RC_SHORT" \
    "" \
    "Then verify it works:" \
    "memoriahub --version"
  printf '\n'
fi
