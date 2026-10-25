import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { AccountService } from './account.service';
import {
  DeletionRequestDto,
  ListDeletionRequestsDto,
  ProcessDeletionDto,
  RejectDeletionDto,
} from './dto/account.dto';

@ApiTags('Account')
@Controller('account')
export class AccountController {
  constructor(
    private account: AccountService,
    private response: ResponsesService,
  ) {}

  @Delete()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Delete my account',
    description:
      'Erases the signed-in user’s personal data straight away: profile, contact details, photos and documents, saved addresses, device tokens and sign-in link. Trip and payment records are kept, anonymised. Refused while an order is still in progress.',
  })
  async deleteMine(@CurrentUser() user: JwtUser) {
    try {
      return this.response.handle(await this.account.deleteOwnAccount(user), {
        message: 'Your account has been deleted',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('deletion-requests')
  @ApiOperation({
    summary: 'Ask for an account to be deleted (no sign-in)',
    description:
      'Public — backs the /delete-account page. Always answers the same way, so it never reveals whether an account exists. An admin processes the request.',
  })
  async request(@Body() dto: DeletionRequestDto) {
    try {
      return this.response.handle(await this.account.requestDeletion(dto.contact, dto.reason), {
        message: 'Request received',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('deletion-requests')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Deletion requests (admin)' })
  async list(@Query() query: ListDeletionRequestsDto) {
    try {
      return this.response.handle(await this.account.listRequests(query.status));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('deletion-requests/:id/process')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Delete the account a request is for (admin)' })
  async process(@Param('id') id: string, @Body() dto: ProcessDeletionDto, @CurrentUser() actor: JwtUser) {
    try {
      return this.response.handle(await this.account.processRequest(id, actor, dto.userId), {
        message: 'Account deleted',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post('deletion-requests/:id/reject')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Reject a deletion request (admin)' })
  async reject(@Param('id') id: string, @Body() dto: RejectDeletionDto, @CurrentUser() actor: JwtUser) {
    try {
      return this.response.handle(await this.account.rejectRequest(id, dto.note, actor), {
        message: 'Request rejected',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
