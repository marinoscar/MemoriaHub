/**
 * The two retired legacy key-write routes (RETRO-E3, #605): `PUT|DELETE /api/ai/credentials/:provider`
 * answer 410 with a pointer to the platform key route, and write nothing.
 */
import { GoneException } from '@nestjs/common';

import { AI_LEGACY_KEY_WRITES_GONE, AiSettingsController } from './ai-settings.controller';

describe('AiSettingsController legacy key writes', () => {
  const service = {} as never;
  const controller = new AiSettingsController(service);

  it.each([
    ['PUT', () => controller.upsertCredentials('openai')],
    ['DELETE', () => controller.deleteCredentials('openai')],
  ])('%s /api/ai/credentials/:provider is 410 with the platform route in details', (_verb, call) => {
    let thrown: unknown;
    try {
      call();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoneException);
    const body = (thrown as GoneException).getResponse() as { details: Record<string, unknown> };
    expect(body.details).toEqual({
      reason: AI_LEGACY_KEY_WRITES_GONE,
      provider: 'openai',
      route: '/api/admin/ai/providers/openai/key',
      page: '/admin/settings/ai',
    });
  });
});
