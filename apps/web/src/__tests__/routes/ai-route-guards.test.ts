/**
 * RETRO-E2 (#601): `/search` and `/enhancements` are AI surfaces and must sit
 * behind `RequireAiEnabled` (`GET /api/ai/config`), like the other AI pages.
 * Source-scanning, because the routes are only reachable behind sign-in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

function routeElement(path: string): string {
  const start = source.indexOf(`path="${path}"`);
  expect(start, `route ${path} exists`).toBeGreaterThan(-1);
  const end = start + 400;
  return source.slice(start, end);
}

describe('AI route guards (RETRO-E2)', () => {
  it.each([
    ['/search', 'SearchPage'],
    ['/enhancements', 'EnhancementsPage'],
  ])('%s is wrapped in RequireAiEnabled', (path, page) => {
    const block = routeElement(path);
    expect(block).toMatch(new RegExp(`<RequireAiEnabled>\\s*<${page} />\\s*</RequireAiEnabled>`));
  });
});
