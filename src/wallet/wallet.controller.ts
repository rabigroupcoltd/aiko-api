import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  DRIVER_EXAMPLE,
  TRANSACTION_PAGE_EXAMPLE,
  WALLET_EXAMPLE,
  WALLET_LIST_EXAMPLE,
} from '../common/swagger/examples';
import { DriversService } from '../drivers/drivers.service';
import { ListTransactionsQueryDto, WithdrawDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

const DRIVER_ID_PARAM = {
  name: 'driverId',
  format: 'uuid',
  example: DRIVER_EXAMPLE.id,
} as const;

/**
 * Every route is authenticated and ownership-checked — wallet balances and
 * withdrawals must never be reachable with only a driverId.
 */
@ApiTags('Wallet')
@ApiBearerAuth('bearer')
@Controller('wallet')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class WalletController {
  constructor(
    private walletService: WalletService,
    private driversService: DriversService,
    private response: ResponsesService,
  ) {}

  @Get('all')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Every driver wallet',
    description: 'Admin only. Sorted by available balance, highest first.',
  })
  @ApiOkEnvelope(WALLET_LIST_EXAMPLE)
  @ApiAdminErrors()
  async getAllWallets() {
    try {
      const result = await this.walletService.getAllWallets();
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('driver/:driverId')
  @ApiOperation({
    summary: 'One driver wallet',
    description:
      'A driver may read their own wallet; an admin may read any. A wallet is created on first read if the driver predates wallets.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(WALLET_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async getWallet(@Param('driverId') driverId: string, @CurrentUser() user: JwtUser) {
    try {
      const allowed = await this.driversService.assertCanManage(driverId, user);
      if (allowed.error) return this.response.handle(allowed);

      return this.response.handle(await this.walletService.getWallet(driverId));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('driver/:driverId/transactions')
  @ApiOperation({
    summary: 'Wallet ledger',
    description:
      'Paginated, newest first. Every balance movement lands here — ride earnings, platform fees, withdrawals, debt payments and manual adjustments.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(TRANSACTION_PAGE_EXAMPLE)
  @ApiValidationError('limit must not be greater than 200')
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async getTransactions(
    @Param('driverId') driverId: string,
    @Query() query: ListTransactionsQueryDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const allowed = await this.driversService.assertCanManage(driverId, user);
      if (allowed.error) return this.response.handle(allowed);

      const result = await this.walletService.getTransactions(
        driverId,
        query.limit,
        query.offset,
      );
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('driver/:driverId/withdraw')
  @ApiOperation({
    summary: 'Request a payout',
    description:
      'Debits the wallet and writes the ledger entry in one transaction, with the balance guard inside the update so two concurrent withdrawals cannot both pass. Outstanding debt must be cleared first, and the amount must be at least MIN_WITHDRAWAL.',
  })
  @ApiParam(DRIVER_ID_PARAM)
  @ApiOkEnvelope(
    { ...WALLET_EXAMPLE, availableBalance: 44500, totalWithdrawals: 140000 },
    { message: 'Withdrawal requested' },
  )
  @ApiValidationError('Insufficient balance')
  @ApiUnauthorized()
  @ApiForbidden('You can only manage your own driver profile')
  @ApiNotFound('Driver not found')
  async withdraw(
    @Param('driverId') driverId: string,
    @Body() dto: WithdrawDto,
    @CurrentUser() user: JwtUser,
  ) {
    try {
      const allowed = await this.driversService.assertCanManage(driverId, user);
      if (allowed.error) return this.response.handle(allowed);

      const result = await this.walletService.withdraw(driverId, dto.amount);
      return this.response.handle(result, { message: 'Withdrawal requested' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
