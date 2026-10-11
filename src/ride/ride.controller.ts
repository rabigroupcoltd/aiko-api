import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
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
  NEARBY_RIDE_REQUESTS_EXAMPLE,
  ORDER_EXAMPLE,
  RIDE_BID_EXAMPLE,
  RIDE_REQUEST_CREATED_EXAMPLE,
  RIDE_REQUEST_EXAMPLE,
  RIDE_REQUEST_WITH_BIDS_EXAMPLE,
} from '../common/swagger/examples';
import {
  AcceptDriverDto,
  CancelRideRequestDto,
  CreateRideRequestDto,
  NearbyRequestsQueryDto,
  PlaceBidDto,
} from './dto/ride.dto';
import { RideService } from './ride.service';

const REQUEST_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  example: RIDE_REQUEST_EXAMPLE.id,
} as const;

@ApiTags('Ride Requests')
@ApiBearerAuth('bearer')
@Controller('ride-requests')
@UseGuards(AuthGuard('jwt'))
export class RideController {
  constructor(
    private rideService: RideService,
    private response: ResponsesService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Ask for a driver',
    description:
      'Quotes the route, finds drivers within `radiusKm`, and pings them. The request expires after RIDE_REQUEST_TTL seconds and is retried MATCHING_RETRIES times before giving up. One open request per passenger.',
  })
  @ApiCreatedEnvelope(RIDE_REQUEST_CREATED_EXAMPLE, { message: 'Looking for a driver' })
  @ApiValidationError('radiusKm must not be less than 0.5')
  @ApiUnauthorized()
  @ApiConflict('You already have an open ride request')
  async create(@CurrentUser('sub') userId: string, @Body() dto: CreateRideRequestDto) {
    try {
      const result = await this.rideService.createRequest(userId, dto);
      return this.response.handleCreated(result, 'Looking for a driver');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'My ride requests',
    description: 'Requests the caller raised as a passenger, newest first.',
  })
  @ApiOkEnvelope([RIDE_REQUEST_WITH_BIDS_EXAMPLE])
  @ApiUnauthorized()
  async findMine(@CurrentUser() user: JwtUser) {
    try {
      const result = await this.rideService.findMine(user);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('inbox')
  @ApiOperation({
    summary: "A driver's inbox",
    description:
      'Open requests the calling driver was matched into and has not yet bid on or lost. Requires a driver profile.',
  })
  @ApiOkEnvelope([RIDE_REQUEST_WITH_BIDS_EXAMPLE])
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async inbox(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.rideService.findForDriver(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('nearby')
  @ApiOperation({
    summary: 'Open requests near a driver',
    description:
      'Everything still open within `radiusKm` of the given position, for the calling driver’s ' +
      'vehicle type, nearest pickup first. Unlike **inbox** this does not require having been ' +
      'matched — it is what a driver who came online mid-search uses to find work that was ' +
      'already in flight.\n\n' +
      'Each result carries `pickupDistanceKm`, `secondsRemaining` and `hasBid`. Requests ' +
      'returned here are subscribed to the caller, so they will also receive the cancellation ' +
      'and expiry broadcasts for them. Bid on one with `POST /api/ride-requests/{id}/bids` as ' +
      'normal.',
  })
  @ApiOkEnvelope(NEARBY_RIDE_REQUESTS_EXAMPLE)
  @ApiValidationError('lat must be a latitude string or number')
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async nearby(@CurrentUser('sub') userId: string, @Query() query: NearbyRequestsQueryDto) {
    try {
      const result = await this.rideService.findNearbyOpen(userId, query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one ride request', description: 'Includes the bids placed so far.' })
  @ApiParam(REQUEST_ID_PARAM)
  @ApiOkEnvelope(RIDE_REQUEST_WITH_BIDS_EXAMPLE)
  @ApiUnauthorized()
  @ApiNotFound('Ride request not found')
  async findOne(@Param('id') id: string) {
    try {
      const result = await this.rideService.findOne(id);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/bids')
  @ApiBody({ type: PlaceBidDto, description: '`requestId` is taken from the path — omit it here.' })
  @ApiOperation({
    summary: 'Bid on a request',
    description:
      'Driver-side. One bid per driver per request; bidding again replaces the previous one. `amount` only becomes the trip fare when ALLOW_BID_FARE_OVERRIDE=true, and even then it must sit within ±50% of the server quote.',
  })
  @ApiParam(REQUEST_ID_PARAM)
  @ApiCreatedEnvelope(RIDE_BID_EXAMPLE, { message: 'Bid placed' })
  @ApiValidationError('Bid must be between 625 and 1875')
  @ApiUnauthorized()
  @ApiForbidden('KYC not approved')
  @ApiNotFound('Ride request not found')
  async placeBid(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: Omit<PlaceBidDto, 'requestId'>,
  ) {
    try {
      const result = await this.rideService.placeBid(userId, { ...dto, requestId: id });
      return this.response.handleCreated(result, 'Bid placed');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/accept')
  @ApiBody({ type: AcceptDriverDto, description: '`requestId` is taken from the path — send only `driverId`.' })
  @ApiOperation({
    summary: 'Accept a driver',
    description:
      'Passenger-side. Turns the winning bid into a trip and returns the created **Order**, already in ACCEPTED. The claim is conditional, so a request that was cancelled or expired mid-flight returns a 409.',
  })
  @ApiParam(REQUEST_ID_PARAM)
  @ApiCreatedEnvelope(ORDER_EXAMPLE, { message: 'Driver accepted' })
  @ApiValidationError('Bid is no longer open')
  @ApiUnauthorized()
  @ApiForbidden('Not your ride request')
  @ApiNotFound('That driver has not bid on this request')
  @ApiConflict('Request is no longer open')
  async acceptDriver(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: Omit<AcceptDriverDto, 'requestId'>,
  ) {
    try {
      const result = await this.rideService.acceptDriver(userId, { ...dto, requestId: id });
      return this.response.handleCreated(result, 'Driver accepted');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/cancel')
  @ApiBody({ type: CancelRideRequestDto, description: '`requestId` is taken from the path — omit it here.' })
  @ApiOperation({
    summary: 'Call off the search',
    description:
      'Passenger-side. Once a request has become a trip it can no longer be cancelled here — cancel the order instead.',
  })
  @ApiParam(REQUEST_ID_PARAM)
  @ApiOkEnvelope(
    { ...RIDE_REQUEST_EXAMPLE, status: 'CANCELLED', matchedDriverIds: [] },
    { message: 'Request cancelled' },
  )
  @ApiValidationError('Request already turned into a trip — cancel the trip instead')
  @ApiUnauthorized()
  @ApiForbidden('Not your ride request')
  @ApiNotFound('Ride request not found')
  async cancel(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: Omit<CancelRideRequestDto, 'requestId'>,
  ) {
    try {
      const result = await this.rideService.cancelRequest(userId, { ...dto, requestId: id });
      return this.response.handle(result, { message: 'Request cancelled' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
