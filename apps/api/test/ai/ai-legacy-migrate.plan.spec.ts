/**
 * The AI key import plan (RETRO-E3, #605): pure decisions, no database.
 */
import {
  DEPLOYMENT_KEY_POLICY,
  formatAiKeyReport,
  planAiKeyImport,
  planHasErrors,
  type AiKeyPlanInput,
  type LegacyAiKeyFacts,
} from '../../src/ai-port/migrate/ai-legacy-plan';
import { baseUrlProblem, parseCli } from '../../src/ai-port/migrate/ai-legacy-migrate';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const EDITOR = '00000000-0000-4000-8000-0000000000e1';

function row(over: Partial<LegacyAiKeyFacts> = {}): LegacyAiKeyFacts {
  return {
    rowId: 'row-openai',
    provider: 'openai',
    last4: '1234',
    baseUrl: null,
    enabled: true,
    updatedByUserId: EDITOR,
    decrypted: true,
    empty: false,
    existing: 'none',
    ...over,
  };
}

function input(rows: LegacyAiKeyFacts[], over: Partial<AiKeyPlanInput> = {}): AiKeyPlanInput {
  return {
    rows,
    registeredProviders: ['openai', 'anthropic'],
    baseUrlProblem: (_p, url) => (url.startsWith('https://') ? null : 'base_url_rejected_by_provider_slot'),
    replace: false,
    existingUserIds: new Set([EDITOR]),
    fallbackActorId: ADMIN,
    storedPolicy: {},
    ...over,
  };
}

describe('planAiKeyImport', () => {
  it('imports a fresh key with the row enabled flag and endpoint, and sets the deployment-key policy', () => {
    const plan = planAiKeyImport(input([row({ baseUrl: 'https://compat.example.test/v1', enabled: false })]));
    expect(plan.entries).toEqual([
      expect.objectContaining({
        provider: 'openai',
        outcome: 'imported',
        writeKey: true,
        slot: { enabled: false, baseUrl: 'https://compat.example.test/v1' },
        actorUserId: EDITOR,
      }),
    ]);
    expect(plan.policy).toEqual({ keyPolicy: DEPLOYMENT_KEY_POLICY, deploymentKeyServesOrgs: true });
  });

  it('falls back to the INITIAL_ADMIN user when the row names nobody who still exists', () => {
    const plan = planAiKeyImport(input([row({ updatedByUserId: 'gone-user' })]));
    expect(plan.entries[0]!.actorUserId).toBe(ADMIN);
  });

  it('skips a provider whose platform key is already the same (a re-run is a no-op)', () => {
    const plan = planAiKeyImport(input([row({ existing: 'same' })], { replace: true }));
    expect(plan.entries[0]).toMatchObject({ outcome: 'skipped_existing', writeKey: false, slot: null });
    expect(plan.policy).toEqual({});
  });

  it('keeps a different platform key unless --replace', () => {
    expect(planAiKeyImport(input([row({ existing: 'different' })])).entries[0]).toMatchObject({
      outcome: 'skipped_existing',
      reason: 'different_key_kept_use_replace',
    });
    const replaced = planAiKeyImport(input([row({ existing: 'different' })], { replace: true }));
    expect(replaced.entries[0]).toMatchObject({ outcome: 'imported', replacesExisting: true });
    expect(replaced.notes.join(' ')).toMatch(/--replace overwrites/);
  });

  it('reports undecryptable, unregistered, empty and unsupported endpoints without stopping the other rows', () => {
    const plan = planAiKeyImport(
      input([
        row({ provider: 'openai', decrypted: false }),
        row({ provider: 'gemini', rowId: 'row-gemini' }),
        row({ provider: 'anthropic', rowId: 'row-anthropic', baseUrl: 'ftp://proxy.example.test' }),
      ]),
    );
    expect(plan.entries.map((e) => [e.provider, e.outcome])).toEqual([
      ['anthropic', 'unsupported_base_url'],
      ['gemini', 'failed'],
      ['openai', 'undecryptable'],
    ]);
    expect(plan.entries.every((e) => !e.writeKey)).toBe(true);
    expect(planHasErrors(plan.entries)).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/ACTION REQUIRED/);
    expect(planAiKeyImport(input([row({ empty: true })])).entries[0]).toMatchObject({ outcome: 'failed', reason: 'empty_key' });
  });

  it('leaves an administrator-set policy alone and reports a deployment key that does not serve organizations', () => {
    const plan = planAiKeyImport(
      input([row()], { storedPolicy: { keyPolicy: DEPLOYMENT_KEY_POLICY, deploymentKeyServesOrgs: false } }),
    );
    expect(plan.policy).toEqual({});
    expect(plan.notes.join(' ')).toMatch(/deploymentKeyServesOrgs is false/);
  });

  it('the report carries provider, outcome and last4 only', () => {
    const plan = planAiKeyImport(input([row({ baseUrl: 'https://compat.example.test/v1' })]));
    const text = formatAiKeyReport(plan.entries, plan.policy, plan.notes, 'dry-run').join('\n');
    expect(text).toContain('provider=openai outcome=imported (dry run) last4=1234');
    expect(text).toContain('baseUrl=set');
    expect(text).not.toContain('compat.example.test');
    expect(text).toContain('summary: imported 1, skipped_existing 0');
  });
});

describe('baseUrlProblem (the platform provider slot decides)', () => {
  it('accepts a URL for the openai and anthropic slots and rejects a non-URL', () => {
    expect(baseUrlProblem('openai', 'https://compat.example.test/v1')).toBeNull();
    expect(baseUrlProblem('anthropic', 'https://proxy.example.test')).toBeNull();
    expect(baseUrlProblem('openai', 'not a url')).toBe('base_url_rejected_by_provider_slot');
    expect(baseUrlProblem('no-such-provider', 'https://x.example.test')).toBe('provider_not_registered');
  });
});

describe('parseCli', () => {
  it('is a dry run by default', () => {
    expect(parseCli([])).toEqual({ apply: false, replace: false, help: false });
    expect(parseCli(['--apply', '--replace'])).toEqual({ apply: true, replace: true, help: false });
  });
  it('refuses --apply with --dry-run and unknown flags', () => {
    expect(() => parseCli(['--apply', '--dry-run'])).toThrow(/mutually exclusive/);
    expect(() => parseCli(['--key', 'x'])).toThrow();
  });
});
