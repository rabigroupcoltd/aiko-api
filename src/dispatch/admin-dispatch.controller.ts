import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import { NO_DRIVER_REVIVE_MINUTES } from './dispatch.constants';
import { AdminDispatchService } from './admin-dispatch.service';
import { AssignOrderDto } from './dto/admin-dispatch.dto';

const ORDER_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  example: '9c7e2a41-3b08-4f6d-95a2-7e1c4d8b0f33',
} as const;

@ApiTags('Admin dispatch')
@ApiBearerAuth('bearer')
@Controller('admin/dispatch')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AdminDispatchController {
  constructor(
    private adminDispatch: AdminDispatchService,
    private response: ResponsesService,
  ) {}

  @Get('unassigned')
  @ApiOperation({
    summary: 'Orders that need a rider',
    description: `Orders still searching, oldest first, plus orders that closed as NO_DRIVER_FOUND in the last ${NO_DRIVER_REVIVE_MINUTES} minutes and can still be revived. \`waitingSeconds\` counts from when the current search began.`,
  })
  @ApiAdminErrors()
  async unassigned() {
    try {
      return this.response.handle(await this.adminDispatch.unassigned());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('orders/:id/riders')
  @ApiOperation({
    summary: 'Riders who could take an order',
    description:
      'Approved riders on the order\'s vehicle type, ones with no warnings first, then nearest to the pickup. `warnings` need confirming to assign; `blockedReason` cannot be overridden.',
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiNotFound('Order not found')
  @ApiAdminErrors()
  async riders(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return this.response.handle(await this.adminDispatch.riders(id));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('orders/:id/assign')
  @ApiOperation({
    summary: 'Give an order to a rider',
    description: `Reserves the order for the rider straight away, through the same lock riders use, so it cannot be double-booked. Works on searching orders and on NO_DRIVER_FOUND orders closed within ${NO_DRIVER_REVIVE_MINUTES} minutes (revived). The customer gets the usual "driver found" updates and the rider is told it was assigned to them; they can hand it back for a few minutes.`,
  })
  @ApiParam(ORDER_ID_PARAM)
  @ApiValidationError('Confirm to assign anyway: Off shift')
  @ApiNotFound('Order not found')
  @ApiConflict('ORDER_ALREADY_RESERVED')
  @ApiAdminErrors()
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignOrderDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const result = await this.adminDispatch.assign(id, dto.driverId, user, dto.confirmWarnings);
      return this.response.handle(result, { message: 'Order assigned' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
