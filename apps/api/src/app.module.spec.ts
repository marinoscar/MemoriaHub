import { testOnlyModules } from './app.module';
import { TestAuthModule } from './test-auth/test-auth.module';

/**
 * `TestAuthModule` mints tokens with no OAuth round-trip. A controller that is
 * not registered is invisible to `SwaggerModule.createDocument`, so this gate is
 * what keeps those routes out of a production API document as well as out of a
 * production process — worth asserting directly rather than inferring from the
 * absence of a tag in a test-environment document.
 */
describe('testOnlyModules', () => {
  const saved = process.env.NODE_ENV;

  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });

  it('registers the test auth module outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(testOnlyModules()).toEqual([TestAuthModule]);
  });

  it('registers nothing in production', () => {
    process.env.NODE_ENV = 'production';
    expect(testOnlyModules()).toEqual([]);
  });
});
