import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { VehicleType } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  FARE_QUOTE_ALL_EXAMPLE,
  FARE_QUOTE_EXAMPLE,
  PRICING_RULES_EXAMPLE,
  PRICING_RULE_EXAMPLE,
} from '../common/swagger/examples';
import {
  FareEstimateDto,
  UpdatePricingRuleDto,
  UpsertPricingRuleDto,
  VEHICLE_TYPES,
  VehicleTypeParamDto,
} from './dto/pricing.dto';
import { PricingService } from './pricing.service';

const VEHICLE_TYPE_PARAM = {
  name: 'vehicleType',
  enum: VEHICLE_TYPES,
  example: 'TRICYCLE',
} as const;

@ApiTags('Pricing')
@Controller('pricing')
export class PricingController {
  constructor(
    private pricingService: PricingService,
    private response: ResponsesService,
  ) {}

  /** Public so the booking screen can render rate cards before login. */
  @Get()
  @ApiOperation({
    summary: 'List rate cards',
    description: 'Public, so the booking screen can render rates before login.',
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    example: 'true',
    description: 'Pass `true` to hide deactivated rules.',
  })
  @ApiOkEnvelope(PRICING_RULES_EXAMPLE)
  async findAll(@Query('activeOnly') activeOnly?: string) {
    try {
      const result = await this.pricingService.findAll({ activeOnly: activeOnly === 'true' });
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('estimate')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Quote one vehicle type',
    description:
      'Straight-line distance multiplied by ROAD_DISTANCE_FACTOR, priced against the active rule, then rounded up to FARE_ROUNDING_STEP. `breakdown` is the object frozen into `Order.pricingSnapshot` when the trip is booked.',
  })
  @ApiOkEnvelope(FARE_QUOTE_EXAMPLE)
  @ApiValidationError('TRICYCLE is not available for booking')
  @ApiUnauthorized()
  async estimate(@Body() dto: FareEstimateDto) {
    try {
      const result = await this.pricingService.estimate(dto);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  /** One call, one quote per bookable vehicle type — TRICYCLE vs BICYCLE side by side. */
  @Post('estimate/all')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Quote every vehicle type',
    description:
      'One quote per active rule for the same route — powers the ride-picker screen. `vehicleType` in the body is ignored.',
  })
  @ApiOkEnvelope(FARE_QUOTE_ALL_EXAMPLE)
  @ApiValidationError('pickupLat must be a latitude string or number')
  @ApiUnauthorized()
  async estimateAll(@Body() dto: FareEstimateDto) {
    try {
      const result = await this.pricingService.estimateAll(dto);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':vehicleType')
  @ApiOperation({ summary: 'Get one rate card', description: 'Public.' })
  @ApiParam(VEHICLE_TYPE_PARAM)
  @ApiOkEnvelope(PRICING_RULE_EXAMPLE)
  @ApiValidationError('vehicleType must be one of the following values: CAR, BIKE, TRUCK, TRICYCLE, BICYCLE')
  @ApiNotFound('No pricing rule for TRICYCLE')
  async findOne(@Param() params: VehicleTypeParamDto) {
    try {
      const result = await this.pricingService.findOne(params.vehicleType as VehicleType);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Put(':vehicleType')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Create or replace a rate card',
    description:
      'Admin only. Full replacement — omitted optional fields fall back to their column defaults. Existing orders keep their frozen `pricingSnapshot`, so past trips are unaffected.',
  })
  @ApiParam(VEHICLE_TYPE_PARAM)
  @ApiOkEnvelope(PRICING_RULE_EXAMPLE, { message: 'Pricing saved' })
  @ApiValidationError('baseFare must not be less than 0')
  @ApiAdminErrors()
  async upsert(@Param() params: VehicleTypeParamDto, @Body() dto: UpsertPricingRuleDto) {
    try {
      const result = await this.pricingService.upsert(params.vehicleType as VehicleType, dto);
      return this.response.handle(result, { message: 'Pricing saved' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':vehicleType')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Amend a rate card',
    description: 'Admin only. Partial update — send just the fields you want to change.',
  })
  @ApiParam(VEHICLE_TYPE_PARAM)
  @ApiOkEnvelope({ ...PRICING_RULE_EXAMPLE, surgeMultiplier: 1.5 }, { message: 'Pricing updated' })
  @ApiValidationError('surgeMultiplier must not be greater than 10')
  @ApiAdminErrors()
  @ApiNotFound('No pricing rule for TRICYCLE')
  async update(@Param() params: VehicleTypeParamDto, @Body() dto: UpdatePricingRuleDto) {
    try {
      const result = await this.pricingService.update(params.vehicleType as VehicleType, dto);
      return this.response.handle(result, { message: 'Pricing updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
