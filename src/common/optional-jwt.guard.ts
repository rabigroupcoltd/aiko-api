import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Lets a request through with or without a bearer token. A valid token puts the
 * caller on `request.user` exactly as AuthGuard('jwt') would; a missing,
 * expired or invalid one leaves `request.user` undefined instead of failing.
 * For public endpoints that show more to some callers (an admin, the owner).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser = any>(_err: unknown, user: TUser): TUser {
    return (user || undefined) as TUser;
  }
}
