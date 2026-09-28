import { Injectable } from '@nestjs/common';
import { AuditEntity, AuthProvider, OnboardingStep } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { JwtUser } from '../common/current-user.decorator';
import { PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, conflict, forbidden, notFound, ok } from '../common/responses/response.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockUserDto, CreateStaffDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
    private audit: AuditService,
  ) {}

  async findAll(): Promise<ServiceResult> {
    try {
      const users = await this.prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
      });
      return ok(users);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id },
        // Explicit select — an `include` would ship the password hash to the client.
        select: { ...PUBLIC_USER_SELECT, driver: { include: { vehiclePhotos: true } } },
      });

      if (!user) return notFound('User not found');
      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(
    id: string,
    data: { name?: string; phone?: string },
    currentUserId: string,
  ): Promise<ServiceResult> {
    try {
      if (id !== currentUserId) {
        const currentUser = await this.prisma.user.findUnique({ where: { id: currentUserId } });
        if (!currentUser?.roles.includes('ADMIN')) {
          return forbidden('You can only update your own profile');
        }
      }

      const user = await this.prisma.user.update({
        where: { id },
        data,
        select: PUBLIC_USER_SELECT,
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Blocks (or unblocks) any account — a passenger, a rider, or another staff
   * member. `JwtStrategy` re-checks `isBlocked` on every request, so this
   * takes effect immediately rather than at the account's next sign-in.
   *
   * Deliberately does not touch anything else: an order already in progress
   * is left alone, same as blocking a driver never un-assigns their held
   * orders. Only new activity by this account is what stops.
   */
  async block(id: string, dto: BlockUserDto, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const existing = await this.prisma.user.findUnique({ where: { id } });
      if (!existing) return notFound('User not found');

      const user = await this.prisma.user.update({
        where: { id },
        data: {
          isBlocked: dto.isBlocked,
          blockedReason: dto.isBlocked ? (dto.reason ?? null) : null,
        },
        select: PUBLIC_USER_SELECT,
      });

      await this.audit.record({
        actor,
        action: dto.isBlocked ? 'user.block' : 'user.unblock',
        entity: AuditEntity.USER,
        entityId: id,
        summary: `${dto.isBlocked ? 'Blocked' : 'Unblocked'} ${existing.name ?? existing.email ?? id}`,
        metadata: { reason: dto.reason ?? null },
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Creates a password-authenticated staff account — the dashboard's own
   * equivalent of `prisma/seed.ts`'s admin bootstrap, for every account after
   * the first one.
   *
   * `USER` is added alongside whatever role is requested, the same way the
   * seed script does it: nothing else in the codebase should have to
   * special-case "a staff account with no base role".
   *
   * Staff never walk the onboarding stack — `OnboardingService.isStaff` keys
   * on `authProvider === PASSWORD`, which this sets, so the new account
   * resolves straight to DONE the first time anything asks.
   */
  async createStaff(dto: CreateStaffDto, actor?: JwtUser): Promise<ServiceResult> {
    try {
      const email = dto.email.trim().toLowerCase();

      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) return conflict('A user with this email already exists');

      const user = await this.prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(dto.password, 10),
          name: dto.name,
          roles: [dto.role, 'USER'],
          authProvider: AuthProvider.PASSWORD,
          emailVerified: true,
          onboardingStep: OnboardingStep.DONE,
          onboardingCompletedAt: new Date(),
        },
        select: PUBLIC_USER_SELECT,
      });

      await this.audit.record({
        actor,
        action: 'user.create-staff',
        entity: AuditEntity.USER,
        entityId: user.id,
        summary: `Created ${dto.role.toLowerCase()} account for ${dto.name}`,
        metadata: { role: dto.role },
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
