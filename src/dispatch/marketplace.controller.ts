import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiConflict,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  MARKETPLACE_ACTIVE_EXAMPLE,
  MARKETPLACE_GRID_EXAMPLE,
  MARKETPLACE_RESERVED_EXAMPLE,
} from '../common/swagger/examples';
import { MARKETPLACE_CONFIG } from './dispatch.constants';
import { MarketplaceQueryDto } from './dto/marketplace.dto';
import { MarketplaceService } from './marketplace.service';

const ORDER_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
} as const;

@ApiTags('Marketplace')
@ApiBearerAuth('bearer')
@Controller('marketplace')
@UseGuards(AuthGuard('jwt'))
export class MarketplaceController {
  constructor(
    private marketplace: MarketplaceService,
    private response: ResponsesService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary: 'Dispatch limits',
    description:
      'Capacity, radius and detour limits as the server enforces them. The client renders "2 / 3 orders" from this rather than carrying its own copy of a number it does not own.',
  })
  @ApiOkEnvelope(MARKETPLACE_CONFIG)
  @ApiUnauthorized()
  config() {
    return this.response.success(MARKETPLACE_CONFIG);
  }

  @Get('orders')
  @ApiOperation({
    summary: 'Available orders',
    description:
      'Unclaimed orders near the driver, best route match first. Compatible orders always rank above incompatible ones; within each group the composite route score decides. Nothing identifying the customer is returned — that arrives with the reservation.',
  })
  @ApiOkEnvelope(MARKETPLACE_GRID_EXAMPLE)
  @ApiValidationError('Go online to see available orders')
  @ApiUnauthorized()
  @ApiForbidden('Your KYC is not approved yet')
  async available(@CurrentUser('sub') userId: string, @Query() query: MarketplaceQueryDto) {
    try {
      const result = await this.marketplace.available(userId, query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('orders/:id/reserve')
  @ApiOperation({
    summary: 'Reserve an order',
    description:
      'Claims the order for this driver. Atomic: concurrent attempts on the same order resolve to exactly one winner, and every loser gets 409 ORDER_ALREADY_RESERVED. Capacity and route compatibility are re-checked server-side, so a stale grid cannot get a driver past either limit.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(MARKETPLACE_RESERVED_EXAMPLE, { message: 'Order reserved' })
  @ApiValidationError('MAX_ORDER_CAPACITY_REACHED')
  @ApiUnauthorized()
  @ApiForbidden('Your KYC is not approved yet')
  @ApiNotFound('Order not found')
  @ApiConflict('ORDER_ALREADY_RESERVED')
  async reserve(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    try {
      const result = await this.marketplace.reserve(id, userId);
      return this.response.handle(result, { message: 'Order reserved' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('orders/:id/skip')
  @ApiOperation({
    summary: 'Skip an order',
    description:
      'Removes the order from this driver\'s grid only. The order stays open and every other driver still sees it. Controlled by SKIP_COOLDOWN_MINUTES — 0, the default, means it never comes back to this driver.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope({ orderId: ORDER_ID_PARAM.example, skipped: true, hiddenUntil: null })
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  @ApiNotFound('Order not found')
  async skip(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    try {
      const result = await this.marketplace.skip(id, userId);
      return this.response.handle(result, { message: 'Order skipped' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('active')
  @ApiOperation({
    summary: 'Active orders and route',
    description:
      'Every order the driver is holding, each with its own status and customer, plus the optimised route across all of them. Pickups and drop-offs interleave when that is shorter — the route groups the orders operationally without merging them.',
  })
  @ApiOkEnvelope(MARKETPLACE_ACTIVE_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async active(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.marketplace.activeOrders(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('skipped')
  @ApiOperation({
    summary: 'Skipped orders',
    description: 'This driver\'s skip history, newest first.',
  })
  @ApiOkEnvelope([])
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async skipped(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.marketplace.skipped(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
