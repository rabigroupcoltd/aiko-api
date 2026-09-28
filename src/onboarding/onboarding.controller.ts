import { Body, Controller, Get, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiConflict,
  ApiNotFound,
  ApiOkEnvelope,
  ApiOkEnvelopeExamples,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  ONBOARDING_STATE_AWAITING_APPROVAL_EXAMPLE,
  ONBOARDING_STATE_DONE_EXAMPLE,
  ONBOARDING_STATE_EXAMPLE,
  ONBOARDING_STATE_REJECTED_EXAMPLE,
  ONBOARDING_STATE_RIDER_DOCS_EXAMPLE,
  ONBOARDING_STATE_RIDER_DONE_EXAMPLE,
} from '../common/swagger/examples';
import { imageFilePipe, imageUploadOptions } from '../common/upload';
import { UploadFile } from '../storage/storage.types';
import { UpdateOnboardingDto } from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiBearerAuth('bearer')
@Controller('onboarding')
@UseGuards(AuthGuard('jwt'))
export class OnboardingController {
  constructor(
    private onboardingService: OnboardingService,
    private response: ResponsesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Where the user left off',
    description: [
      'Send the user to `resumeStep`. It is derived from what has actually been',
      'saved, so it stays correct even if the app was killed mid-step or a field',
      'was later cleared. `recordedStep` is only the client’s own breadcrumb.',
      '',
      'The rider tail is not driven by this endpoint:',
      '',
      '- `RIDER_DOCS` clears when the vehicle is registered through',
      '  `POST /api/drivers/register`, which moves the user to AWAITING_APPROVAL.',
      '- `AWAITING_APPROVAL` clears when an admin calls',
      '  `PATCH /api/drivers/{id}/kyc/approve`. A rejection sends them back to',
      '  RIDER_DOCS with `driver.rejectionReason` set.',
      '',
      'Watch `passengerReady`, not `completed`, before letting someone into the',
      'app. Every driver is a passenger by default, so a rider waiting on KYC can',
      'already book trips — gating on `completed` would lock them out for as long',
      'as approval takes.',
    ].join('\n'),
  })
  @ApiOkEnvelopeExamples({
    midOnboarding: {
      summary: 'Profile saved, selfie outstanding — resume at PHOTO',
      data: ONBOARDING_STATE_EXAMPLE,
    },
    riderVehicleOutstanding: {
      summary: 'Rider who has not registered a vehicle — resume at RIDER_DOCS',
      data: ONBOARDING_STATE_RIDER_DOCS_EXAMPLE,
    },
    riderAwaitingApproval: {
      summary: 'Vehicle registered, waiting on admin KYC — resume at AWAITING_APPROVAL',
      data: ONBOARDING_STATE_AWAITING_APPROVAL_EXAMPLE,
    },
    riderRejected: {
      summary: 'KYC rejected — back to RIDER_DOCS with the reason',
      data: ONBOARDING_STATE_REJECTED_EXAMPLE,
    },
    riderApproved: {
      summary: 'Approved rider — go to the dashboard',
      data: ONBOARDING_STATE_RIDER_DONE_EXAMPLE,
    },
    passengerFinished: {
      summary: 'Passenger setup complete — go to the dashboard',
      data: ONBOARDING_STATE_DONE_EXAMPLE,
    },
  })
  @ApiUnauthorized()
  @ApiNotFound('User not found')
  async getState(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.onboardingService.getState(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('photo')
  @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload the onboarding selfie',
    description:
      'Multipart, one file under the `photo` field. Uploads it to object storage and saves the resulting URL/key against the account in one call — the client never sees the raw url/key round trip that `PATCH /onboarding` otherwise expects for this step. Returns the recomputed onboarding state, same as `PATCH /onboarding`.',
  })
  @ApiOkEnvelope(ONBOARDING_STATE_EXAMPLE, { message: 'Onboarding updated' })
  @ApiValidationError('A photo is required')
  @ApiUnauthorized()
  @ApiNotFound('User not found')
  async uploadPhoto(
    @CurrentUser('sub') userId: string,
    @UploadedFile(imageFilePipe) photo?: UploadFile,
  ) {
    try {
      const result = await this.onboardingService.uploadPhoto(userId, photo);
      return this.response.handle(result, { message: 'Onboarding updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch()
  @ApiOperation({
    summary: 'Save a completed step',
    description:
      'One endpoint for every onboarding screen — send only the fields that screen captured. The response carries the recomputed state, so the client can navigate straight to `resumeStep` without deciding for itself. Reaching DONE stamps `completedAt` once.',
  })
  @ApiOkEnvelope(ONBOARDING_STATE_DONE_EXAMPLE, { message: 'Onboarding updated' })
  @ApiValidationError('dob must be a valid ISO 8601 date string')
  @ApiUnauthorized()
  @ApiNotFound('User not found')
  @ApiConflict('A record with this email already exists')
  async update(@CurrentUser('sub') userId: string, @Body() dto: UpdateOnboardingDto) {
    try {
      const result = await this.onboardingService.update(userId, dto);
      return this.response.handle(result, { message: 'Onboarding updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
