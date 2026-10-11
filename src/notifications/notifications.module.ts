import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeviceTokensService } from './device-tokens.service';
import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';
import { RideNotificationsService } from './ride-notifications.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [PushService, DeviceTokensService, RideNotificationsService],
  exports: [PushService],
})
export class NotificationsModule {}
