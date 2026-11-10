import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { Auth } from '@marinoscar/platform-api/identity';
import { MemoriahubAuth } from '@marinoscar/memoriahub-api/core';

import { ErrorDto } from '@marinoscar/platform-api/core';

// =============================================================================
// `@MemoriahubAuth()` documents a route exactly like the platform `@Auth()` (RETRO-J5, #613)
// =============================================================================
//
// The OpenAPI document of the app must stay byte-identical when a controller moves into the package, so
// the package decorator has to write the same security scheme, `x-rbac` extension and error responses.
// Two controllers declare the same requirements, one with each decorator; their operations must be equal.

@Controller('platform')
class PlatformRoutes {
  @Get('none') @Auth() none(): void {}
  @Get('permission') @Auth({ permissions: ['media:read'] }) permission(): void {}
  @Get('both') @Auth({ roles: ['admin'], permissions: ['storage:delete_any', 'media:write'] }) both(): void {}
  @Get('any') @Auth({ anyPermissions: ['media:write', 'media:delete'] }) any(): void {}
}

@Controller('package')
class PackageRoutes {
  @Get('none') @MemoriahubAuth() none(): void {}
  @Get('permission') @MemoriahubAuth({ permissions: ['media:read'] }) permission(): void {}
  @Get('both') @MemoriahubAuth({ roles: ['admin'], permissions: ['storage:delete_any', 'media:write'] }) both(): void {}
  @Get('any') @MemoriahubAuth({ anyPermissions: ['media:write', 'media:delete'] }) any(): void {}
}

describe('MemoriahubAuth document', () => {
  it('writes the same operation as @Auth', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PlatformRoutes, PackageRoutes] })
      .useMocker(() => ({ canActivate: () => true }))
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build(), { extraModels: [ErrorDto] });

    for (const name of ['none', 'permission', 'both', 'any']) {
      const platform = document.paths[`/platform/${name}`]?.get;
      const pkg = document.paths[`/package/${name}`]?.get;
      expect(pkg).toBeDefined();
      const strip = (op: unknown) => JSON.stringify(op, (key, value) => (key === 'operationId' || key === 'tags' ? undefined : value));
      expect(strip(pkg)).toBe(strip(platform));
    }
    await app.close();
  });
});
