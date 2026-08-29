import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrollableTabsProps } from '../../../components/common/tabs';

/**
 * Issue #451 — a source-scanning guard, not a render test.
 *
 * The defect it protects against is invisible at any width where the tabs
 * happen to fit, so it cannot be caught by rendering one component: MUI's
 * default `variant="standard"` clips a tab bar wider than its container with
 * no scroll buttons and no other indication. A rendered assertion would also
 * have to be repeated per page and would be forgotten by exactly the next
 * person who adds a tab bar — which is how this regressed in the first place.
 *
 * `variant="fullWidth"` is an accepted alternative: it is what the two-option
 * expiry toggles in the share dialogs use, and a full-width bar divides the
 * container between its tabs rather than overflowing it.
 *
 * Note the `dirname(fileURLToPath(import.meta.url))` walk rather than the
 * usual `new URL(relative, import.meta.url)` — the same reason
 * `navigation/reachability.test.tsx` gives: Vite statically analyzes that
 * exact shape as an asset reference, and we want a plain filesystem read.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', '..');

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Every `<Tabs` opening tag, with the whole prop list.
 *
 * A non-greedy `/<Tabs\b[\s\S]*?>/` is NOT good enough and was wrong on the
 * first attempt: an inline handler like `onChange={(_, v) => setMode(v)}`
 * contains a `>` that terminates the match well before the real end of the
 * tag, so a correctly-guarded bar gets reported as an offender. Walk the tag
 * instead, closing on the first `>` seen at brace depth zero.
 */
function tabsOpeningTags(source: string): string[] {
  const tags: string[] = [];

  for (const match of source.matchAll(/<Tabs\b/g)) {
    let depth = 0;
    for (let i = match.index!; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        tags.push(source.slice(match.index!, i + 1));
        break;
      }
    }
  }

  return tags;
}

describe('scrollableTabsProps', () => {
  it('declares the three props MUI needs for a scrollable bar on a phone', () => {
    // `allowScrollButtonsMobile` is not redundant with `scrollButtons: 'auto'`:
    // MUI hides the buttons below `sm` without it, leaving the one case that
    // actually needs them with no affordance.
    expect(scrollableTabsProps).toEqual({
      variant: 'scrollable',
      scrollButtons: 'auto',
      allowScrollButtonsMobile: true,
    });
  });

  it('is spread into every tab bar in the app that is not fullWidth', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf-8');
      for (const tag of tabsOpeningTags(source)) {
        const guarded =
          tag.includes('...scrollableTabsProps') || tag.includes('variant="fullWidth"');
        if (!guarded) {
          offenders.push(`${relative(SRC_ROOT, file)}: ${tag.split('\n')[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds tab bars at all, so the sweep above cannot pass vacuously', () => {
    const total = tsxFiles(SRC_ROOT).reduce(
      (n, file) => n + tabsOpeningTags(readFileSync(file, 'utf-8')).length,
      0,
    );

    expect(total).toBeGreaterThanOrEqual(8);
  });
});
