import { deriveHint } from '@marinoscar/platform-api/credentials';

import { decryptSecret, encryptSecret } from './legacy-secret-cipher';
import {
  applyPlan,
  buildPlan,
  formatPlan,
  type CredentialStore,
  type LegacyItem,
  type LegacySource,
  type MigrationPurpose,
  type SettingsStore,
} from './legacy-credentials-migration';

const KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

class MemCredentials implements CredentialStore {
  rows = new Map<string, string>();
  tamper = false;
  async getSecret(p: string, n: string) {
    const v = this.rows.get(`${p}/${n}`) ?? null;
    return v !== null && this.tamper ? v + 'x' : v;
  }
  async setSecret(p: string, n: string, s: string | null | undefined) {
    if (s) this.rows.set(`${p}/${n}`, s);
  }
}

class MemSettings implements SettingsStore {
  doc: Record<string, any> = {};
  async get(path: string[]) {
    return path.reduce<any>((n, k) => (n && typeof n === 'object' ? n[k] : undefined), this.doc);
  }
  async setIfAbsent(path: string[], value: Record<string, unknown>) {
    let node = this.doc;
    for (const k of path) node = node[k] ??= {};
    const written: string[] = [];
    for (const [k, v] of Object.entries(value)) if (node[k] === undefined) ((node[k] = v), written.push(k));
    return written;
  }
}

const source = (items: LegacyItem[]): LegacySource => ({
  load: async (purpose: MigrationPurpose) => items.filter((i) => i.purpose === purpose),
});

