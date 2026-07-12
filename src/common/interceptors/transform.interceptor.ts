import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

export interface Envelope<T> {
  success: true;
  data: T;
  meta: Record<string, unknown>;
}

/**
 * Wraps every HTTP response in the standard envelope:
 *   { "success": true, "data": {…}, "meta": {…} }
 * Services may return `{ data, meta }` to populate meta (e.g. pagination
 * cursors); anything else lands in `data` with empty meta.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  Envelope<unknown>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<Envelope<unknown>> {
    return next.handle().pipe(
      map((payload): Envelope<unknown> => {
        if (
          payload !== null &&
          typeof payload === 'object' &&
          'data' in payload &&
          'meta' in payload
        ) {
          const { data, meta } = payload as {
            data: unknown;
            meta: Record<string, unknown>;
          };
          return { success: true, data, meta };
        }
        return { success: true, data: payload ?? null, meta: {} };
      }),
    );
  }
}
