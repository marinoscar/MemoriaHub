/**
 * PushConfigService (epic #481, issue #483) — runtime VAPID config stored in the
 * `webPush` system_settings row, private key AES-256-GCM encrypted, no env
 * fallback, private key never in any returned view.
 */
import { ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';

process.env.SECRETS_ENCRYPTION_KEY =
  process.env.SECRETS_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');

import { decryptSecret, encryptSecret } from '../../common/crypto/secret-cipher';
import { DEFAULT_VAPID_SUBJECT, PUSH_CONFIG_KEY } from './push-config.schema';
import { PushConfigService } from './push-config.service';
import { privateKeyDerivesPublicKey } from './push-test.service';

const USER = 'admin-1';

function makePrisma(initial: unknown = undefined) {
  const state: { value: unknown } = { value: initial };
  const prisma = {
    systemSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        expect(where.key).toBe(PUSH_CONFIG_KEY);
        return state.value === undefined ? null : { value: state.value };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        expect(where.key).toBe(PUSH_CONFIG_KEY);
        state.value = state.value === undefined ? create.value : update.value;
        return { key: PUSH_CONFIG_KEY, value: state.value };
      }),
      deleteMany: jest.fn(async () => {
        const had = state.value !== undefined;
        state.value = undefined;
        return { count: had ? 1 : 0 };
      }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return { prisma, state };
}

function build(initial?: unknown) {
  const { prisma, state } = makePrisma(initial);
  return { service: new PushConfigService(prisma as any), prisma, state };
}

describe('PushConfigService', () => {
  describe('describeForAdmin', () => {
    it('returns the empty view when no row exists', async () => {
      const { service } = build();
      const view = await service.describeForAdmin();
      expect(view).toMatchObject({
        enabled: false,
        publicKey: null,
        configured: false,
        active: false,
        effectiveSubject: DEFAULT_VAPID_SUBJECT,
        privateKeyStatus: { configured: false, last4: null, updatedAt: null },
        settingsError: null,
      });
    });

    it('reports a settingsError (not a throw) for an invalid stored row', async () => {
      const { service } = build({ enabled: 'yes' });
      const view = await service.describeForAdmin();
      expect(view.settingsError).toMatch(/invalid/);
      expect(view.configured).toBe(false);
    });
  });

  describe('generate', () => {
    it('mints a valid key pair, encrypts the private key, enables push, and audits', async () => {
      const { service, state, prisma } = build();
      const view = await service.generate({ subject: 'mailto:ops@example.com' }, USER);

      expect(view).toMatchObject({ enabled: true, configured: true, active: true });
      expect(view.privateKeyStatus.configured).toBe(true);
      expect(view.privateKeyStatus.last4).toHaveLength(4);

      const stored = state.value as any;
      expect(stored.publicKey).toBe(view.publicKey);
      const privateKey = decryptSecret(stored.privateKeyEncrypted);
      expect(privateKeyDerivesPublicKey(privateKey, stored.publicKey)).toBe(true);
      expect(stored.privateKeyEncrypted).not.toContain(privateKey);
      expect(privateKey.endsWith(view.privateKeyStatus.last4!)).toBe(true);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'push_config:generate', actorUserId: USER }),
        }),
      );
    });

    it('never exposes the private key (plaintext or ciphertext) in the view', async () => {
      const { service, state } = build();
      const view = await service.generate({}, USER);
      const json = JSON.stringify(view);
      const stored = state.value as any;
      expect(json).not.toContain(stored.privateKeyEncrypted);
      expect(json).not.toContain(decryptSecret(stored.privateKeyEncrypted));
      expect(Object.keys(view)).not.toContain('privateKeyEncrypted');
    });

    it('409s when a key pair already exists', async () => {
      const { service } = build();
      await service.generate({}, USER);
      await expect(service.generate({}, USER)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('rotate', () => {
    it('409s when nothing is configured', async () => {
      const { service } = build();
      await expect(service.rotate({ confirmation: 'ROTATE' }, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('replaces the key pair, keeps enabled and subject unless given', async () => {
      const { service } = build();
      const first = await service.generate({ subject: 'mailto:a@example.com' }, USER);
      await service.update({ enabled: false }, USER);
      const rotated = await service.rotate({ confirmation: 'ROTATE' }, USER);
      expect(rotated.publicKey).not.toBe(first.publicKey);
      expect(rotated.enabled).toBe(false);
      expect(rotated.subject).toBe('mailto:a@example.com');

      const rotated2 = await service.rotate(
        { confirmation: 'ROTATE', subject: 'https://example.com' },
        USER,
      );
      expect(rotated2.subject).toBe('https://example.com');
    });
  });

  describe('update', () => {
    it('409s when enabling with no key pair', async () => {
      const { service } = build();
      await expect(service.update({ enabled: true }, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows disabling and subject changes without touching keys', async () => {
      const { service, state } = build();
      await service.generate({}, USER);
      const before = (state.value as any).privateKeyEncrypted;
      const view = await service.update({ enabled: false, subject: 'mailto:x@example.com' }, USER);
      expect(view.enabled).toBe(false);
      expect(view.subject).toBe('mailto:x@example.com');
      expect((state.value as any).privateKeyEncrypted).toBe(before);

      const cleared = await service.update({ subject: null }, USER);
      expect(cleared.subject).toBeNull();
      expect(cleared.effectiveSubject).toBe(DEFAULT_VAPID_SUBJECT);
    });
  });

  describe('remove', () => {
    it('deletes the row, audits, and returns the empty view', async () => {
      const { service, state, prisma } = build();
      await service.generate({}, USER);
      const view = await service.remove({ confirmation: 'REMOVE' }, USER);
      expect(state.value).toBeUndefined();
      expect(view.configured).toBe(false);
      expect(prisma.auditEvent.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'push_config:remove' }) }),
      );
    });
  });

  describe('resolveActiveVapidConfig', () => {
    it('is null with no row (no env fallback)', async () => {
      process.env.VAPID_PUBLIC_KEY = 'env-public';
      process.env.VAPID_PRIVATE_KEY = 'env-private';
      try {
        const { service } = build();
        await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
      } finally {
        delete process.env.VAPID_PUBLIC_KEY;
        delete process.env.VAPID_PRIVATE_KEY;
      }
    });

    it('is null when disabled', async () => {
      const { service } = build();
      await service.generate({}, USER);
      await service.update({ enabled: false }, USER);
      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
    });

    it('returns the decrypted pair and fallback subject when enabled', async () => {
      const { service } = build();
      const view = await service.generate({}, USER);
      const active = await service.resolveActiveVapidConfig();
      expect(active).not.toBeNull();
      expect(active!.publicKey).toBe(view.publicKey);
      expect(active!.subject).toBe(DEFAULT_VAPID_SUBJECT);
      expect(privateKeyDerivesPublicKey(active!.privateKey, active!.publicKey)).toBe(true);
    });

    it('is null (not a throw) when the ciphertext cannot be decrypted', async () => {
      const { service } = build({
        enabled: true,
        publicKey: 'BPUB',
        subject: null,
        privateKeyEncrypted: Buffer.from('garbage-garbage-garbage-garbage').toString('base64'),
        privateKeyLast4: 'abcd',
        updatedAt: null,
        updatedById: null,
      });
      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
    });

    it('is null when the private half is missing', async () => {
      const { service } = build({
        enabled: true,
        publicKey: 'BPUB',
        subject: null,
        privateKeyEncrypted: null,
        privateKeyLast4: null,
        updatedAt: null,
        updatedById: null,
      });
      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
    });

    it('is null when the read itself fails', async () => {
      const { service, prisma } = build();
      prisma.systemSettings.findUnique.mockRejectedValueOnce(new Error('db down'));
      await expect(service.resolveActiveVapidConfig()).resolves.toBeNull();
    });

    it('getActivePublicKey mirrors the active config', async () => {
      const { service } = build({
        enabled: true,
        publicKey: 'BPUB',
        subject: 'mailto:a@example.com',
        privateKeyEncrypted: encryptSecret('priv'),
        privateKeyLast4: 'priv',
        updatedAt: null,
        updatedById: null,
      });
      await expect(service.getActivePublicKey()).resolves.toBe('BPUB');
    });
  });
});
