import { Injectable } from '@nestjs/common';
import {
  AccountType,
  AuthProvider,
  KycStatus,
  OnboardingStep,
  Prisma,
  User,
  UserRole,
} from '@prisma/client';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, badRequest, notFound, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { UploadFile } from '../storage/storage.types';
import { UpdateOnboardingDto } from './dto/onboarding.dto';

const SHARED_STEPS: OnboardingStep[] = [
  OnboardingStep.PHONE,
  OnboardingStep.PROFILE,
  OnboardingStep.PHOTO,
  OnboardingStep.LIVENESS,
  OnboardingStep.USER_TYPE,
];

const RIDER_STEPS: OnboardingStep[] = [
  OnboardingStep.RIDER_DOCS,
  OnboardingStep.AWAITING_APPROVAL,
];

export function onboardingSequence(accountType: AccountType | null): OnboardingStep[] {
  return accountType === AccountType.RIDER
    ? [...SHARED_STEPS, ...RIDER_STEPS, OnboardingStep.DONE]
    : [...SHARED_STEPS, OnboardingStep.DONE];
}

export const ONBOARDING_SEQUENCE = onboardingSequence(AccountType.RIDER);

export type DriverApprovalStatus = 'NOT_APPLICABLE' | 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface OnboardingState {
  resumeStep: OnboardingStep;
  recordedStep: OnboardingStep;
  stepIndex: number;
  totalSteps: number;
  completed: boolean;
  completedAt: string | null;
  accountType: AccountType | null;
  passengerReady: boolean;
  driver: {
    status: DriverApprovalStatus;
    driverId: string | null;
    rejectionReason: string | null;
  };
  requirements: {
    phone: boolean;
    profile: boolean;
    photo: boolean;
    liveness: boolean;
    accountType: boolean;
    vehicleDetails: boolean;
    adminApproval: boolean;
  };
}

type DriverSummary = { id: string; kycStatus: KycStatus; kycRejectionReason: string | null };
type UserWithDriver = User & { driver?: DriverSummary | null };

export const ONBOARDING_DRIVER_SELECT = {
  id: true,
  kycStatus: true,
  kycRejectionReason: true,
} as const;

