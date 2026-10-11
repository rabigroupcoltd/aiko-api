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

  private async linkExisting(user: User, identity: FirebaseIdentity) {
    const data: Prisma.UserUpdateInput = { lastLoginAt: new Date() };

    if (!user.firebaseUid) data.firebaseUid = identity.uid;
    if (!user.email && identity.email) data.email = identity.email;
    if (!user.phone && identity.phone) data.phone = identity.phone;
    if (!user.name && identity.displayName) data.name = identity.displayName;
    if (!user.photoUrl && identity.photoUrl) data.photoUrl = identity.photoUrl;

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
        onboardingStep: identity.phone ? 'PROFILE' : 'PHONE',
        lastLoginAt: new Date(),
      },
      include: SIGN_IN_INCLUDE,
    });
  }

  async login(dto: LoginDto): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        include: SIGN_IN_INCLUDE,
      });

      if (!user || !user.password) return unauthorized('Invalid credentials');

      const isPasswordValid = await bcrypt.compare(dto.password, user.password);
      if (!isPasswordValid) return unauthorized('Invalid credentials');

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

function splitName(displayName: string | null): {
  firstName: string | null;
  lastName: string | null;
} {
  if (!displayName?.trim()) return { firstName: null, lastName: null };

  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };

  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
