import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
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

    // SSE streams (#485) are logged once, at open: the tap below fires per
    // emission, so a stream would log a line per heartbeat with an
    // ever-growing "response time" that poisons latency dashboards.
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
      this.logger.log(`${method} ${url} - SSE stream opened`);
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const responseTime = Date.now() - now;
        this.logger.log(`${method} ${url} - ${responseTime}ms`);
      }),
    );
  }
}
