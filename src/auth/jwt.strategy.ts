import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'rabi-secret-key',
    });
  }

  /**
   * Re-reads roles and block status from the database on every request,
   * rather than trusting the seven-day-old claims baked into the token.
   *
   * Two things a token must not be able to outrun: a block — moderation has
   * to take effect on the very next request, not whenever this token happens
   * to expire — and a role change, so promoting someone to SUPPORT or
   * blocking them does not need a sign-out first.
   */
  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, roles: true, isBlocked: true },
    });

    if (!user) throw new UnauthorizedException('Account no longer exists');
    if (user.isBlocked) throw new UnauthorizedException('This account has been blocked');

    return { sub: user.id, email: user.email, roles: user.roles };
  }
}
