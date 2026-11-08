import { APP_SLUG } from '@app/shared';
import { resolveServiceName } from './telemetry-identity';

describe('resolveServiceName', () => {
  const original = process.env.OTEL_SERVICE_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = original;
  });

  it('defaults to memoriahub-api when OTEL_SERVICE_NAME is unset', () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName()).toBe('memoriahub-api');
    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);
  });

  it('honours the OTEL_SERVICE_NAME override', () => {
    process.env.OTEL_SERVICE_NAME = 'custom-api';
    expect(resolveServiceName()).toBe('custom-api');
  });
});
