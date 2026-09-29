import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Prisma, User, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ServiceResult,
  notFound,
  ok,
  unauthorized,
} from '../common/responses/response.types';
import { FirebaseIdentity, FirebaseService } from '../firebase/firebase.service';
import {
  ONBOARDING_DRIVER_SELECT,
  OnboardingService,
} from '../onboarding/onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { FirebaseSignInDto, LoginDto } from './dto/auth.dto';

/** Relations every sign-in response needs in order to report onboarding state. */
const SIGN_IN_INCLUDE = {
  driver: { select: ONBOARDING_DRIVER_SELECT },
} satisfies Prisma.UserInclude;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private firebase: FirebaseService,
    private onboarding: OnboardingService,
    private response: ResponsesService,
  ) {}

  /**
   * The app's only way in.
   *
   * Takes an ID token from any Firebase provider — Google gives us an email,
   * phone auth gives us a number — verifies it, then finds or creates the
   * matching account. The response is identical for a brand-new user and a
   * returning one apart from `isNewUser`: the client always just navigates to
   * `onboarding.resumeStep`, which is DONE for anyone already set up.
   */
  async signInWithFirebase(dto: FirebaseSignInDto): Promise<ServiceResult> {
    try {
      const verified = await this.firebase.verifyIdToken(dto.idToken);
      if (!verified.ok) return unauthorized(verified.message);

      const { identity } = verified;
      const existing = await this.findByIdentity(identity);

      if (existing?.isBlocked) return unauthorized('This account has been blocked');

      const user = existing
        ? await this.linkExisting(existing, identity)
        : await this.createFromIdentity(identity);

      return ok({
        isNewUser: !existing,
        accessToken: this.generateToken(user.id, user.email, user.roles),
        user: this.publicView(user),
        onboarding: await this.onboarding.stateFor(user),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Matches an incoming token to an account, in descending order of certainty.
   *
   * The uid is exact. Email and phone are the fallbacks that let someone who
   * signed up with Google come back through phone auth — a different Firebase
   * uid, but the same person — and land on their existing account rather than a
   * duplicate. Without this, switching provider silently restarts onboarding.
   */
  private async findByIdentity(identity: FirebaseIdentity) {
    const byUid = await this.prisma.user.findUnique({
      where: { firebaseUid: identity.uid },
      include: SIGN_IN_INCLUDE,
    });
    if (byUid) return byUid;

    if (identity.email) {
      const byEmail = await this.prisma.user.findUnique({
        where: { email: identity.email },
        include: SIGN_IN_INCLUDE,
      });
      if (byEmail) return byEmail;
    }

    if (identity.phone) {
      const byPhone = await this.prisma.user.findFirst({
        where: { phone: identity.phone },
        include: SIGN_IN_INCLUDE,
      });
      if (byPhone) return byPhone;
    }

    return null;
  }

  /**
   * Fills in anything the account is still missing and claims the uid.
   *
   * Deliberately non-destructive: a value the user typed during onboarding is
   * never overwritten by the provider's version of it, because a name edited in
   * the profile form must survive the next sign-in.
   */
  private async linkExisting(user: User, identity: FirebaseIdentity) {
    const data: Prisma.UserUpdateInput = { lastLoginAt: new Date() };

    if (!user.firebaseUid) data.firebaseUid = identity.uid;
    if (!user.email && identity.email) data.email = identity.email;
    if (!user.phone && identity.phone) data.phone = identity.phone;
    if (!user.name && identity.displayName) data.name = identity.displayName;
    if (!user.photoUrl && identity.photoUrl) data.photoUrl = identity.photoUrl;

    // Verification flags only ever move forward.
    if (identity.emailVerified && !user.emailVerified) data.emailVerified = true;
    if (identity.phone && !user.phoneVerified) data.phoneVerified = true;

    return this.prisma.user.update({
      where: { id: user.id },
      data,
      include: SIGN_IN_INCLUDE,
    });
  }

  private async createFromIdentity(identity: FirebaseIdentity) {
    const { firstName, lastName } = splitName(identity.displayName);

    return this.prisma.user.create({
      data: {
        firebaseUid: identity.uid,
        email: identity.email,
        phone: identity.phone,
        name: identity.displayName,
        firstName,
        lastName,
        photoUrl: identity.photoUrl,
        emailVerified: identity.emailVerified,
        phoneVerified: Boolean(identity.phone),
        authProvider: identity.phone
          ? AuthProvider.FIREBASE_PHONE
          : AuthProvider.FIREBASE_GOOGLE,
        roles: [UserRole.USER],
        // Phone auth already has the number, so that step is behind them.
        onboardingStep: identity.phone ? 'PROFILE' : 'PHONE',
        lastLoginAt: new Date(),
      },
      include: SIGN_IN_INCLUDE,
    });
  }

  /**
   * Password sign-in, kept for staff.
   *
   * Firebase accounts have no password column, so they fall out at the null
   * check — this stays an admin door without needing an explicit role gate that
   * would also have to be maintained.
   */
  async login(dto: LoginDto): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        include: SIGN_IN_INCLUDE,
      });

      // Same message on every failure path so the endpoint cannot be used to
      // enumerate emails, or to tell a password account from a Firebase one.
      if (!user || !user.password) return unauthorized('Invalid credentials');

      const isPasswordValid = await bcrypt.compare(dto.password, user.password);
      if (!isPasswordValid) return unauthorized('Invalid credentials');

      // Checked after the password, not before: the caller has already
      // proven they own these credentials, so naming the real reason here
      // does not hand an attacker anything the enumeration guard above
      // protects against.
      if (user.isBlocked) return unauthorized('This account has been blocked');

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return ok({
        accessToken: this.generateToken(user.id, user.email, user.roles),
        user: this.publicView(user),
        onboarding: this.onboarding.buildState(user),
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getProfile(userId: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        // Explicit select — an `include` would ship the password hash to the client.
        select: {
          ...PUBLIC_USER_SELECT,
          driver: { include: { vehiclePhotos: true } },
        },
      });

      if (!user) return notFound('User not found');

      const state = await this.onboarding.getState(userId);
      return ok({ ...user, onboarding: state.body });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Never let the password hash out, whatever the caller asked for. */
  private publicView(user: User) {
    const { password, ...rest } = user as User & { password: string | null };
    return rest;
  }

  private generateToken(userId: string, email: string | null, roles: string[]) {
    return this.jwtService.sign(
      { sub: userId, email, roles },
      { secret: process.env.JWT_SECRET || 'rabi-secret-key', expiresIn: '7d' },
    );
  }
}

/**
 * Best-effort split of a provider display name.
 *
 * Everything after the first token becomes the surname, so "Ada Nkem Obi" gives
 * "Ada" / "Nkem Obi" rather than dropping the middle name. The user can correct
 * both on the profile screen — this only exists to pre-fill it.
 */
function splitName(displayName: string | null): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!displayName?.trim()) return { firstName: null, lastName: null };

  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };

  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
