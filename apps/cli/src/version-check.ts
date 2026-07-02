/**
 * version-check.ts — Dependency-free GitHub version check for MemoriaHub CLI.
 *
 * Fetches the published package.json from the main branch and compares the
 * version field against the currently running version.  All errors are swallowed
 * so a slow or unreachable network never delays startup.
 */

const PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/apps/cli/package.json';

const FETCH_TIMEOUT_MS = 4_000;

/**
 * Dependency-free semantic version comparator.
 *
 * - Strips a leading `v` from either argument.
 * - Ignores pre-release suffixes (everything after the first `-`).
 * - Pads missing major/minor/patch parts with 0.
 *
 * Returns:
 *   -1  if a < b
 *    0  if a === b
 *    1  if a > b
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const stripped = v.replace(/^v/, '');
    const base = stripped.split('-')[0] ?? '';
    const parts = base.split('.');
    const num = (s: string | undefined): number => {
      if (s === undefined) return 0;
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    };
    return [num(parts[0]), num(parts[1]), num(parts[2])];
  };

  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);

  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

/**
 * Check whether a newer version of the CLI is published on GitHub.
 *
 * Uses the global `fetch` with a 4-second AbortController timeout.
 * Always resolves — never rejects.  On any error returns:
 *   `{ updateAvailable: false, latestVersion: null }`
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(PACKAGE_JSON_URL, { signal: controller.signal });
    if (!resp.ok) {
      return { updateAvailable: false, latestVersion: null };
    }

    const json = (await resp.json()) as Record<string, unknown>;
    const version = json['version'];

    if (typeof version !== 'string' || !version) {
      return { updateAvailable: false, latestVersion: null };
    }

    const updateAvailable = compareSemver(version, currentVersion) > 0;
    return { updateAvailable, latestVersion: version };
  } catch {
    return { updateAvailable: false, latestVersion: null };
  } finally {
    clearTimeout(timeoutId);
  }
}
