/**
 * test/tui/menu-nav.spec.tsx
 *
 * Nav-stack test for the hierarchical menu: root -> Sync submenu -> back.
 *
 * app.tsx's `App` component is NOT exported (only `launchTui` is), and
 * rendering it end-to-end would require stubbing real config/db/network
 * plumbing (loadConfig, openDb, ApiClient.get('/api/auth/me'), listCircles,
 * checkForUpdate) that App wires up internally in a mount-time useEffect.
 * Per the test plan's guidance, we instead drive the SAME production pieces
 * app.tsx composes — HomeMenu, the generic <Menu>, and the menu-config
 * helpers (findSubmenu / visibleChildren / breadcrumb) — through a minimal
 * local nav harness that mirrors app.tsx's push/pop stack exactly as read
 * from src/tui/app.tsx (handleSelect / selectChild / toItem / pop). This
 * exercises real navigation behavior (submenu push, breadcrumb, Esc pop)
 * without needing to mock half the module graph just to get past App's
 * mount effect.
 */

import { jest } from '@jest/globals';
import React, { useState } from 'react';
import { render, cleanup } from 'ink-testing-library';

import { HomeMenu } from '../../src/tui/HomeMenu.js';
import { Menu } from '../../src/tui/Menu.js';
import {
  findSubmenu,
  visibleChildren,
  breadcrumb,
  type MenuNode,
} from '../../src/tui/menu-config.js';
import { waitForFrame } from './wait-for.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

const FAKE_CONFIG = { serverUrl: 'http://test.local', pat: 'tok-test' };

// ---------------------------------------------------------------------------
// Minimal nav harness — mirrors app.tsx's stack/push/pop/toItem/selectChild
// ---------------------------------------------------------------------------

type NavFrame = { kind: 'menu'; menuId: string };

function NavHarness(): React.ReactElement {
  const [stack, setStack] = useState<NavFrame[]>([{ kind: 'menu', menuId: 'root' }]);

  function push(menuId: string): void {
    setStack((prev) => [...prev, { kind: 'menu', menuId }]);
  }

  function pop(): void {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  function handleSelect(node: MenuNode): void {
    if (node.kind === 'submenu') push(node.id);
    // Leaf actions are no-ops in this harness — navigation is what's under test.
  }

  function toItem(node: MenuNode): { label: string; value: string } {
    if (node.kind === 'submenu') {
      return { label: `${node.label} ▸`, value: `submenu:${node.id}` };
    }
    return { label: node.label, value: `action:${node.action}` };
  }

  function selectChild(menuId: string, value: string): void {
    const submenu = findSubmenu(menuId);
    if (!submenu) return;
    const sep = value.indexOf(':');
    const kind = value.slice(0, sep);
    const rest = value.slice(sep + 1);
    const node = visibleChildren(submenu, true).find((c) =>
      c.kind === 'submenu' ? kind === 'submenu' && c.id === rest : kind === 'action' && c.action === rest,
    );
    if (node) handleSelect(node);
  }

  const top = stack[stack.length - 1]!;

  if (top.menuId === 'root') {
    return (
      <HomeMenu
        config={FAKE_CONFIG}
        identity="alice@example.com"
        onSelect={handleSelect}
      />
    );
  }

  const submenu = findSubmenu(top.menuId);
  const items = submenu ? visibleChildren(submenu, true).map(toItem) : [];
  return (
    <Menu
      title={breadcrumb(top.menuId)}
      subtitle="Use arrow keys and Enter to navigate"
      items={items}
      onSelect={(value) => selectChild(top.menuId, value)}
      onBack={pop}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('menu navigation stack: root -> Sync -> back', () => {
  it('starts at the root menu showing the banner and top-level items', () => {
    const { lastFrame } = render(<NavHarness />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('MemoriaHub');
    expect(plain).toContain('Sync ▸');
  });

  it('navigates into the Sync submenu and shows its breadcrumb + child label', async () => {
    const { lastFrame, stdin } = render(<NavHarness />);

    // Move down from Login to Sync, and wait for the highlight to actually
    // move before pressing Enter — ink-select-input tracks its own selected
    // index internally, so sending Enter before that update (and the
    // useInput re-subscription that follows it) has committed can be
    // processed against the PREVIOUS selection instead of Sync. We detect
    // "moved" by diffing the Sync row against its unselected baseline rather
    // than matching a specific pointer glyph — ink-select-input's default
    // indicator character varies by environment (Unicode-support detection),
    // so a hardcoded glyph like '>' or '❯' is not portable across machines/CI
    // (this is what broke this test in GitHub Actions CI despite passing
    // locally). Diffing the raw (non-stripped) line also catches a
    // color-only change, not just a glyph change.
    const syncLineBaseline = (lastFrame() ?? '')
      .split('\n')
      .find((l) => l.includes('Sync ▸'));

    stdin.write('\x1B[B'); // down arrow
    await waitForFrame(lastFrame, (f) => {
      const line = f.split('\n').find((l) => l.includes('Sync ▸'));
      return !!line && line !== syncLineBaseline;
    });

    stdin.write('\r'); // Enter
    const plain = await waitForFrame(lastFrame, (f) =>
      stripAnsi(f).includes('Menu › Sync'),
    ).then(stripAnsi);

    expect(plain).toContain('Menu › Sync');
    expect(plain).toContain('Sync all folders');
    expect(plain).toContain('Sync selected folders');
    expect(plain).toContain('Retry failed files');
  });

  it('returns to the root menu after pressing Esc from the Sync submenu', async () => {
    const { lastFrame, stdin } = render(<NavHarness />);

    const syncLineBaseline = (lastFrame() ?? '')
      .split('\n')
      .find((l) => l.includes('Sync ▸'));

    stdin.write('\x1B[B');
    await waitForFrame(lastFrame, (f) => {
      const line = f.split('\n').find((l) => l.includes('Sync ▸'));
      return !!line && line !== syncLineBaseline;
    });
    stdin.write('\r');
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Menu › Sync'));

    stdin.write('\x1B'); // Esc
    const plain = await waitForFrame(lastFrame, (f) => {
      const p = stripAnsi(f);
      return p.includes('MemoriaHub') && !p.includes('Sync all folders');
    }).then(stripAnsi);

    expect(plain).toContain('MemoriaHub');
    expect(plain).toContain('Sync ▸');
    expect(plain).not.toContain('Sync all folders');
  });
});
