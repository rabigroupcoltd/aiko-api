import { Controller, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ApiAdminErrors, ApiOkEnvelope } from '../common/swagger/api-envelope.decorator';
import {
  ANALYTICS_DRIVERS_EXAMPLE,
  ANALYTICS_LOW_PERFORMERS_EXAMPLE,
  ANALYTICS_ORDERS_EXAMPLE,
  ANALYTICS_OVERVIEW_EXAMPLE,
  ANALYTICS_REVENUE_EXAMPLE,
  ANALYTICS_TOP_DRIVERS_EXAMPLE,
  ANALYTICS_VEHICLE_TYPES_EXAMPLE,
} from '../common/swagger/examples';
import { AnalyticsService } from './analytics.service';

const LIMIT_QUERY = {
  name: 'limit',
  required: false,
  type: Number,
  example: 10,
  description: 'Rows to return. Defaults to 10.',
} as const;

@ApiTags('Analytics')
@ApiBearerAuth('bearer')
@Controller('analytics')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AnalyticsController {
  constructor(
    private analyticsService: AnalyticsService,
    private response: ResponsesService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Headline numbers',
    description:
      'Counts, revenue split by payment method, platform earnings and outstanding driver debt. Rates come back as strings with one decimal place.',
  })
  @ApiOkEnvelope(ANALYTICS_OVERVIEW_EXAMPLE)
  @ApiAdminErrors()
  async getOverview() {
    try {
      return this.response.handle(await this.analyticsService.getOverview());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('drivers')
  @ApiOperation({
    summary: 'Per-driver breakdown',
    description: 'One row per driver with lifetime earnings, fees paid, debt and acceptance rates.',
  })
  @ApiOkEnvelope(ANALYTICS_DRIVERS_EXAMPLE)
  @ApiAdminErrors()
  async getDriverAnalytics() {
    try {
      return this.response.handle(await this.analyticsService.getDriverAnalytics());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('orders')
  @ApiOperation({
    summary: 'Trip volumes by period',
    description: 'Today, this week and this month, plus all-time totals counted in the database.',
  })
  @ApiOkEnvelope(ANALYTICS_ORDERS_EXAMPLE)
  @ApiAdminErrors()
  async getOrderAnalytics() {
    try {
      return this.response.handle(await this.analyticsService.getOrderAnalytics());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('revenue')
  @ApiOperation({
    summary: 'Revenue over the last 30 days',
    description:
      '`chartData` has one entry per day that had a completed trip — days with no trips are absent rather than zero-filled.',
  })
  @ApiOkEnvelope(ANALYTICS_REVENUE_EXAMPLE)
  @ApiAdminErrors()
  async getRevenueAnalytics() {
    try {
      return this.response.handle(await this.analyticsService.getRevenueAnalytics());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('vehicle-types')
  @ApiOperation({
    summary: 'Demand by vehicle type',
    description: 'One row per pricing rule — how tricycle demand compares to bicycle.',
  })
  @ApiOkEnvelope(ANALYTICS_VEHICLE_TYPES_EXAMPLE)
  @ApiAdminErrors()
  async getVehicleTypeAnalytics() {
    try {
      return this.response.handle(await this.analyticsService.getVehicleTypeAnalytics());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('top-drivers')
  @ApiOperation({ summary: 'Busiest drivers', description: 'Ordered by lifetime trip count.' })
  @ApiQuery(LIMIT_QUERY)
  @ApiOkEnvelope(ANALYTICS_TOP_DRIVERS_EXAMPLE)
  @ApiAdminErrors()
  async getTopDrivers(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    try {
      return this.response.handle(await this.analyticsService.getTopDrivers(limit || 10));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('low-performers')
  @ApiOperation({
    summary: 'Lowest-rated drivers',
    description: 'Ordered by rating, worst first. Only drivers with at least one trip are included.',
  })
  @ApiQuery(LIMIT_QUERY)
  @ApiOkEnvelope(ANALYTICS_LOW_PERFORMERS_EXAMPLE)
  @ApiAdminErrors()
  async getLowPerformingDrivers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    try {
      return this.response.handle(await this.analyticsService.getLowPerformingDrivers(limit || 10));
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
