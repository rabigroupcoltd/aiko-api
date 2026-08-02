import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeviceTokensService } from './device-tokens.service';
import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';
import { RideNotificationsService } from './ride-notifications.service';

/**
 * Push notifications.
 *
 * Global because PushService is a leaf utility any feature may want, and
 * RideNotificationsService binds itself to the event bus at init — so importing
 * this module once is all that is needed for the ride flow to start notifying.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [PushService, DeviceTokensService, RideNotificationsService],
  exports: [PushService],
})
export class NotificationsModule {}
