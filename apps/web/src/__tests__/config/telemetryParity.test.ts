/**
 * Telemetry web/API permission parity (RETRO-T2, #625; check 7 of the telemetry
 * slice's conformance suite, whose API half is apps/api/test/telemetry).
 *
 * For every card of the packaged `telemetryAdminCards`:
 *   - its permission is one of the three the slice declares (`telemetry:read`,
 *     `telemetry:write`, `telemetry:query`) or `system_settings:read`;
 *   - the admin hub registers it exactly once;
 *   - its path is ONE route of the live App.tsx, gated on the SAME permission.
 *
 * The permission strings are spelled here because the web cannot import the API
 * package; the API side pins the same three in
 * apps/api/test/rbac/permission-matrix.spec.ts and the regenerated catalog. The
 * check is a pure function, run first against broken fixtures so a check that
 * cannot fail does not pass the real cards by accident.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { telemetryAdminCards } from '@marinoscar/platform-web/telemetry/ui';

import { ADMIN_SECTIONS } from '../../config/adminSections';

const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

const ALLOWED: readonly string[] = ['telemetry:read', 'telemetry:write', 'telemetry:query', 'system_settings:read'];

interface Card {
  path: string;
  permission?: string;
}
interface RouteGate {
  path: string;
  permission: string | null;
}

/** Every `<Route>` of App.tsx as `path` -> the `permission` of the `RequirePermission` it wraps. */
function declaredRouteGates(source: string): RouteGate[] {
  return source
    .split('<Route')
    .slice(1)
    .map((chunk) => ({
      path: /^\s*path="([^"]+)"/.exec(chunk)?.[1],
      permission: /permission="([^"]+)"/.exec(chunk)?.[1] ?? null,
    }))
    .filter((route): route is RouteGate => route.path !== undefined);
}

function parityProblems(
  cards: readonly Card[],
  routes: readonly RouteGate[],
  registered: readonly string[],
  allowed: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const card of cards) {
    if (!card.permission || !allowed.includes(card.permission)) {
      problems.push(`${card.path}: permission "${card.permission}" is not one of ${allowed.join(', ')}`);
    }
    const hubEntries = registered.filter((path) => path === card.path).length;
    if (hubEntries !== 1) problems.push(`${card.path}: registered ${hubEntries} times in the admin hub, expected once`);
    const matching = routes.filter((route) => route.path === card.path);
    if (matching.length !== 1) {
      problems.push(`${card.path}: ${matching.length} routes in App.tsx, expected one`);
    } else if (matching[0].permission !== (card.permission ?? null)) {
      problems.push(`${card.path}: the route is gated on "${matching[0].permission}" but the card on "${card.permission}"`);
    }
  }
  return problems;
}

describe('telemetry web/API permission parity: the check itself', () => {
  const card: Card = { path: '/admin/settings/telemetry', permission: 'telemetry:read' };
  const route: RouteGate = { path: '/admin/settings/telemetry', permission: 'telemetry:read' };

  it('passes a consistent fixture', () => {
    expect(parityProblems([card], [route], [card.path], ALLOWED)).toEqual([]);
  });

  it('flags an invented permission, a missing or duplicated route, a different gate and a double registration', () => {
    expect(parityProblems([{ ...card, permission: 'telemetry:admin' }], [{ ...route, permission: 'telemetry:admin' }], [card.path], ALLOWED)).toHaveLength(1);
    expect(parityProblems([card], [], [card.path], ALLOWED)).toHaveLength(1);
    expect(parityProblems([card], [route, route], [card.path], ALLOWED)).toHaveLength(1);
    expect(parityProblems([card], [{ ...route, permission: 'telemetry:write' }], [card.path], ALLOWED)).toHaveLength(1);
    expect(parityProblems([card], [route], [card.path, card.path], ALLOWED)).toHaveLength(1);
  });
});

describe('telemetry web/API permission parity: MemoriaHub', () => {
  it('every packaged telemetry card is registered once and routed once behind its own permission', () => {
    const registered = ADMIN_SECTIONS.flatMap((section) => section.cards.map((c) => c.path));
    const routes = declaredRouteGates(readFileSync(APP_TSX, 'utf8'));

    expect(telemetryAdminCards).toHaveLength(3);
    expect(parityProblems(telemetryAdminCards, routes, registered, ALLOWED)).toEqual([]);
  });
});
