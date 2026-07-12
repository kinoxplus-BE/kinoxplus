import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Response } from 'express';

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

/**
 * Global HTTP exception filter producing the standard error envelope:
 *   { "success": false, "error": { "code": "…", "message": "…" } }
 * Throw HttpExceptions with `{ code, message }` bodies to control the code.
 * Gateways use WsAllExceptionsFilter instead (global filters don't reach ws).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const b = body as {
          code?: string;
          message?: string | string[];
          error?: string;
        };
        message = Array.isArray(b.message)
          ? b.message.join('; ')
          : (b.message ?? exception.message);
        code =
          b.code ??
          (b.error ? b.error.toUpperCase().replace(/\s+/g, '_') : code);
      }
    } else {
      // Unknown/unexpected — report, never leak internals to the client.
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception);
    }

    const payload: ErrorBody = { success: false, error: { code, message } };
    response.status(status).json(payload);
  }
}
