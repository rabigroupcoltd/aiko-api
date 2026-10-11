import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
