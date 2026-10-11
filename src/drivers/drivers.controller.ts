import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiConflict,
  ApiCreatedEnvelope,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  DRIVER_ANALYTICS_EXAMPLE,
  DRIVER_DETAIL_EXAMPLE,
  DRIVER_EXAMPLE,
  DRIVER_LIST_EXAMPLE,
  NEARBY_DRIVERS_EXAMPLE,
  VEHICLE_PHOTOS_EXAMPLE,
  WALLET_EXAMPLE,
} from '../common/swagger/examples';
import { MAX_VEHICLE_PHOTOS, imageFilePipe, imageUploadOptions } from '../common/upload';
import { DriverLocationDto, NearbyDriversQueryDto } from '../redis/dto/driver-location.dto';
import { UploadFile } from '../storage/storage.types';
import { DriversService } from './drivers.service';
import {
  BlockDriverDto,
  KycApprovalDto,
  ListDriversQueryDto,
  PayDebtDto,
  RegisterDriverDto,
  UpdateAvailabilityDto,
  UpdateDebtLimitDto,
  UpdateDriverDto,
  UploadVehiclePhotosDto,
} from './dto/driver.dto';

const DRIVER_ID_PARAM = { name: 'id', format: 'uuid', example: DRIVER_EXAMPLE.id } as const;

@ApiTags('Drivers')
@Controller('drivers')
export class DriversController {
  constructor(
    private driversService: DriversService,
    private response: ResponsesService,
  ) {}

