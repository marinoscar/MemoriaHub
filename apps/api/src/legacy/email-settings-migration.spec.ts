import {
  applyEmailSettingsPlan,
  buildEmailSettingsPlan,
  dropRejectedFields,
  formatEmailSettingsPlan,
  legacyToPlatformEmail,
  mergeIfAbsent,
  type EmailRowStore,
  type EmailRowValue,
  type LegacyEmailBlock,
} from './email-settings-migration';

/** An in-memory platform `email` row. */
function memoryRow(initial: EmailRowValue | null = null): EmailRowStore & { value: EmailRowValue | null; writes: number } {
  return {
    value: initial,
    writes: 0,
    async read() {
      return this.value ? JSON.parse(JSON.stringify(this.value)) : null;
    },
    async write(value) {
      this.value = JSON.parse(JSON.stringify(value));
      this.writes++;
    },
  };
}

const SMTP_LEGACY: LegacyEmailBlock = {
  provider: 'smtp',
  enabled: true,
  sesRegion: null,
  smtpHost: 'smtp.example.test',
  smtpPort: 587,
  smtpUseTls: true,
  smtpUsername: 'mailer@example.test',
  fromAddress: 'family@example.test',
  fromName: 'Family Photos',
};

describe('legacyToPlatformEmail', () => {
  it('maps the flat SMTP block into transports.smtp and keeps the sender and switch', () => {
    expect(legacyToPlatformEmail(SMTP_LEGACY, null)).toEqual({
      provider: 'smtp',
      enabled: true,
      fromAddress: 'family@example.test',
      fromName: 'Family Photos',
      transports: { smtp: { host: 'smtp.example.test', port: 587, useTls: true, username: 'mailer@example.test' } },
    });
  });

  it('copies the S3 access key id into transports.ses and falls back to the S3 region (SES reuse, decision 1)', () => {
    const target = legacyToPlatformEmail({ provider: 'ses', enabled: true, sesRegion: null, fromAddress: 'a@example.test' }, {
      accessKeyId: 'AKIAEXAMPLEKEY0001',
      region: 'eu-west-1',
    });
    expect(target.transports).toEqual({ ses: { region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLEKEY0001' } });
  });

  it('prefers the configured SES region over the S3 one', () => {
    const target = legacyToPlatformEmail({ provider: 'ses', sesRegion: 'us-east-1' }, { accessKeyId: null, region: 'eu-west-1' });
    expect(target.transports).toEqual({ ses: { region: 'us-east-1' } });
  });

  it('drops nulls and blanks, and maps a default-only block to nothing', () => {
    expect(
      legacyToPlatformEmail(
        { provider: null, enabled: false, smtpHost: null, smtpPort: undefined, fromAddress: '  ', fromName: null },
        null,
      ),
    ).toEqual({});
    expect(legacyToPlatformEmail(null, null)).toEqual({});
  });
});

describe('dropRejectedFields', () => {
  it('leaves out a field the platform schema refuses and keeps the rest', () => {
    const { value, rejected } = dropRejectedFields({ provider: 'smtp', enabled: true, fromAddress: 'not-an-address', fromName: 'Ok' });
    expect(rejected).toEqual(['fromAddress']);
    expect(value).toEqual({ provider: 'smtp', enabled: true, fromName: 'Ok' });
  });
});

describe('mergeIfAbsent', () => {
  it('never overwrites a stored value, including a transport field', () => {
    const { value, written } = mergeIfAbsent(
      { provider: 'ses', enabled: false, transports: { smtp: { host: 'kept.example.test' } } },
      { provider: 'smtp', enabled: true, fromAddress: 'a@example.test', transports: { smtp: { host: 'x', port: 25 } } },
    );
    expect(value).toEqual({
      provider: 'ses',
      enabled: false,
      fromAddress: 'a@example.test',
      transports: { smtp: { host: 'kept.example.test', port: 25 } },
    });
    expect(written).toEqual(['fromAddress', 'transports.smtp.port']);
  });
});

describe('the plan', () => {
  it('writes the mapped row when none exists, then is a no-op on a second run (idempotent)', async () => {
    const row = memoryRow();
    const first = await buildEmailSettingsPlan(SMTP_LEGACY, null, row);
    expect(first.rowExists).toBe(false);
    expect(await applyEmailSettingsPlan(first, row)).toContain('transports.smtp.host');
    expect(row.value).toMatchObject({ provider: 'smtp', enabled: true, fromAddress: 'family@example.test' });

    const second = await buildEmailSettingsPlan(SMTP_LEGACY, null, row);
    expect(second.written).toEqual([]);
    expect(await applyEmailSettingsPlan(second, row)).toEqual([]);
    expect(row.writes).toBe(1);
  });

  it('keeps what an admin saved after the upgrade', async () => {
    const row = memoryRow({ provider: 'ses', enabled: true, fromAddress: 'admin@example.test', transports: { ses: { region: 'us-west-2' } } });
    const plan = await buildEmailSettingsPlan(SMTP_LEGACY, { accessKeyId: 'AKIAEXAMPLEKEY0002', region: 'eu-west-1' }, row);
    await applyEmailSettingsPlan(plan, row);
    expect(row.value).toMatchObject({
      provider: 'ses',
      fromAddress: 'admin@example.test',
      transports: { ses: { region: 'us-west-2', accessKeyId: 'AKIAEXAMPLEKEY0002' } },
    });
  });

  it('writes nothing for a deployment that never configured email', async () => {
    const row = memoryRow();
    const plan = await buildEmailSettingsPlan({ provider: null, enabled: false }, null, row);
    expect(await applyEmailSettingsPlan(plan, row)).toEqual([]);
    expect(row.writes).toBe(0);
  });

  it('reports key paths only, never a value', async () => {
    const plan = await buildEmailSettingsPlan(SMTP_LEGACY, { accessKeyId: 'AKIAEXAMPLEKEY0003', region: null }, memoryRow());
    const report = formatEmailSettingsPlan(plan).join('\n');
    expect(report).toContain('transports.ses.accessKeyId');
    expect(report).not.toContain('AKIAEXAMPLEKEY0003');
    expect(report).not.toContain('smtp.example.test');
  });
});
