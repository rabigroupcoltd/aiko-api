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

/** The screens every account walks, whichever type they pick. */
const SHARED_STEPS: OnboardingStep[] = [
  OnboardingStep.PHONE,
  OnboardingStep.PROFILE,
  OnboardingStep.PHOTO,
  OnboardingStep.LIVENESS,
  OnboardingStep.USER_TYPE,
];

/** Registering the vehicle, then waiting for an admin to clear the KYC. */
const RIDER_STEPS: OnboardingStep[] = [
  OnboardingStep.RIDER_DOCS,
  OnboardingStep.AWAITING_APPROVAL,
];

/**
 * The screens this account actually has to walk, in order.
 *
 * Type-dependent so `stepIndex` and `totalSteps` stay consistent with each
 * other — a passenger reaching DONE is 5 of 5, not 7 of 5. An account that has
 * not chosen yet is measured against the shorter path; picking RIDER simply
 * grows the bar, which is what the app's own StepDots does.
 */
export function onboardingSequence(accountType: AccountType | null): OnboardingStep[] {
  return accountType === AccountType.RIDER
    ? [...SHARED_STEPS, ...RIDER_STEPS, OnboardingStep.DONE]
    : [...SHARED_STEPS, OnboardingStep.DONE];
}

/** Every step in order, riders included. */
export const ONBOARDING_SEQUENCE = onboardingSequence(AccountType.RIDER);