  @Post('register')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FilesInterceptor('photos', MAX_VEHICLE_PHOTOS, imageUploadOptions))
  @ApiBearerAuth('bearer')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: RegisterDriverDto })
  @ApiOperation({
    summary: 'Become a driver',
    description:
      'Creates the driver profile for the signed-in user and uploads the vehicle photos in one call. ' +
      'The profile starts with `kycStatus: PENDING` and cannot take trips until an admin approves it.',
  })
  @ApiCreatedEnvelope(
    { ...DRIVER_EXAMPLE, kycStatus: 'PENDING', isAvailable: false, vehiclePhotos: VEHICLE_PHOTOS_EXAMPLE },
    { message: 'Driver profile created' },
  )
  @ApiValidationError('vehiclePlate must be longer than or equal to 3 characters')
  @ApiUnauthorized()
  @ApiConflict('Vehicle plate is already registered')
  async register(
    @CurrentUser('sub') userId: string,
    @Body() dto: RegisterDriverDto,
    @UploadedFiles(imageFilePipe) photos?: UploadFile[],
  ) {
    try {
      const result = await this.driversService.register(userId, dto, photos ?? []);
      return this.response.handleCreated(result, 'Driver profile created');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: "Get the caller's own driver profile",
    description: 'Resolves the profile from the JWT, so no driver id is needed.',
  })
  @ApiOkEnvelope(DRIVER_DETAIL_EXAMPLE)
  @ApiUnauthorized()
  @ApiNotFound('Driver not found')
  async me(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.driversService.findByUserId(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('nearby')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Find drivers near a point',
    description:
      'Live presence from Redis GEOSEARCH, not a database read — only drivers who have sent a heartbeat inside DRIVER_HEARTBEAT_TTL appear. Sorted nearest first.',
  })
  @ApiOkEnvelope(NEARBY_DRIVERS_EXAMPLE)
  @ApiValidationError('lat must be a latitude string or number')
  @ApiUnauthorized()
  async findNearby(@Query() query: NearbyDriversQueryDto) {
    try {
      const result = await this.driversService.findNearby(query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('location')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Push a location heartbeat',
    description:
      'Expected roughly every 10s while online. Writes to Redis immediately and is flushed to Postgres every LOCATION_FLUSH_INTERVAL_MS.',
  })
  @ApiOkEnvelope(
    {
      driverId: DRIVER_EXAMPLE.id,
      lat: 6.5244,
      lng: 3.3792,
      recordedAt: '2026-08-01T07:59:12.310Z',
    },
    { message: 'Location updated' },
  )
  @ApiValidationError('lng must be a longitude string or number')
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async updateLocation(@CurrentUser('sub') userId: string, @Body() dto: DriverLocationDto) {
    try {
      const result = await this.driversService.updateLocation(userId, dto);
      return this.response.handle(result, { message: 'Location updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('state')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Everything the driver app needs on open',
    description:
      'One call to rebuild the whole screen: whether the shift is running, what is being carried, where the driver was last seen, and how much capacity is left. This is the reconnect path — the socket only pushes notifications and holds no state, so after a drop, a cold start, or a return from the background, call this and rebuild from the answer.\n\n`isAvailable` is the shift switch as the driver last set it; `presence.online` is whether Redis still holds a live heartbeat. They disagree when the app was killed mid-shift — the driver is still notionally on duty but has dropped out of the dispatch pool, and the app should resume heartbeats rather than ask them to toggle back on.',
  })
  @ApiOkEnvelope({
    driverId: DRIVER_EXAMPLE.id,
    vehicleType: 'TRICYCLE',
    status: 'AVAILABLE',
    isAvailable: true,
    presence: { online: true, heartbeatTtlSeconds: 90 },
    kycStatus: 'APPROVED',
    isBlocked: false,
    canGoOnline: true,
    held: 1,
    capacity: 3,
    atCapacity: false,
    activeOrders: [
      {
        id: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
        status: 'RESERVED',
        description: 'Two cartons of frozen chicken. Handle upright.',
        pickupLocation: 'Minna Central Market, Minna',
        dropoffLocation: 'Bosso Estate, Minna',
        distanceKm: 8.4,
        driverEarnings: 3150,
        currency: 'NGN',
      },
    ],
    lastLocation: { lat: 9.6139, lng: 6.5569, recordedAt: '2026-08-21T07:59:12.310Z' },
  })
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async getState(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.driversService.getState(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('online')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Start a shift',
    description:
      'Adds the driver to the Redis matching pool and sweeps for work already open nearby — a driver coming online mid-search is offered requests raised before they arrived, which the original fan-out could never have reached them with. Requires an approved, unblocked profile.',
  })
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, isAvailable: true }, { message: 'You are now online' })
  @ApiUnauthorized()
  @ApiForbidden('KYC must be approved before going online')
  async goOnline(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.driversService.goOnline(userId);
      return this.response.handle(result, { message: 'You are now online' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('offline')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'End a shift',
    description:
      'Removes the driver from the matching pool. Orders already held are untouched — going offline stops new work being offered, it does not abandon a delivery in progress.',
  })
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, isAvailable: false }, { message: 'You are now offline' })
  @ApiUnauthorized()
  @ApiForbidden('You do not have a driver profile')
  async goOffline(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.driversService.goOffline(userId);
      return this.response.handle(result, { message: 'You are now offline' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('heartbeat')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Stay in the dispatch pool without moving',
    description:
      'Refreshes the presence TTL. A position fix does this as a side effect, so this is for the driver who is parked, waiting, or indoors with a poor GPS lock and has no new fix worth sending — it costs two keys rather than a whole geo write. Without it they silently drop out of the pool after DRIVER_HEARTBEAT_TTL seconds while the app still says "online".',
  })
  @ApiOkEnvelope(
    { driverId: DRIVER_EXAMPLE.id, online: true, expiresInSeconds: 90 },
    { message: 'Heartbeat received' },
  )
  @ApiUnauthorized()
  @ApiForbidden('Driver is blocked')
  @ApiValidationError('You are offline — go online first')
  async heartbeat(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.driversService.heartbeat(userId);
      return this.response.handle(result, { message: 'Heartbeat received' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List drivers',
    description: 'Public. Filterable by vehicle type, KYC status and availability.',
  })
  @ApiOkEnvelope(DRIVER_LIST_EXAMPLE)
  @ApiValidationError('kycStatus must be one of the following values: PENDING, APPROVED, REJECTED')
  async findAll(@Query() query: ListDriversQueryDto) {
    try {
      const result = await this.driversService.findAll(query);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('applications/incomplete')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Riders who have not submitted their vehicle',
    description:
      'Admin only. Accounts that chose RIDER but never completed `POST /drivers/register`, so they have no driver profile to approve yet. Shown on the KYC queue so the operator can follow up.',
  })
  @ApiAdminErrors()
  async incompleteApplications() {
    try {
      const result = await this.driversService.incompleteApplications();
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one driver', description: 'Public. Includes wallet, photos and last known location.' })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(DRIVER_DETAIL_EXAMPLE)
  @ApiNotFound('Driver not found')
  async findOne(@Param('id') id: string) {
    try {
      const result = await this.driversService.findOne(id);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Update vehicle details',
    description: 'A driver may update their own record; an admin may update any.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, vehicleColor: 'Green' }, { message: 'Driver updated' })
  @ApiValidationError('vehicleYear must not be less than 1950')
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.driversService.update(id, dto, user);
      return this.response.handle(result, { message: 'Driver updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/photos')
  @ApiOperation({ summary: 'List vehicle photos' })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(VEHICLE_PHOTOS_EXAMPLE)
  @ApiNotFound('Driver not found')
  async listPhotos(@Param('id') id: string) {
    try {
      const result = await this.driversService.listPhotos(id);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/photos')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FilesInterceptor('photos', MAX_VEHICLE_PHOTOS, imageUploadOptions))
  @ApiBearerAuth('bearer')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadVehiclePhotosDto })
  @ApiOperation({
    summary: 'Add vehicle photos',
    description: `Up to ${MAX_VEHICLE_PHOTOS} images per call, sent under the \`photos\` field. Returns only the rows created by this call.`,
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiCreatedEnvelope(VEHICLE_PHOTOS_EXAMPLE, { message: 'Photos uploaded' })
  @ApiValidationError('photoTypes must be a comma-separated list of valid photo types')
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async addPhotos(
    @Param('id') id: string,
    @Body() dto: UploadVehiclePhotosDto,
    @CurrentUser() user: JwtUser,
    @UploadedFiles(imageFilePipe) photos?: UploadFile[],
  ) {
    try {
      const result = await this.driversService.addPhotos(id, photos ?? [], dto.photoTypes, user);
      return this.response.handleCreated(result, 'Photos uploaded');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Delete(':id/photos/:photoId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Delete a vehicle photo',
    description: 'Removes the row and the underlying object from the active storage provider.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiParam({ name: 'photoId', format: 'uuid', example: VEHICLE_PHOTOS_EXAMPLE[0].id })
  @ApiOkEnvelope({ deleted: true, id: VEHICLE_PHOTOS_EXAMPLE[0].id }, { message: 'Photo deleted' })
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Photo not found')
  async removePhoto(
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.driversService.removePhoto(id, photoId, user);
      return this.response.handle(result, { message: 'Photo deleted' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/kyc/approve')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Approve KYC',
    description: 'Admin only. The driver can go online once approved.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, kycStatus: 'APPROVED', kycRejectionReason: null }, { message: 'KYC approved' })
  @ApiAdminErrors()
  @ApiNotFound('Driver not found')
  async approveKyc(@Param('id') id: string, @CurrentUser() actor: JwtUser) {
    try {
      const result = await this.driversService.approveKyc(id, actor);
      return this.response.handle(result, { message: 'KYC approved' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/kyc/reject')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Reject KYC',
    description: 'Admin only. The reason is stored on the driver and shown in the app.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(
    {
      ...DRIVER_EXAMPLE,
      kycStatus: 'REJECTED',
      kycRejectionReason: 'Plate number photo is unreadable.',
      isAvailable: false,
    },
    { message: 'KYC rejected' },
  )
  @ApiAdminErrors()
  @ApiNotFound('Driver not found')
  async rejectKyc(
    @Param('id') id: string,
    @Body() dto: KycApprovalDto,
    @CurrentUser() actor: JwtUser,
  ) {
    try {
      const result = await this.driversService.rejectKyc(
        id,
        dto.reason || 'KYC rejected',
        actor,
      );
      return this.response.handle(result, { message: 'KYC rejected' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/availability')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Go online or offline',
    description:
      'Going online adds the driver to the Redis matching pool; going offline removes them. Requires an approved, unblocked profile.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, isAvailable: true }, { message: 'You are now online' })
  @ApiValidationError('isAvailable must be a boolean value')
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async setAvailability(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.driversService.setAvailability(id, dto.isAvailable, user);
      return this.response.handle(result, {
        message: dto.isAvailable ? 'You are now online' : 'You are now offline',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/analytics')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: "A driver's own numbers",
    description:
      'Earnings, trip counts and rates for one driver. Platform-wide figures live under **Analytics**.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(DRIVER_ANALYTICS_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async getAnalytics(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      const allowed = await this.driversService.assertCanManage(id, user);
      if (allowed.error) return this.response.handle(allowed);

      return this.response.handle(await this.driversService.getAnalytics(id));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id/wallet')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Wallet balances', description: 'Same payload as `GET /api/wallet/driver/{driverId}`.' })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(WALLET_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Wallet not found')
  async getWallet(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      const allowed = await this.driversService.assertCanManage(id, user);
      if (allowed.error) return this.response.handle(allowed);

      return this.response.handle(await this.driversService.getWallet(id));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/pay-debt')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Record a debt payment',
    description:
      'Admin only — the admin records commission the driver has paid them. The amount is capped at the current debt. Falling back under the debt limit lets the driver take trips again; a manual block (`isBlocked`) is left alone.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, currentDebt: 0 }, { message: 'Debt payment recorded' })
  @ApiValidationError('No outstanding debt')
  @ApiAdminErrors()
  @ApiNotFound('Driver not found')
  async payDebt(@Param('id') id: string, @Body() dto: PayDebtDto, @CurrentUser() user: JwtUser) {
    try {
      const result = await this.driversService.payDebt(id, dto.amount, user);
      return this.response.handle(result, { message: 'Debt payment recorded' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/debt-limit')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Set the debt ceiling',
    description:
      'Admin only. Gives this driver their own limit; `null` puts them back on the platform-wide `DRIVER_DEBT_LIMIT` setting. Owing this much or more stops the driver taking new trips.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, debtLimit: 15000 }, { message: 'Debt limit updated' })
  @ApiValidationError('debtLimit must not be less than 0')
  @ApiAdminErrors()
  @ApiNotFound('Driver not found')
  async updateDebtLimit(
    @Param('id') id: string,
    @Body() dto: UpdateDebtLimitDto,
    @CurrentUser() actor: JwtUser,
  ) {
    try {
      const result = await this.driversService.updateDebtLimit(id, dto.debtLimit ?? null, actor);
      return this.response.handle(result, { message: 'Debt limit updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id/block')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Block or unblock a driver',
    description: 'Admin only. Blocking forces the driver offline and drops them from the matching pool.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope({ ...DRIVER_EXAMPLE, isBlocked: true, isAvailable: false }, { message: 'Driver blocked' })
  @ApiValidationError('isBlocked must be a boolean value')
  @ApiAdminErrors()
  @ApiNotFound('Driver not found')
  async blockDriver(
    @Param('id') id: string,
    @Body() dto: BlockDriverDto,
    @CurrentUser() actor: JwtUser,
  ) {
    try {
      const result = await this.driversService.blockDriver(id, dto.isBlocked, actor);
      return this.response.handle(result, {
        message: dto.isBlocked ? 'Driver blocked' : 'Driver unblocked',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
