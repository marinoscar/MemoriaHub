import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prismaMock } from '../mocks/prisma.mock';
import { OfflineGeoLocationProvider } from '../../src/media/geo/offline-geo-location.provider';

/**
 * Inert stand-in for OfflineGeoLocationProvider.
 *
 * Booting AppModule runs OfflineGeoLocationProvider.onModuleInit, which
 * initializes local-reverse-geocoder. That library is fatal in a Jest run for
 * two independent reasons:
 *
 *   1. It dynamically `import()`s ESM node-fetch@3, which Jest's CJS VM rejects
 *      with "A dynamic import callback was invoked without
 *      --experimental-vm-modules".
 *   2. Its `init` downloads the GeoNames dataset over the network before
 *      resolving, so every suite that boots the app pays a network round-trip
 *      and times out when there isn't one.
 *
 * Neither has anything to do with what these specs assert — no integration spec
 * exercises reverse geocoding — so the provider is replaced wholesale. Any spec
 * that genuinely needs geocoding should override this with its own fake rather
 * than reinstate the real provider. See issue #220.
 */
const inertGeoProvider = {
  onModuleInit: async (): Promise<void> => {},
  reverseGeocode: async (): Promise<null> => null,
};

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  /** Access to Prisma mock methods (only available when isMocked is true) */
  prismaMock: any;
  module: TestingModule;
  isMocked: boolean;
}

export interface TestAppOptions {
  /**
   * If true, uses a mocked PrismaService instead of connecting to a real database
   * This is recommended for unit/integration tests
   * Set to false only for true E2E tests that need a real database
   */
  useMockDatabase?: boolean;
}

/**
 * Creates a fully configured test application
 * By default, uses mocked PrismaService (no real database)
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  // Default to mocked database for unit/integration tests
  const shouldUseMock = options.useMockDatabase ?? true;

  let moduleFixture: TestingModule;

  // The geo stub applies to BOTH branches: the ESM/network problem it works
  // around is a property of running under Jest, not of how Prisma is wired.
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OfflineGeoLocationProvider)
    .useValue(inertGeoProvider);

  if (shouldUseMock) {
    // Mocked PrismaService — no real database connection is opened.
    moduleFixture = await builder
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();
  } else {
    // Real database (for true E2E tests).
    moduleFixture = await builder.compile();
  }

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  // Register cookie plugin for auth tests
  await app.register(fastifyCookie, {
    secret: 'test-secret',
  });

  app.setGlobalPrefix('api');
  // Note: ZodValidationPipe is already registered globally via APP_PIPE in AppModule
  // Do NOT add a standard ValidationPipe here as it conflicts with Zod DTOs

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = moduleFixture.get<PrismaService>(PrismaService);

  return {
    app,
    prisma,
    prismaMock: shouldUseMock ? prismaMock : null,
    module: moduleFixture,
    isMocked: shouldUseMock,
  };
}

/**
 * Creates a minimal test module for unit testing
 */
export async function createTestModule(
  imports: any[] = [],
  providers: any[] = [],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports,
    providers,
  }).compile();
}

/**
 * Closes the test application and cleans up
 */
export async function closeTestApp(context: TestContext): Promise<void> {
  if (context && context.app) {
    await context.app.close();
  }
  // Skip disconnect if using mocked database
  if (context && context.prisma && !context.isMocked) {
    await context.prisma.$disconnect();
  }
}
