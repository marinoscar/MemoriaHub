/**
 * MemoriaHub's AI features end to end (RETRO-E2, #601).
 *
 * Boots the whole AppModule (mocked database) with the platform AI runtime harness wired in: `AiService`
 * is the REAL service over a scripted fake provider and in-memory usage tables, so what is asserted here is
 * what the platform did with MemoriaHub's registered features, not a mock of it:
 *
 *   - `GET /api/ai/features` lists the seven MemoriaHub features (ids pinned: they are stamped on usage
 *     rows) for a signed-in user holding `ai:use`, and is refused while the kill switch is off;
 *   - a call made for a feature writes an `ai_usage_events` row carrying the feature id, the acting user
 *     (or none for a system call) and the key source, and the fake provider saw the call;
 *   - a system call (`AiService.forSystem`) is allowed only for a feature registered with
 *     `systemCalls: true` (the search agent is not), and never carries a user;
 *   - the kill switch refuses a call before the provider is reached and writes no usage row.
 */
import request from 'supertest';
import { HARNESS_ORG_KEY, HARNESS_USER, type AiConformanceApp } from '@marinoscar/platform-api/ai/testing';

import { MEMORIAHUB_AI_FEATURES as F } from '../../src/ai-port/ai-features';
import { aiConformanceFixture } from '../conformance/ai-fixture';

const BODY = { model: 'fake-model', input: 'hello' };
const FEATURE_IDS = Object.values(F);

describe('MemoriaHub AI features over the booted app (RETRO-E2, #601)', () => {
  let app: AiConformanceApp;
  let token: string;

  beforeAll(async () => {
    app = await aiConformanceFixture.createAiApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    app.reset();
    const user = await aiConformanceFixture.createUser(app.context, { id: HARNESS_USER, roleName: 'contributor' });
    token = user.accessToken;
    // The app's usable-model listing reads the (mocked) catalogue and the user's keys: none yet.
    const prisma = (app.context as unknown as { prismaMock: Record<string, Record<string, jest.Mock>> }).prismaMock;
    prisma['userAiKey']!['findMany']!.mockResolvedValue([]);
    prisma['aiModel']!['findMany']!.mockResolvedValue([]);
  });

  const server = () => app.context.app.getHttpServer();
  const org = aiConformanceFixture.defaultOrgId;

  describe('GET /api/ai/features', () => {
    it('lists every registered MemoriaHub feature with what it needs', async () => {
      app.harness.setPolicy({ enabled: true });

      const res = await request(server()).get('/api/ai/features').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const features = res.body.data as Array<{ id: string; label: string; needs: string[]; usable: boolean }>;
      const ids = features.map((feature) => feature.id);
      for (const id of FEATURE_IDS) expect(ids).toContain(id);
      const byId = new Map(features.map((feature) => [feature.id, feature]));
      expect(byId.get(F.semanticEmbedding)!.needs).toEqual(['embeddings']);
      expect(byId.get(F.pictureEnhance)!.needs).toEqual(['image_edit']);
      expect(byId.get(F.searchAgent)!.needs).toEqual(expect.arrayContaining(['responses', 'streaming']));
      // No catalogue model and no key: nothing is usable yet, and the listing says so instead of failing.
      for (const feature of features) expect(feature.usable).toBe(false);
    });

    it('is refused with AI_DISABLED while the kill switch is off', async () => {
      app.harness.setPolicy({ enabled: false });

      const res = await request(server()).get('/api/ai/features').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('AI_DISABLED');
    });

    it('needs authentication', async () => {
      app.harness.setPolicy({ enabled: true });

      const res = await request(server()).get('/api/ai/features');

      expect(res.status).toBe(401);
    });
  });

  describe('the AI usage event write', () => {
    it('a user call for a MemoriaHub feature records the feature, the user and the key source', async () => {
      app.harness.setPolicy({ enabled: true });

      await app.harness.ai.forUser(HARNESS_USER, { orgId: org, feature: F.memoryTitles }).respond(BODY);

      expect(app.harness.fake.calls.length).toBe(1);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ feature: F.memoryTitles, userId: HARNESS_USER, keySource: 'user' }),
      ]);
    });

    it('every system-capable feature records its own id and no user for a system call', async () => {
      app.harness.setPolicy({ enabled: true });
      app.harness.setOrgKey(HARNESS_ORG_KEY);

      for (const feature of [F.mediaTagging, F.videoTagging, F.memoryTitles]) {
        await app.harness.ai.forSystem({ orgId: org, feature }).respond(BODY);
      }

      expect(app.harness.usageEvents.map((event) => event.feature)).toEqual([
        F.mediaTagging,
        F.videoTagging,
        F.memoryTitles,
      ]);
      for (const event of app.harness.usageEvents) expect(event).toMatchObject({ userId: null, keySource: 'org' });
      expect(new Set(app.harness.fake.apiKeys)).toEqual(new Set([HARNESS_ORG_KEY]));
    });

    it('a system call for the search agent (user-only, no systemCalls) is refused and the provider is never reached', async () => {
      app.harness.setPolicy({ enabled: true });
      app.harness.setOrgKey(HARNESS_ORG_KEY);

      await expect(app.harness.ai.forSystem({ orgId: org, feature: F.searchAgent }).respond(BODY)).rejects.toMatchObject({
        code: 'AI_KEY_REQUIRED',
      });

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.usageEvents).toEqual([]);
    });
  });

  describe('the kill switch', () => {
    it('refuses a call for a MemoriaHub feature before the provider and writes no usage row', async () => {
      app.harness.setPolicy({ enabled: false });

      await expect(
        app.harness.ai.forUser(HARNESS_USER, { orgId: org, feature: F.mediaTagging }).respond(BODY),
      ).rejects.toMatchObject({ code: 'AI_DISABLED' });

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.usageEvents).toEqual([]);
    });

    it('serves the same call again once an administrator turns AI back on', async () => {
      app.harness.setPolicy({ enabled: false });
      await expect(
        app.harness.ai.forUser(HARNESS_USER, { orgId: org, feature: F.mediaTagging }).respond(BODY),
      ).rejects.toMatchObject({ code: 'AI_DISABLED' });

      app.harness.setPolicy({ enabled: true });
      await app.harness.ai.forUser(HARNESS_USER, { orgId: org, feature: F.mediaTagging }).respond(BODY);

      expect(app.harness.usageEvents).toEqual([expect.objectContaining({ feature: F.mediaTagging })]);
    });
  });
});
