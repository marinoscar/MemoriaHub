/**
 * db/native-sqlite-error.ts — friendly error for a missing better-sqlite3
 * native binary (issue #541).
 *
 * better-sqlite3 loads its `.node` binding lazily inside `new Database()`, so a
 * package installed without its binary (npm 11 skips dependency install
 * scripts unless they are allow-listed, or Node was upgraded since install)
 * fails there with a raw "Could not locate the bindings file. Tried: …" path
 * dump. `toNativeSqliteError` classifies that failure and turns it into a short,
 * actionable message; anything else is returned unchanged.
 */

import { createRequire } from 'node:module';
import * as path from 'path';

/** Re-run command for the public installer. */
export const INSTALLER_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash';

/** Fallback package location when better-sqlite3 cannot be resolved. */
export const DEFAULT_BETTER_SQLITE3_DIR = '~/.memoriahub/app/node_modules/better-sqlite3';

/** Thrown when better-sqlite3's native binding cannot be loaded. */
export class NativeSqliteUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeSqliteUnavailableError';
  }
}

export interface NativeSqliteContext {
  nodeVersion: string;
  platform: string;
  arch: string;
  /** Directory of the installed better-sqlite3 package. */
  packageDir: string;
}

const BINDING_MESSAGE_RE =
  /Could not locate the bindings file|NODE_MODULE_VERSION|was compiled against a different Node\.js version|invalid ELF header/;

/** True when `err` is a native-binding load failure (not an SQLite/app error). */
export function isNativeBindingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 'ERR_DLOPEN_FAILED') return true;
  return typeof e.message === 'string' && BINDING_MESSAGE_RE.test(e.message);
}

/** Resolve the better-sqlite3 package directory, falling back to the default install path. */
export function resolveBetterSqlite3Dir(): string {
  try {
    const req = createRequire(import.meta.url);
    return path.dirname(req.resolve('better-sqlite3/package.json'));
  } catch {
    return DEFAULT_BETTER_SQLITE3_DIR;
  }
}

/** Build the user-facing message for a missing native binary. */
export function nativeSqliteMessage(ctx: NativeSqliteContext): string {
  return [
    `MemoriaHub's SQLite engine (better-sqlite3) is missing its native binary for Node ${ctx.nodeVersion} (${ctx.platform}-${ctx.arch}).`,
    'This usually means npm skipped install scripts (npm 11+ blocks dependency install scripts unless allow-listed), or Node was upgraded since the CLI was installed.',
    'Fix it by downloading the prebuilt binary:',
    `  cd ${ctx.packageDir} && ../.bin/prebuild-install`,
    'or re-run the installer:',
    `  ${INSTALLER_COMMAND}`,
  ].join('\n');
}

/**
 * Map a `new Database()` failure to a NativeSqliteUnavailableError when it is a
 * native-binding load failure; return any other error unchanged.
 */
export function toNativeSqliteError(
  err: unknown,
  ctx: Partial<NativeSqliteContext> = {},
): unknown {
  if (!isNativeBindingError(err)) return err;
  const full: NativeSqliteContext = {
    nodeVersion: ctx.nodeVersion ?? process.version,
    platform: ctx.platform ?? process.platform,
    arch: ctx.arch ?? process.arch,
    packageDir: ctx.packageDir ?? resolveBetterSqlite3Dir(),
  };
  return new NativeSqliteUnavailableError(nativeSqliteMessage(full), { cause: err });
}
