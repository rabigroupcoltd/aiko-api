import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * Global so PricingService (and anything else that reads a platform-wide
 * numeric knob later) can inject it without importing this module directly —
 * the same reasoning as AuditModule.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
