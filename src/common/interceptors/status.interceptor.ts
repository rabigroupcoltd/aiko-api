import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Controllers return the envelope as a plain object, so without this the HTTP
 * status would always be 200/201 no matter what `code` says. This syncs the
 * status line to the body.
 */
@Injectable()
export class StatusInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(
      map((body) => {
        if (body && typeof body === 'object' && typeof body.code === 'number') {
          context.switchToHttp().getResponse().status(body.code);

          // Collapse validation message arrays into one readable string.
          if (Array.isArray(body.message)) body.message = body.message.join(', ');
        }
        return body;
      }),
    );
  }
}
