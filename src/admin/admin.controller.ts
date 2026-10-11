import { Controller, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ApiAdminErrors, ApiOkEnvelope } from '../common/swagger/api-envelope.decorator';
import {
  ADMIN_ACTIVITY_EXAMPLE,
  ADMIN_SUMMARY_EXAMPLE,
  SOCKET_ACTIVITY_EXAMPLE,
} from '../common/swagger/examples';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@ApiBearerAuth('bearer')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(
    private admin: AdminService,
    private response: ResponsesService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Dashboard headline tiles',
    description:
      'Orders, revenue, drivers, users, support and live order counts in one call. `drivers.online` comes from Redis presence rather than the `isAvailable` column — a driver whose app was killed is still notionally on shift but is not reachable, and comes back null if Redis is unavailable rather than failing the whole response.',
  })
  @ApiOkEnvelope(ADMIN_SUMMARY_EXAMPLE)
  @ApiAdminErrors()
  async summary() {
    try {
      return this.response.handle(await this.admin.summary());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('trend')
  @ApiOperation({
    summary: 'Orders and revenue per day',
    description:
      'One row per day for the requested span, including days with no orders — the chart needs a continuous axis, so empty days are zero-filled rather than absent.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    example: 14,
    description: 'Span in days, 1-90. Defaults to 14.',
  })
  @ApiOkEnvelope([{ date: '2026-08-21', orders: 42, delivered: 38, revenue: 147000 }])
  @ApiAdminErrors()
  async trend(@Query('days', new ParseIntPipe({ optional: true })) days?: number) {
    try {
      return this.response.handle(await this.admin.orderTrend(days ?? 14));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('vehicle-split')
  @ApiOperation({
    summary: 'Orders and revenue by vehicle type',
    description: 'Feeds the dashboard donut.',
  })
  @ApiOkEnvelope([{ vehicleType: 'TRICYCLE', orders: 1840, revenue: 6440000 }])
  @ApiAdminErrors()
  async vehicleSplit() {
    try {
      return this.response.handle(await this.admin.vehicleSplit());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Live activity feed',
    description:
      'Deliveries, cancellations, driver sign-ups and new tickets, newest first. Built from the domain tables rather than the audit log: this is what the platform did, whereas the audit log is what an admin did.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
    description: 'Rows to return, 1-50. Defaults to 20.',
  })
  @ApiOkEnvelope(ADMIN_ACTIVITY_EXAMPLE)
  @ApiAdminErrors()
  async activity(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    try {
      return this.response.handle(await this.admin.activity(limit ?? 20));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('socket-activity')
  @ApiOperation({
    summary: 'What dispatch is doing right now',
    description:
      'The driver pool per vehicle type, and every order still on the market with how many drivers it has actually reached. That last number is the point: an order sitting unclaimed is either being seen by nobody or ignored by everybody, and the two need different remedies.',
  })
  @ApiOkEnvelope(SOCKET_ACTIVITY_EXAMPLE)
  @ApiAdminErrors()
  async socketActivity() {
    try {
      return this.response.handle(await this.admin.socketActivity());
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
