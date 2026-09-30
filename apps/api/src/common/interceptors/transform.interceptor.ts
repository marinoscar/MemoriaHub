import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
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
    // `@Sse()` handlers (GET /api/notifications/stream, #485) return an
    // Observable of MessageEvents and this map would run once PER EVENT —
    // wrapping a comment-only heartbeat into `{ data: { comment }, meta }`
    // turns it into a real `data:` frame every 25 s. The envelope is a
    // request/response convention; a stream is neither. Keyed on Nest's own
    // SSE metadata so any future @Sse() route is correct automatically.
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

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
