import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrderStatus } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiConflict,
  ApiCreatedEnvelope,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  NEARBY_DRIVERS_EXAMPLE,
  ORDER_ETA_EXAMPLE,
  ORDER_EXAMPLE,
  ORDER_PAGE_EXAMPLE,
  RIDE_MESSAGES_EXAMPLE,
  RIDE_MESSAGE_EXAMPLE,
  RIDE_RATING_EXAMPLE,
} from '../common/swagger/examples';
import { DriversService } from '../drivers/drivers.service';
import { NearbyDriversQueryDto } from '../redis/dto/driver-location.dto';
import {
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  RateOrderDto,
  SendMessageDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';

const ORDER_ID_PARAM = { name: 'id', format: 'uuid', example: ORDER_EXAMPLE.id } as const;

@ApiTags('Orders')
@ApiBearerAuth('bearer')
@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(
    private ordersService: OrdersService,
    private driversService: DriversService,
    private response: ResponsesService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Book a trip',
    description:
      'Creates a PENDING order for the signed-in passenger. The fare is computed server-side from the active pricing rule — a client cannot set its own price — and the quote breakdown is frozen into `pricingSnapshot`.',
  })
  @ApiCreatedEnvelope(
    { ...ORDER_EXAMPLE, driverId: null, driver: null, status: 'PENDING', acceptedAt: null },
    { message: 'Order created' },
  )
  @ApiValidationError('TRICYCLE is not available for booking')
  @ApiUnauthorized()
  async create(@CurrentUser('sub') userId: string, @Body() dto: CreateOrderDto) {
    try {
      const result = await this.ordersService.create(userId, dto);
      return this.response.handleCreated(result, 'Order created');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List trips',
    description:
      'Paginated and newest first. Non-admins only ever see trips they are on, as passenger or driver — the `userId` and `driverId` filters are effectively admin-only.',
  })
  @ApiOkEnvelope(ORDER_PAGE_EXAMPLE)
  @ApiValidationError('limit must not be greater than 100')
  @ApiUnauthorized()
  async findAll(@Query() query: ListOrdersQueryDto, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.ordersService.findAll(query, user);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  /** Kept from the original route table; `GET /api/drivers/nearby` is the newer equivalent. */
  @Get('drivers/nearby')
  @ApiOperation({
    summary: 'Find drivers near a point',
    description:
      'Kept from the original route table. `GET /api/drivers/nearby` is the newer equivalent and returns the same payload.',
    deprecated: true,
  })
  @ApiOkEnvelope(NEARBY_DRIVERS_EXAMPLE)
  @ApiValidationError('lat must be a latitude string or number')
  @ApiUnauthorized()
  async findNearbyDrivers(@Query() query: NearbyDriversQueryDto) {
    try {
      const result = await this.driversService.findNearby(query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one trip', description: 'Only a participant or an admin may read a trip.' })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(ORDER_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async findOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.ordersService.findOne(id, user);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/eta')
  @ApiOperation({
    summary: 'When the driver will reach you',
    description:
      "Computed from the driver's whole planned route, not the straight line from where they are — a driver carrying two other orders reaches this pickup after whatever the route puts in front of it. `driverHandlingOtherOrders` says that they have other work without revealing what it is.",
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(ORDER_ETA_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async eta(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.ordersService.customerEta(id, user);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/accept')
  @ApiOperation({
    summary: 'Claim a pending trip',
    description:
      'Driver-side. The claim is a conditional update, so exactly one driver wins a race — the losers get a 409. Requires an approved, unblocked, available driver profile.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(ORDER_EXAMPLE, { message: 'Order accepted' })
  @ApiValidationError('Driver is not available')
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  @ApiNotFound('Order not found')
  @ApiConflict('Order was already accepted by another driver')
  async accept(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    try {
      const result = await this.ordersService.acceptOrder(id, userId);
      return this.response.handle(result, { message: 'Order accepted' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Move the trip along',
    description:
      'Transitions run PENDING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED, and any open state may go to CANCELLED. Illegal jumps are rejected. COMPLETED settles the fare into the driver wallet and ledger.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(
    { ...ORDER_EXAMPLE, status: 'IN_PROGRESS', startedAt: '2026-08-01T08:01:15.882Z' },
    { message: 'Trip is now IN_PROGRESS' },
  )
  @ApiValidationError('Cannot move an order from PENDING to COMPLETED')
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.ordersService.updateStatus(
        id,
        dto.status as OrderStatus,
        user,
        dto.reason,
      );
      return this.response.handle(result, { message: `Trip is now ${dto.status}` });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel a trip',
    description: 'Shorthand for a status change to CANCELLED. Either participant may cancel while the trip is open.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(
    {
      ...ORDER_EXAMPLE,
      status: 'CANCELLED',
      cancellationReason: 'Passenger no longer needs the trip.',
      cancelledAt: '2026-08-01T07:59:44.201Z',
    },
    { message: 'Trip cancelled' },
  )
  @ApiValidationError('Cannot move an order from COMPLETED to CANCELLED')
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.ordersService.updateStatus(
        id,
        OrderStatus.CANCELLED,
        user,
        dto.reason,
      );
      return this.response.handle(result, { message: 'Trip cancelled' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Read the trip chat', description: 'Oldest first. Participants only.' })
  @ApiParam(ORDER_ID_PARAM)
  @ApiOkEnvelope(RIDE_MESSAGES_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async getMessages(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.ordersService.getMessages(id, user);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Send a chat message',
    description:
      'Also pushed to the other participant over the `/ride` WebSocket. Closed trips reject new messages.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiCreatedEnvelope(RIDE_MESSAGE_EXAMPLE, { message: 'Message sent' })
  @ApiValidationError('This trip is closed')
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.ordersService.sendMessage(id, user, dto);
      return this.response.handleCreated(result, 'Message sent');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/rating')
  @ApiOperation({
    summary: 'Rate the other party',
    description:
      'Only on a COMPLETED trip, and only once per participant. Submitting recomputes the ratee\'s rolling average.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiCreatedEnvelope(RIDE_RATING_EXAMPLE, { message: 'Rating submitted' })
  @ApiValidationError('You can only rate a completed trip')
  @ApiUnauthorized()
  @ApiForbidden('You are not a participant in this trip')
  @ApiNotFound('Order not found')
  @ApiConflict('You already rated this trip')
  async rate(@Param('id') id: string, @Body() dto: RateOrderDto, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.ordersService.rate(id, user, dto);
      return this.response.handleCreated(result, 'Rating submitted');
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
