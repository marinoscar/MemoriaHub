/**
 * Unit tests for MemoryDigestService (epic #300, issue #311) — the
 * per-recipient send.
 *
 * The properties asserted here are the ones the epic states as hard
 * requirements: a digest is NEVER sent with no new content, an opted-out member
 * NEVER receives one, a member whose own preference filter empties the list
 * receives nothing, and a provider failure is counted rather than thrown.
 *
 * NOTHING HERE CAN SEND MAIL OR TOUCH A NETWORK: EmailService is a jest mock,
 * Prisma is a mock, and the storage/thumbnail layer is a stub. The only real
 * code that runs is this service, the preference resolver it reuses from #307,
 * and the token codec.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MemoryType } from '@prisma/client';

import { MemoryDigestService } from './memory-digest.service';
import { EmailService } from '../../email/email.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { verifyDigestImageToken, verifyDigestUnsubscribeToken } from './digest-token.util';

const VALID_KEY = Buffer.alloc(32, 3).toString('base64');

const CIRCLE_ID = 'c0000000-0000-4000-8000-000000000001';
const USER_A = 'a0000000-0000-4000-8000-000000000001';
const USER_B = 'b0000000-0000-4000-8000-000000000002';
const PERSON_ID = 'd0000000-0000-4000-8000-000000000003';
const COVER_ID = 'e0000000-0000-4000-8000-000000000004';

function settingsWith(overrides: Record<string, unknown> = {}): any {
  return {
    features: { memories: true },
    memories: { digest: { enabled: true, frequency: 'daily', sendHourUtc: 8 } },
    email: { enabled: true, provider: 'smtp', fromAddress: 'x@example.test' },
    ...overrides,
  };
}

function memoryRow(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    id: 'm0000000-0000-4000-8000-00000000000a',
    type: MemoryType.trip,
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    narrative: null,
    itemCount: 24,
    personId: null,
    periodStart: new Date('2023-03-01T00:00:00.000Z'),
    periodEnd: new Date('2023-03-05T00:00:00.000Z'),
    generatedAt: new Date('2026-08-09T00:00:00.000Z'),
    coverMediaItem: { id: COVER_ID, metadata: { thumbnailStorageKey: 'thumbs/a.jpg' } },
    ...overrides,
  };
}

/** Two members, no stored preferences. */
function circleRow(members = [USER_A, USER_B]): any {
  return {
    name: 'Familia',
    members: members.map((id) => ({
      user: { id, email: `${id}@example.test`, displayName: 'Member' },
    })),
  };
}

