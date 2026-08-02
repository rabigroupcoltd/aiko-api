import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
  // AuthService builds the same state into its sign-in response.
  exports: [OnboardingService],
})
export class OnboardingModule {}