@Injectable()
export class OnboardingService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
    private storage: StorageService,
  ) {}

  private isStaff(user: User): boolean {
    return user.authProvider === AuthProvider.PASSWORD;
  }

  private sharedStepsDone(user: User): boolean {
    if (this.isStaff(user)) return true;
    if (user.onboardingCompletedAt) return true;

    return (
      this.hasProfile(user) &&
      Boolean(user.profilePhotoUrl) &&
      Boolean(user.livenessPassedAt) &&
      Boolean(user.accountType)
    );
  }

  resolveStep(user: UserWithDriver): OnboardingStep {
    if (this.isStaff(user)) return OnboardingStep.DONE;

    if (!user.onboardingCompletedAt) {
      if (!this.hasProfile(user)) return OnboardingStep.PROFILE;
      if (!user.profilePhotoUrl) return OnboardingStep.PHOTO;
      if (!user.livenessPassedAt) return OnboardingStep.LIVENESS;
      if (!user.accountType) return OnboardingStep.USER_TYPE;
    }

    if (user.accountType !== AccountType.RIDER) return OnboardingStep.DONE;

    if (!user.driver) return OnboardingStep.RIDER_DOCS;

    switch (user.driver.kycStatus) {
      case KycStatus.PENDING:
        return OnboardingStep.AWAITING_APPROVAL;
      case KycStatus.REJECTED:
        return OnboardingStep.RIDER_DOCS;
      default:
        return OnboardingStep.DONE;
    }
  }

  private hasProfile(user: User): boolean {
    return Boolean(user.firstName && user.lastName && user.email && user.dob && user.phone);
  }

  private driverStatus(user: UserWithDriver): DriverApprovalStatus {
    if (user.accountType !== AccountType.RIDER) return 'NOT_APPLICABLE';
    if (!user.driver) return 'NOT_SUBMITTED';

    switch (user.driver.kycStatus) {
      case KycStatus.PENDING:
        return 'PENDING';
      case KycStatus.REJECTED:
        return 'REJECTED';
      default:
        return 'APPROVED';
    }
  }

  buildState(user: UserWithDriver): OnboardingState {
    const resumeStep = this.resolveStep(user);
    const status = this.driverStatus(user);
    const passengerReady = this.sharedStepsDone(user);
    const shortCircuit = this.isStaff(user) || Boolean(user.onboardingCompletedAt);
    const isRider = user.accountType === AccountType.RIDER;
    const sequence = onboardingSequence(user.accountType);

    return {
      resumeStep,
      recordedStep: user.onboardingStep,
      stepIndex: sequence.indexOf(resumeStep),
      totalSteps: sequence.length - 1,
      completed: resumeStep === OnboardingStep.DONE,
      completedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      accountType: user.accountType,
      passengerReady,
      driver: {
        status,
        driverId: user.driver?.id ?? null,
        rejectionReason: user.driver?.kycRejectionReason ?? null,
      },
      requirements: {
        phone: shortCircuit || Boolean(user.phone),
        profile: shortCircuit || this.hasProfile(user),
        photo: shortCircuit || Boolean(user.profilePhotoUrl),
        liveness: shortCircuit || Boolean(user.livenessPassedAt),
        accountType: shortCircuit || Boolean(user.accountType),
        vehicleDetails: !isRider || Boolean(user.driver),
        adminApproval: !isRider || status === 'APPROVED',
      },
    };
  }

  async uploadPhoto(userId: string, file?: UploadFile): Promise<ServiceResult> {
    try {
      if (!file) return badRequest('A photo is required');

      const uploaded = await this.storage.upload(file, { folder: `profiles/${userId}` });

      return this.update(userId, {
        profilePhotoUrl: uploaded.url,
        profilePhotoKey: uploaded.key,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  stateFor(user: UserWithDriver): Promise<OnboardingState> {
    return this.syncProgress(user, this.buildState(user));
  }

  async getState(userId: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { driver: { select: ONBOARDING_DRIVER_SELECT } },
      });

      if (!user) return notFound('User not found');
      return ok(await this.stateFor(user));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(userId: string, dto: UpdateOnboardingDto): Promise<ServiceResult> {
    try {
      const existing = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!existing) return notFound('User not found');

      const data: Prisma.UserUpdateInput = {};

      if (dto.firstName !== undefined) data.firstName = dto.firstName;
      if (dto.lastName !== undefined) data.lastName = dto.lastName;
      if (dto.dob !== undefined) data.dob = new Date(dto.dob);
      if (dto.phone !== undefined) data.phone = dto.phone;
      if (dto.profilePhotoUrl !== undefined) data.profilePhotoUrl = dto.profilePhotoUrl;
      if (dto.profilePhotoKey !== undefined) data.profilePhotoKey = dto.profilePhotoKey;

      if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase();

      if (dto.livenessPassed !== undefined) {
        data.livenessPassedAt = dto.livenessPassed ? new Date() : null;
      }

      if (dto.accountType !== undefined) {
        data.accountType = dto.accountType as AccountType;
        data.roles =
          dto.accountType === AccountType.RIDER
            ? { set: [UserRole.USER, UserRole.RIDER] }
            : { set: [UserRole.USER] };
      }

      const firstName = dto.firstName ?? existing.firstName;
      const lastName = dto.lastName ?? existing.lastName;
      if (firstName && lastName) data.name = `${firstName} ${lastName}`;

      if (dto.step !== undefined) data.onboardingStep = dto.step as OnboardingStep;

      const updated = await this.prisma.user.update({
        where: { id: userId },
        data,
        include: { driver: { select: ONBOARDING_DRIVER_SELECT } },
      });

      return ok(await this.syncProgress(updated, this.buildState(updated), dto.step === undefined));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async syncProgress(
    user: UserWithDriver,
    state: OnboardingState,
    followResume = true,
  ): Promise<OnboardingState> {
    if (this.isStaff(user)) return state;

    const data: Prisma.UserUpdateInput = {};
    if (state.completed && !user.onboardingCompletedAt) {
      data.onboardingCompletedAt = new Date();
    }
    if ((followResume || state.completed) && user.onboardingStep !== state.resumeStep) {
      data.onboardingStep = state.resumeStep;
    }
    if (Object.keys(data).length === 0) return state;

    await this.prisma.user.update({ where: { id: user.id }, data });
    if (data.onboardingCompletedAt) {
      state.completedAt = (data.onboardingCompletedAt as Date).toISOString();
    }
    if (data.onboardingStep) state.recordedStep = state.resumeStep;
    return state;
  }
}