describe('MemoryDigestService', () => {
  let service: MemoryDigestService;
  let prisma: any;
  let email: { sendEmail: jest.Mock };
  let settings: { getSettings: jest.Mock };

  beforeAll(() => {
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
    process.env.APP_URL = 'https://memories.example.test';
  });

  beforeEach(async () => {
    prisma = {
      circle: { findUnique: jest.fn().mockResolvedValue(circleRow()) },
      memory: { findMany: jest.fn().mockResolvedValue([memoryRow()]) },
      enrichmentJob: { findFirst: jest.fn().mockResolvedValue(null) },
      userSettings: { findMany: jest.fn().mockResolvedValue([]) },
    };
    email = { sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'x' }) };
    settings = { getSettings: jest.fn().mockResolvedValue(settingsWith()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryDigestService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settings },
        { provide: EmailService, useValue: email },
        {
          provide: MediaThumbnailService,
          useValue: {
            extractThumbKey: (metadata: any) =>
              typeof metadata?.thumbnailStorageKey === 'string'
                ? metadata.thumbnailStorageKey
                : null,
          },
        },
      ],
    }).compile();

    service = module.get(MemoryDigestService);
  });

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  it('sends one email per eligible recipient', async () => {
    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.sent).toBe(2);
    expect(result.recipients).toBe(2);
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    expect(email.sendEmail.mock.calls[0]![1]).toBe('memory-digest');
  });

  it.each([
    ['feature flag off', settingsWith({ features: { memories: false } })],
    [
      'digest disabled',
      settingsWith({
        memories: { digest: { enabled: false, frequency: 'daily', sendHourUtc: 8 } },
      }),
    ],
    [
      "frequency 'off'",
      settingsWith({
        memories: { digest: { enabled: true, frequency: 'off', sendHourUtc: 8 } },
      }),
    ],
    [
      'email unconfigured',
      settingsWith({ email: { enabled: false, provider: null, fromAddress: null } }),
    ],
  ])('sends nothing when %s', async (_label, blob) => {
    settings.getSettings.mockResolvedValue(blob);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedReason).toBe('gate');
    expect(email.sendEmail).not.toHaveBeenCalled();
    // Gate closes before any circle/member read.
    expect(prisma.circle.findUnique).not.toHaveBeenCalled();
  });

  it('NEVER sends an empty digest when there is no new content', async () => {
    prisma.memory.findMany.mockResolvedValue([]);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedReason).toBe('no_new_content');
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for a circle that has been deleted', async () => {
    prisma.circle.findUnique.mockResolvedValue(null);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedReason).toBe('no_circle');
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Per-recipient filtering (#307 preferences, reused not reimplemented)
  // -------------------------------------------------------------------------

  it('never emails a member who opted out', async () => {
    prisma.userSettings.findMany.mockResolvedValue([
      { userId: USER_A, value: { memories: { emailDigestOptOut: true } } },
    ]);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedOptOut).toBe(1);
    expect(result.sent).toBe(1);
    const recipients = email.sendEmail.mock.calls.map((c) => c[0]);
    expect(recipients).not.toContain(`${USER_A}@example.test`);
  });

  it('applies a hidden person to the recipient who hid them, and only them', async () => {
    prisma.memory.findMany.mockResolvedValue([
      memoryRow({ type: MemoryType.person_highlights, personId: PERSON_ID }),
    ]);
    prisma.userSettings.findMany.mockResolvedValue([
      { userId: USER_A, value: { memories: { hiddenPersonIds: [PERSON_ID] } } },
    ]);

    const result = await service.sendForCircle(CIRCLE_ID);

    // A's only candidate is hidden ⇒ nothing left to show ⇒ no email at all.
    expect(result.skippedEmpty).toBe(1);
    expect(result.sent).toBe(1);
    expect(email.sendEmail.mock.calls[0]![0]).toBe(`${USER_B}@example.test`);
  });

  it('applies a sensitive date range per recipient', async () => {
    prisma.userSettings.findMany.mockResolvedValue([
      {
        userId: USER_A,
        value: {
          memories: { hiddenDateRanges: [{ from: '2023-03-01', to: '2023-03-31' }] },
        },
      },
    ]);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedEmpty).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('filters only the hidden memories, keeping the rest', async () => {
    prisma.memory.findMany.mockResolvedValue([
      memoryRow({ id: 'keep', type: MemoryType.theme }),
      memoryRow({
        id: 'hide',
        type: MemoryType.person_highlights,
        personId: PERSON_ID,
      }),
    ]);
    prisma.userSettings.findMany.mockResolvedValue([
      { userId: USER_A, value: { memories: { hiddenPersonIds: [PERSON_ID] } } },
    ]);

    await service.sendForCircle(CIRCLE_ID);

    const aPayload = email.sendEmail.mock.calls.find(
      (c) => c[0] === `${USER_A}@example.test`,
    )![2];
    const bPayload = email.sendEmail.mock.calls.find(
      (c) => c[0] === `${USER_B}@example.test`,
    )![2];
    expect(aPayload.memories.map((m: any) => m.id)).toEqual(['keep']);
    expect(bPayload.memories.map((m: any) => m.id)).toEqual(['keep', 'hide']);
  });

  it('skips a member with no email address', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      name: 'Familia',
      members: [{ user: { id: USER_A, email: null, displayName: null } }],
    });

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.skippedNoEmail).toBe(1);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Payload
  // -------------------------------------------------------------------------

  it('caps the email at one hero plus four cards', async () => {
    prisma.memory.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => memoryRow({ id: `m${i}` })),
    );

    await service.sendForCircle(CIRCLE_ID);

    expect(email.sendEmail.mock.calls[0]![2].memories).toHaveLength(5);
  });

  it('leads with the today-anchored on_this_day memory', async () => {
    prisma.memory.findMany.mockResolvedValue([
      memoryRow({ id: 'newer-trip', generatedAt: new Date('2026-08-09T12:00:00Z') }),
      memoryRow({
        id: 'otd',
        type: MemoryType.on_this_day,
        generatedAt: new Date('2026-08-09T01:00:00Z'),
      }),
    ]);

    await service.sendForCircle(CIRCLE_ID);

    expect(email.sendEmail.mock.calls[0]![2].memories[0].id).toBe('otd');
  });

  it('mints a per-recipient unsubscribe URL that resolves to that user', async () => {
    await service.sendForCircle(CIRCLE_ID);

    for (const call of email.sendEmail.mock.calls) {
      const expectedUser = String(call[0]).split('@')[0];
      const token = String(call[2].unsubscribeUrl).split('/').pop()!;
      expect(call[2].unsubscribeUrl).toContain(
        'https://memories.example.test/api/public/memories/digest-unsubscribe/',
      );
      expect(verifyDigestUnsubscribeToken(token)).toBe(expectedUser);
    }
  });

  it('signs a long-lived image token naming the cover item', async () => {
    await service.sendForCircle(CIRCLE_ID);

    const imageUrl = email.sendEmail.mock.calls[0]![2].memories[0].imageUrl as string;
    expect(imageUrl).toContain('/api/public/memories/digest-image/');
    expect(verifyDigestImageToken(imageUrl.split('/').pop()!)).toBe(COVER_ID);
  });

  it('omits the image when the cover has no thumbnail yet', async () => {
    prisma.memory.findMany.mockResolvedValue([
      memoryRow({ coverMediaItem: { id: COVER_ID, metadata: {} } }),
    ]);

    await service.sendForCircle(CIRCLE_ID);

    expect(email.sendEmail.mock.calls[0]![2].memories[0].imageUrl).toBeNull();
  });

  it('omits the image when the memory has no cover at all', async () => {
    prisma.memory.findMany.mockResolvedValue([memoryRow({ coverMediaItem: null })]);

    await service.sendForCircle(CIRCLE_ID);

    expect(email.sendEmail.mock.calls[0]![2].memories[0].imageUrl).toBeNull();
  });

  it('builds absolute per-memory links from APP_URL', async () => {
    await service.sendForCircle(CIRCLE_ID);

    const payload = email.sendEmail.mock.calls[0]![2];
    expect(payload.memories[0].url).toBe(
      `https://memories.example.test/memories/${payload.memories[0].id}`,
    );
    expect(payload.memoriesUrl).toBe('https://memories.example.test/memories');
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it('counts a provider failure instead of throwing', async () => {
    email.sendEmail
      .mockResolvedValueOnce({ success: false, error: 'smtp down' })
      .mockResolvedValueOnce({ success: true });

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('sends unfiltered rather than failing when the preference read blows up', async () => {
    prisma.userSettings.findMany.mockRejectedValue(new Error('db down'));

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.sent).toBe(2);
  });

  it('tolerates a malformed stored preference blob', async () => {
    prisma.userSettings.findMany.mockResolvedValue([
      { userId: USER_A, value: { memories: { hiddenDateRanges: [{ from: 'x', to: 'y' }] } } },
    ]);

    const result = await service.sendForCircle(CIRCLE_ID);

    expect(result.sent).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Watermark + windows
  // -------------------------------------------------------------------------

  it('reads new content strictly after the previous succeeded digest', async () => {
    const watermark = new Date('2026-08-02T08:00:00.000Z');
    prisma.enrichmentJob.findFirst.mockResolvedValue({ finishedAt: watermark });

    await service.sendForCircle(CIRCLE_ID);

    const where = prisma.memory.findMany.mock.calls[0]![0].where;
    expect(where.deletedAt).toBeNull();
    expect(JSON.stringify(where.AND)).toContain(watermark.toISOString());
  });

  it('takes the newest memories outright on a first-ever digest', async () => {
    await service.sendForCircle(CIRCLE_ID);

    expect(prisma.memory.findMany.mock.calls[0]![0].where.AND).toBeUndefined();
  });

  it('subtracts one cron tick of tolerance from each frequency window', () => {
    expect(service.windowMs('daily')).toBe(23 * 3_600_000);
    expect(service.windowMs('weekly')).toBe((24 * 7 - 1) * 3_600_000);
    expect(service.windowMs('monthly')).toBe((24 * 30 - 1) * 3_600_000);
  });
});
