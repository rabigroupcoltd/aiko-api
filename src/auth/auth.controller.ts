import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiNotFound,
  ApiOkEnvelope,
  ApiOkEnvelopeExamples,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  ADMIN_SESSION_EXAMPLE,
  FIREBASE_SESSION_NEW_EXAMPLE,
  FIREBASE_SESSION_RETURNING_EXAMPLE,
  PROFILE_EXAMPLE,
} from '../common/swagger/examples';
import { AuthService } from './auth.service';
import { FirebaseSignInDto, LoginDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private response: ResponsesService,
  ) {}

  @Post('firebase')
  @ApiOperation({
    summary: 'Sign in with a Firebase ID token',
    description: [
      'The single entry point for the app. There is no password and no separate',
      'registration call — the same request signs a new user up and signs a',
      'returning one back in.',
      '',
      'Works with either Firebase provider:',
      '',
      '- **Google** — the token carries an email, which becomes the account email.',
      '- **Phone** — the client runs the OTP flow with Firebase, then sends the',
      '  resulting token here. The number arrives already verified, so the PHONE',
      '  step is skipped and the user lands on PROFILE.',
      '',
      'If the email or phone already belongs to an account, that account is',
      'returned and the new Firebase uid is linked to it, so switching provider',
      'never creates a duplicate or restarts onboarding.',
      '',
      'Navigate to `onboarding.resumeStep`. It is `DONE` for a user who has',
      'finished setting up, which is the "straight to the dashboard" case.',
    ].join('\n'),
  })
  @ApiOkEnvelopeExamples({
    returningUser: {
      summary: 'Returning user — go straight to the dashboard',
      message: 'Signed in',
      data: FIREBASE_SESSION_RETURNING_EXAMPLE,
    },
    newUser: {
      summary: 'New user — start onboarding at resumeStep',
      message: 'Signed in',
      data: FIREBASE_SESSION_NEW_EXAMPLE,
    },
  })
  @ApiValidationError('idToken must be longer than or equal to 20 characters')
  @ApiUnauthorized('Sign-in token has expired')
  async signInWithFirebase(@Body() dto: FirebaseSignInDto) {
    try {
      const result = await this.authService.signInWithFirebase(dto);
      return this.response.handle(result, { message: 'Signed in' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('login')
  @ApiOperation({
    summary: 'Staff sign-in with a password',
    description:
      'For the admin dashboard, which has no Firebase client. App accounts are created through Firebase and carry no password, so they can never authenticate here — every failure returns the same message rather than revealing which case it was.',
  })
  @ApiOkEnvelope(ADMIN_SESSION_EXAMPLE, { message: 'Logged in' })
  @ApiUnauthorized('Invalid credentials')
  @ApiValidationError('email must be an email')
  async login(@Body() dto: LoginDto) {
    try {
      const result = await this.authService.login(dto);
      return this.response.handle(result, { message: 'Logged in' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('profile')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Get the signed-in user',
    description:
      'Public user columns, the driver profile when the caller has one, and the same onboarding block the sign-in endpoints return.',
  })
  @ApiOkEnvelope(PROFILE_EXAMPLE)
  @ApiUnauthorized()
  @ApiNotFound('User not found')
  async getProfile(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.authService.getProfile(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