export type DriverApprovalStatus = 'NOT_APPLICABLE' | 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface OnboardingState {
  /** Where to send the user next. Derived from data, not from the breadcrumb. */
  resumeStep: OnboardingStep;
  /** The last step the client reported reaching. */
  recordedStep: OnboardingStep;
  stepIndex: number;
  totalSteps: number;
  completed: boolean;
  completedAt: string | null;
  accountType: AccountType | null;
  /**
   * True once the shared steps are behind them.
   *
   * Every driver is a passenger by default, so a rider waiting on KYC can
   * already book trips — the client must not lock them out of the app just
   * because `completed` is still false.
   */
  passengerReady: boolean;
  /** Rider-only. NOT_APPLICABLE for passengers. */
  driver: {
    status: DriverApprovalStatus;
    driverId: string | null;
    rejectionReason: string | null;
  };
  /** Per-step flags, so a client can render its own progress UI. */
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

/** Everything resolveStep needs. `driver` is null for passengers. */
type DriverSummary = { id: string; kycStatus: KycStatus; kycRejectionReason: string | null };
type UserWithDriver = User & { driver?: DriverSummary | null };

/** What sign-in and the onboarding routes must select to build the state. */
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

  /**
   * Accounts that must never be sent through the onboarding stack.
   *
   * Staff sign in with a password and have no profile photo or date of birth,
   * so a pure data check would strand them on the profile screen. Completion is
   * also sticky: once someone has finished, clearing a field later — an admin
   * wiping a bad selfie, say — must not drag an established rider back into
   * onboarding mid-shift.
   */
  private isStaff(user: User): boolean {
    return user.authProvider === AuthProvider.PASSWORD;
  }

  /** True once the steps every account shares are behind them. */
  private sharedStepsDone(user: User): boolean {
    if (this.isStaff(user)) return true;
    // Sticky: clearing a field later must not drag an established account back
    // through the profile screens.
    if (user.onboardingCompletedAt) return true;

    return (
      this.hasProfile(user) &&
      Boolean(user.profilePhotoUrl) &&
      Boolean(user.livenessPassedAt) &&
      Boolean(user.accountType)
    );
  }

  /**
   * The first incomplete step, derived from DATA PRESENCE rather than the
   * persisted `onboardingStep` counter.
   *
   * The counter goes stale the moment a write lands but the follow-up request
   * that advances it does not — an app killed between the two, a retried
   * request, a profile edited later from the drawer. When the two disagree,
   * this wins, which is the same rule the Aiko client applies locally.
   */
  resolveStep(user: UserWithDriver): OnboardingStep {
    if (this.isStaff(user)) return OnboardingStep.DONE;

    // Sticky only across the shared steps. The driver checks below always
    // re-run, because approval can be withdrawn after the fact — an admin who
    // revokes a KYC must put that rider back in front of the waiting screen.
    if (!user.onboardingCompletedAt) {
      // PHONE is not resolved to on its own — Google sign-in is the only way
      // in for now, and it gives no number, so the profile screen collects
      // phone alongside name/email/dob instead of a separate screen for it.
      // The PHONE step stays in the enum for when a real phone-first sign-in
      // returns.
      if (!this.hasProfile(user)) return OnboardingStep.PROFILE;
      if (!user.profilePhotoUrl) return OnboardingStep.PHOTO;
      if (!user.livenessPassedAt) return OnboardingStep.LIVENESS;
      if (!user.accountType) return OnboardingStep.USER_TYPE;
    }

    // Passengers finish at the role choice.
    if (user.accountType !== AccountType.RIDER) return OnboardingStep.DONE;

    // Registering the vehicle IS the rider document step.
    if (!user.driver) return OnboardingStep.RIDER_DOCS;

    switch (user.driver.kycStatus) {
      case KycStatus.PENDING:
        return OnboardingStep.AWAITING_APPROVAL;
      // A rejection sends them back to re-shoot the documents.
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
    // A staff or already-completed account owes nothing, so reporting raw data
    // flags would contradict `completed` — an admin row would come back "done"
    // with every requirement false.
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
        // Both are "met" for a passenger — they are not asked for either.
        vehicleDetails: !isRider || Boolean(user.driver),
        adminApproval: !isRider || status === 'APPROVED',
      },
    };
  }

  /**
   * The PHOTO step's upload half.
   *
   * Separate from `update` because that one only ever writes fields it is
   * handed — this is the one call site that has to put bytes in object storage
   * first and turn them into the url/key `update` expects.
   */
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

  /** `buildState`, with the derived progress written back to the row. */
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

  /**
   * Applies whatever the client sends for the step it just finished, then
   * recomputes the resume point from the result.
   *
   * Every field is optional so one endpoint serves every screen — the app sends
   * the profile fields from ProfileForm, `livenessPassed` from Liveness, and so
   * on, rather than needing a route each.
   */
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

      // Email is unique, so a collision has to come back as a 409 rather than a
      // raw Prisma error — errorHandler already maps P2002 for us.
      if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase();

      if (dto.livenessPassed !== undefined) {
        data.livenessPassedAt = dto.livenessPassed ? new Date() : null;
      }

      if (dto.accountType !== undefined) {
        data.accountType = dto.accountType as AccountType;
        // RIDER is additive: a rider is still a passenger when off duty.
        data.roles =
          dto.accountType === AccountType.RIDER
            ? { set: [UserRole.USER, UserRole.RIDER] }
            : { set: [UserRole.USER] };
      }

      // Keep the display name in step with the parts once both are known.
      const firstName = dto.firstName ?? existing.firstName;
      const lastName = dto.lastName ?? existing.lastName;
      if (firstName && lastName) data.name = `${firstName} ${lastName}`;

      // The client's own breadcrumb. Recorded as sent — resolveStep is what
      // anything important reads, so a wrong value here cannot strand anyone.
      if (dto.step !== undefined) data.onboardingStep = dto.step as OnboardingStep;

      const updated = await this.prisma.user.update({
        where: { id: userId },
        data,
        include: { driver: { select: ONBOARDING_DRIVER_SELECT } },
      });

      // An explicit breadcrumb from the client is kept as sent; otherwise the
      // stored step follows the data.
      return ok(await this.syncProgress(updated, this.buildState(updated), dto.step === undefined));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Persists what `buildState` derived, so the stored row always says where the
   * user is — not just the computed response.
   *
   * - Stamps `onboardingCompletedAt` the first time the derived step reaches
   *   DONE, making completion sticky. This also covers accounts that finished
   *   before the stamp existed: their first read seals them.
   * - Moves the `onboardingStep` breadcrumb to the derived resume step.
   */
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
