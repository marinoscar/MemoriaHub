// =============================================================================
// Android APK upload and download through nginx (issue #504, epic #498)
// =============================================================================
//
// A 150 MiB APK only reaches the API if the edge proxy lets the body through
// unspooled, and only reaches the phone promptly if the download is not
// buffered first. Configuration, not code: asserted by reading the files the
// deployment uses — BOTH infra/nginx/nginx.conf and nginx.prod.conf, which are
// maintained by hand and drift independently.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_APK_BYTES } from '../../src/android-app/releases/android-release.constants';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');

function megabytes(value: string): number {
  const m = value.match(/^(\d+)([kmg])?$/i);
  if (!m) throw new Error(`unparseable size ${value}`);
  return Number(m[1]) * ({ k: 1 / 1024, m: 1, g: 1024 } as Record<string, number>)[(m[2] ?? 'm').toLowerCase()];
}

function seconds(value: string): number {
  const m = value.match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`unparseable duration ${value}`);
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? 's'];
}

describe.each(['infra/nginx/nginx.conf', 'infra/nginx/nginx.prod.conf'])('nginx: Android APK releases (%s)', (file) => {
  const conf = readFileSync(resolve(repoRoot, file), 'utf8');

  function locationBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\s+/g, '\\s+');
    const match = conf.match(new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`no "location ${selector}" block in ${file}`);
    return match[1];
  }

  function directive(block: string, name: string): string | undefined {
    return block.match(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm'))?.[1].trim();
  }

  const api = locationBlock('/api');

  it('lets an upload of the largest APK (plus multipart overhead) through, streamed, with long timeouts', () => {
    const block = locationBlock('= /api/admin/android-app/releases');

    expect(directive(block, 'proxy_pass')).toBe(directive(api, 'proxy_pass'));
    expect(directive(block, 'client_max_body_size')).toBe('160m');
    expect(megabytes(directive(block, 'client_max_body_size') ?? '1m')).toBeGreaterThan(MAX_APK_BYTES / (1024 * 1024));
    expect(directive(block, 'proxy_request_buffering')).toBe('off');
    expect(seconds(directive(block, 'proxy_read_timeout') ?? '60s')).toBeGreaterThanOrEqual(600);
    expect(seconds(directive(block, 'proxy_send_timeout') ?? '60s')).toBeGreaterThanOrEqual(600);
  });

  it('streams the download unbuffered, with long timeouts', () => {
    const block = locationBlock('/api/android-app/download/');

    expect(directive(block, 'proxy_pass')).toBe(directive(api, 'proxy_pass'));
    expect(directive(block, 'proxy_buffering')).toBe('off');
    expect(seconds(directive(block, 'proxy_read_timeout') ?? '60s')).toBeGreaterThanOrEqual(600);
    expect(seconds(directive(block, 'proxy_send_timeout') ?? '60s')).toBeGreaterThanOrEqual(600);
  });

  it('declares both before the generic /api block', () => {
    const generic = conf.indexOf('location /api {');
    expect(conf.indexOf('location = /api/admin/android-app/releases')).toBeLessThan(generic);
    expect(conf.indexOf('location /api/android-app/download/')).toBeLessThan(generic);
  });
});