describe('legacy credential migration', () => {
  const PLAINTEXT = 'AIza-synthetic-geo-key-9876';
  let savedKey: string | undefined;
  let creds: MemCredentials;
  let settings: MemSettings;
  let logs: string[];

  const geoItem = (ciphertext: string | null = encryptSecret(PLAINTEXT)): LegacyItem => ({
    purpose: 'geo',
    rowId: 'row-geo-1',
    label: 'geo_provider_credentials/google',
    ciphertext,
    target: { purpose: 'geo_provider', name: 'google' },
    settings: { path: ['geo', 'google'], value: { baseUrl: 'https://maps.example.test', enabled: false } },
  });
  const faceItem = (): LegacyItem => ({
    purpose: 'face',
    rowId: 'row-face-1',
    label: 'face_provider_credentials/compreface',
    ciphertext: encryptSecret(''),
    target: { purpose: 'face_provider', name: 'compreface' },
    settings: { path: ['face', 'providers', 'compreface'], value: { baseUrl: 'http://cf:8000', enabled: true } },
  });

  beforeAll(() => {
    savedKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  });
  beforeEach(() => {
    creds = new MemCredentials();
    settings = new MemSettings();
    logs = [];
  });

  it('dry run plans a write and writes nothing', async () => {
    const plan = await buildPlan(['geo'], source([geoItem()]), creds, settings, decryptSecret);
    expect(plan.entries[0]).toMatchObject({ status: 'write', hint: deriveHint(PLAINTEXT), settingsKeys: ['baseUrl', 'enabled'] });
    expect(creds.rows.size).toBe(0);
    expect(settings.doc).toEqual({});
  });

  it('the plan and the report never contain the plaintext or the ciphertext', async () => {
    const item = geoItem();
    const plan = await buildPlan(['geo'], source([item]), creds, settings, decryptSecret);
    const text = JSON.stringify(plan.entries.map((e) => ({ ...e, item: { ...e.item, ciphertext: undefined } }))) + formatPlan(plan).join('\n');
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain(item.ciphertext!);
    expect(formatPlan(plan).join('\n')).toContain('would write 1');
    expect(formatPlan(plan).join('\n')).toContain('hint=••••9876');
  });

  it('apply re-encrypts through the store, writes the non-secret half and logs hints only', async () => {
    const plan = await buildPlan(['geo'], source([geoItem()]), creds, settings, decryptSecret);
    const result = await applyPlan(plan, creds, settings, decryptSecret, (l) => logs.push(l));

    expect(result).toMatchObject({ written: 1, settingsWritten: 2 });
    expect(creds.rows.get('geo_provider/google')).toBe(PLAINTEXT);
    expect(settings.doc.geo.google).toEqual({ baseUrl: 'https://maps.example.test', enabled: false });
    expect(logs.join('\n')).toContain('hint=••••9876');
    expect(logs.join('\n')).not.toContain(PLAINTEXT);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const run = async () => {
      const plan = await buildPlan(['geo', 'face'], source([geoItem(), faceItem()]), creds, settings, decryptSecret);
      return applyPlan(plan, creds, settings, decryptSecret);
    };
    await run();
    const before = JSON.stringify([...creds.rows, settings.doc]);
    const second = await run();
    expect(second).toMatchObject({ written: 0, unchanged: 1, settingsWritten: 0 });
    expect(JSON.stringify([...creds.rows, settings.doc])).toBe(before);
  });

  it('never overwrites a non-secret value saved after cut-over', async () => {
    settings.doc = { geo: { google: { enabled: true } } };
    const plan = await buildPlan(['geo'], source([geoItem()]), creds, settings, decryptSecret);
    await applyPlan(plan, creds, settings, decryptSecret);
    expect(settings.doc.geo.google).toEqual({ enabled: true, baseUrl: 'https://maps.example.test' });
  });

  it('a keyless face row has no secret: only the settings are written', async () => {
    const plan = await buildPlan(['face'], source([faceItem()]), creds, settings, decryptSecret);
    expect(plan.entries[0]!.status).toBe('no-secret');
    const result = await applyPlan(plan, creds, settings, decryptSecret);
    expect(result).toMatchObject({ written: 0, noSecret: 1, settingsWritten: 2 });
    expect(creds.rows.size).toBe(0);
    expect(settings.doc.face.providers.compreface).toEqual({ baseUrl: 'http://cf:8000', enabled: true });
  });

  it('refuses everything when one row is undecryptable, naming the row id', async () => {
    // A ciphertext the key cannot authenticate (what a different master key or tampering produces).
    const buf = Buffer.from(encryptSecret('some-other-secret-1234'), 'base64');
    buf[buf.length - 1] ^= 0xff;
    const foreign = buf.toString('base64');
    const bad: LegacyItem = { ...geoItem(foreign), rowId: 'row-bad-7' };

    const plan = await buildPlan(['geo', 'face'], source([faceItem(), bad]), creds, settings, decryptSecret);
    expect(plan.undecryptable).toEqual(['geo_provider_credentials/google (row-bad-7)']);
    await expect(applyPlan(plan, creds, settings, decryptSecret)).rejects.toThrow(/row-bad-7/);
    expect(creds.rows.size).toBe(0);
    expect(settings.doc).toEqual({});
    expect(formatPlan(plan).join('\n')).toContain('CANNOT DECRYPT');
  });

  it('fails the run when the round trip does not return the same secret', async () => {
    creds.tamper = true;
    const plan = await buildPlan(['geo'], source([geoItem()]), creds, settings, decryptSecret);
    await expect(applyPlan(plan, creds, settings, decryptSecret)).rejects.toThrow(/Round trip failed.*row-geo-1/);
  });

  it('plans storage and push_vapid but refuses to apply them (smtp and ses apply since RETRO-D2)', async () => {
    const storage: LegacyItem = {
      purpose: 'storage',
      rowId: 'row-s3',
      label: 'storage_provider_credentials/s3',
      ciphertext: encryptSecret('aws-secret-key-1111'),
      target: { purpose: 'storage', name: 'default' },
    };
    const inactive: LegacyItem = { ...storage, rowId: 'row-r2', label: 'storage_provider_credentials/r2', target: null, note: 'not the active provider' };
    const plan = await buildPlan(['storage'], source([storage, inactive]), creds, settings, decryptSecret);
    expect(plan.entries.map((e) => e.status)).toEqual(['write', 'skipped']);
    await expect(applyPlan(plan, creds, settings, decryptSecret)).rejects.toThrow(/storage not applicable yet/);
    expect(creds.rows.size).toBe(0);
  });
  it('with onlyIfAbsent keeps a secret already stored (the email carry-over, RETRO-D2)', async () => {
    const smtp: LegacyItem = {
      purpose: 'smtp',
      rowId: 'system_settings.global#email.smtpPassword',
      label: 'system_settings.global email.smtpPassword',
      ciphertext: encryptSecret('legacy-smtp-password'),
      target: { purpose: 'smtp', name: 'default' },
    };
    await creds.setSecret('smtp', 'default', 'admin-saved-password');
    const plan = await buildPlan(['smtp'], source([smtp]), creds, settings, decryptSecret, { onlyIfAbsent: true });
    expect(plan.entries.map((e) => e.status)).toEqual(['unchanged']);
    await applyPlan(plan, creds, settings, decryptSecret);
    expect(await creds.getSecret('smtp', 'default')).toBe('admin-saved-password');

    const fresh = await buildPlan(['smtp'], source([{ ...smtp, target: { purpose: 'smtp', name: 'other' } }]), creds, settings, decryptSecret, { onlyIfAbsent: true });
    expect(fresh.entries.map((e) => e.status)).toEqual(['write']);
  });
});
