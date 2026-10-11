import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class StatusInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(
      map((body) => {
        if (body && typeof body === 'object' && typeof body.code === 'number') {
          context.switchToHttp().getResponse().status(body.code);

          if (Array.isArray(body.message)) body.message = body.message.join(', ');
        }
        return body;
      }),
    );
  }
}
