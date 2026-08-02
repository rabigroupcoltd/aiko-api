import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiCreatedEnvelope,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import { DEVICE_EXAMPLE, DEVICE_LIST_EXAMPLE } from '../common/swagger/examples';
import { DeviceTokensService } from './device-tokens.service';
import { RegisterDeviceDto, TestPushDto, UnregisterDeviceDto } from './dto/notification.dto';
import { PUSH_TYPES } from './notifications.constants';
import { PushService } from './push.service';

@ApiTags('Notifications')
@ApiBearerAuth('bearer')
@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(
    private devices: DeviceTokensService,
    private push: PushService,
    private response: ResponsesService,
  ) {}

  @Post('devices')
  @ApiOperation({
    summary: 'Register this device for push',
    description:
      'Call on every launch and whenever the FCM token refreshes — it is idempotent. ' +
      'Sending a `deviceId` lets a rotated token replace the previous registration for the ' +
      'same handset, and drops the previous owner’s registration if the phone changed hands.',
  })
  @ApiCreatedEnvelope(DEVICE_EXAMPLE, { message: 'Device registered' })
  @ApiValidationError('token must be longer than or equal to 10 characters')
  @ApiUnauthorized()
  async register(@CurrentUser('sub') userId: string, @Body() dto: RegisterDeviceDto) {
    try {
      const result = await this.devices.register(userId, dto);
      return this.response.handleCreated(result, 'Device registered');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Delete('devices')
  @ApiOperation({
    summary: 'Stop push to this device',
    description:
      'Call on sign-out, before the session is cleared. Only the caller’s own registrations can be removed.',
  })
  @ApiOkEnvelope({ removed: 1 }, { message: 'Device removed' })
  @ApiUnauthorized()
  async unregister(@CurrentUser('sub') userId: string, @Body() dto: UnregisterDeviceDto) {
    try {
      const result = await this.devices.unregister(userId, dto.token);
      return this.response.handle(result, { message: 'Device removed' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('devices')
  @ApiOperation({
    summary: 'Devices registered to the caller',
    description: 'The tokens themselves are never returned — they are send-only credentials.',
  })
  @ApiOkEnvelope(DEVICE_LIST_EXAMPLE)
  @ApiUnauthorized()
  async list(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.devices.listForUser(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('test')
  @ApiOperation({
    summary: 'Send yourself a test push',
    description:
      'Delivers to every device registered to the caller. `sent: 0` with no error means the ' +
      'token was accepted but Firebase is not configured on this server, or the device has ' +
      'not registered yet.',
  })
  @ApiOkEnvelope({ sent: 1, failed: 0, pruned: 0 }, { message: 'Test notification sent' })
  @ApiUnauthorized()
  async test(@CurrentUser('sub') userId: string, @Body() dto: TestPushDto) {
    try {
      const result = await this.push.sendToUsers([userId], {
        type: PUSH_TYPES.TRIP_STATUS,
        title: dto.title || 'Aiko',
        body: dto.body || 'Push notifications are working.',
        data: { dedupeKey: `test:${userId}`, test: true },
      });

      return this.response.success(result, 'Test notification sent');
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
