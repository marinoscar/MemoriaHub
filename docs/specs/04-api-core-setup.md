# Spec 04: API Core Setup

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 01-project-setup, 02-database-schema
**Estimated Complexity:** Medium

---

## Objective

Set up the NestJS application with Fastify adapter, Prisma integration, configuration management, global exception handling, and OpenAPI/Swagger documentation.

---

## Deliverables

### 1. Main Entry Point

Update `apps/api/src/main.ts`:

```typescript
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Enable CORS (same-origin by default, configurable)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  // Swagger/OpenAPI setup
  const config = new DocumentBuilder()
    .setTitle('Enterprise App API')
    .setDescription('API documentation for the Enterprise App Foundation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/openapi.json',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application running on port ${port}`);
  logger.log(`Swagger UI available at /api/docs`);
}

bootstrap();
```

### 2. App Module

Update `apps/api/src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { HealthModule } from './health/health.module';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

import configuration from './config/configuration';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Database
    PrismaModule,

    // Feature modules
    CommonModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    HealthModule,
  ],
  providers: [
    // Global validation pipe (Zod)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global response transform interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule {}
```

### 3. Configuration

Create `apps/api/src/config/configuration.ts`:

```typescript
export default () => ({
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3535',

  // Database
  database: {
    url: process.env.DATABASE_URL,
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    accessTtlMinutes: parseInt(process.env.JWT_ACCESS_TTL_MINUTES, 10) || 15,
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS, 10) || 14,
  },

  // OAuth - Google
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  },

  // Admin bootstrap
  initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL,

  // Observability
  otel: {
    enabled: process.env.OTEL_ENABLED === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: process.env.OTEL_SERVICE_NAME || 'enterprise-app-api',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
});
```

### 4. Prisma Module

Create `apps/api/src/prisma/prisma.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

Create `apps/api/src/prisma/prisma.service.ts`:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');

    // Log queries in development
    if (process.env.NODE_ENV === 'development') {
      // @ts-ignore - Prisma event typing
      this.$on('query', (e: any) => {
        this.logger.debug(`Query: ${e.query}`);
        this.logger.debug(`Duration: ${e.duration}ms`);
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /**
   * Clean database for testing
   */
  async cleanDatabase() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('cleanDatabase only allowed in test environment');
    }

    const tablenames = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
    `;

    for (const { tablename } of tablenames) {
      if (tablename !== '_prisma_migrations') {
        await this.$executeRawUnsafe(
          `TRUNCATE TABLE "public"."${tablename}" CASCADE;`,
        );
      }
    }
  }
}
```

### 5. Global Exception Filter

Create `apps/api/src/common/filters/http-exception.filter.ts`:

```typescript
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string) || message;
        code = (resp.code as string) || this.getCodeFromStatus(status);
        details = resp.details;
      }

      code = this.getCodeFromStatus(status);
    } else if (exception instanceof Error) {
      message = exception.message;
      // Don't expose stack traces in production
      if (process.env.NODE_ENV !== 'production') {
        details = exception.stack;
      }
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (details) {
      errorResponse.details = details;
    }

    // Log error
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}`,
        exception instanceof Error ? exception.stack : exception,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} - ${status}: ${message}`);
    }

    response.status(status).send(errorResponse);
  }

  private getCodeFromStatus(status: number): string {
    const codeMap: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_ERROR',
    };
    return codeMap[status] || 'ERROR';
  }
}
```

### 6. Transform Interceptor

Create `apps/api/src/common/interceptors/transform.interceptor.ts`:

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  data: T;
  meta?: {
    timestamp: string;
    [key: string]: unknown;
  };
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // If already wrapped, return as-is
        if (data && typeof data === 'object' && 'data' in data) {
          return data;
        }

        return {
          data,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }
}
```

### 7. Logging Interceptor

Create `apps/api/src/common/interceptors/logging.interceptor.ts`:

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyRequest } from 'fastify';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const { method, url } = request;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const responseTime = Date.now() - now;
        this.logger.log(`${method} ${url} - ${responseTime}ms`);
      }),
    );
  }
}
```

### 8. Common Module

Create `apps/api/src/common/common.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AdminBootstrapService } from './services/admin-bootstrap.service';

@Module({
  providers: [AdminBootstrapService],
  exports: [AdminBootstrapService],
})
export class CommonModule {}
```

### 9. Module Placeholders

Create placeholder modules for feature areas:

`apps/api/src/auth/auth.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({})
export class AuthModule {}
```

`apps/api/src/users/users.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({})
export class UsersModule {}
```

`apps/api/src/settings/settings.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({})
export class SettingsModule {}
```

`apps/api/src/health/health.module.ts`:
```typescript
import { Module } from '@nestjs/common';

@Module({})
export class HealthModule {}
```

---

## Additional Dependencies

Add to `apps/api/package.json`:

```json
{
  "dependencies": {
    "@nestjs/config": "^3.x",
    "@nestjs/swagger": "^7.x",
    "nestjs-zod": "^3.x",
    "zod": "^3.x",
    "@fastify/cookie": "^9.x",
    "@fastify/cors": "^9.x",
    "@fastify/helmet": "^11.x"
  }
}
```

---

## Folder Structure

```
apps/api/src/
├── main.ts
├── app.module.ts
├── config/
│   └── configuration.ts
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── common/
│   ├── common.module.ts
│   ├── constants/
│   │   └── roles.constants.ts
│   ├── filters/
│   │   └── http-exception.filter.ts
│   ├── interceptors/
│   │   ├── logging.interceptor.ts
│   │   └── transform.interceptor.ts
│   ├── schemas/
│   │   └── settings.schema.ts
│   ├── services/
│   │   └── admin-bootstrap.service.ts
│   └── types/
│       └── settings.types.ts
├── auth/
│   └── auth.module.ts
├── users/
│   └── users.module.ts
├── settings/
│   └── settings.module.ts
└── health/
    └── health.module.ts
```

---

## Acceptance Criteria

- [ ] Application starts with `npm run start:dev`
- [ ] Fastify adapter is used (check logs for Fastify)
- [ ] Global `/api` prefix applied to all routes
- [ ] Swagger UI accessible at `/api/docs`
- [ ] OpenAPI JSON available at `/api/openapi.json`
- [ ] Configuration loaded from environment variables
- [ ] Prisma connects to database on startup
- [ ] Global exception filter catches and formats errors
- [ ] Response transform wraps data in `{ data, meta }` format
- [ ] Request logging shows method, URL, and response time

---

## Notes

- ConfigModule is global - inject ConfigService anywhere
- PrismaModule is global - inject PrismaService anywhere
- All responses wrapped in standard format via TransformInterceptor
- Error responses follow consistent structure
- Swagger auth configured for JWT bearer tokens
