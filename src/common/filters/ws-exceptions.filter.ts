import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

/**
 * Gateway-scoped filter emitting the doc's `error` event contract:
 *   error → { code, message }
 * Services throw transport-agnostic HttpExceptions; this maps them for ws.
 */
@Catch()
export class WsAllExceptionsFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();

    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong.';

    if (exception instanceof WsException) {
      const error = exception.getError();
      if (typeof error === 'string') {
        message = error;
      } else {
        const e = error as { code?: string; message?: string };
        code = e.code ?? code;
        message = e.message ?? message;
      }
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const b = body as { code?: string; message?: string | string[] };
        code = b.code ?? code;
        message = Array.isArray(b.message)
          ? b.message.join('; ')
          : (b.message ?? message);
      }
    }

    client.emit('error', { code, message });
  }
}
