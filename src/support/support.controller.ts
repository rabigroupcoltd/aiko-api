import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import {
  ApiAdminErrors,
  ApiCreatedEnvelope,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  SUPPORT_MESSAGE_EXAMPLE,
  SUPPORT_TICKET_DETAIL_EXAMPLE,
  SUPPORT_TICKET_EXAMPLE,
  SUPPORT_TICKET_PAGE_EXAMPLE,
} from '../common/swagger/examples';
import {
  CreateTicketDto,
  ReplyTicketDto,
  SupportQueryDto,
  UpdateTicketDto,
} from './dto/support.dto';
import { SupportService } from './support.service';

const TICKET_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  example: SUPPORT_TICKET_EXAMPLE.id,
} as const;

/**
 * Support tickets.
 *
 * Customers and drivers raise and follow their own; admins work the queue. The
 * split is per route rather than per controller — `GET /support/:id` serves
 * both, scoped by who is asking, so there is one place where that scoping is
 * decided rather than two that can drift.
 */
@ApiTags('Support')
@ApiBearerAuth('bearer')
@Controller('support')
@UseGuards(AuthGuard('jwt'))
export class SupportController {
  constructor(
    private support: SupportService,
    private response: ResponsesService,
  ) {}

  // ------------------------------------------------------------- requester

  @Post()
  @ApiOperation({
    summary: 'Raise a ticket',
    description:
      'Anyone signed in. Attach `orderId` when it is about a specific delivery — the caller must have been party to that order, or it is refused.',
  })
  @ApiCreatedEnvelope(SUPPORT_TICKET_EXAMPLE, { message: 'Ticket raised' })
  @ApiValidationError('subject must be longer than or equal to 4 characters')
  @ApiUnauthorized()
  @ApiForbidden('That order is not yours')
  async create(@CurrentUser('sub') userId: string, @Body() dto: CreateTicketDto) {
    try {
      return this.response.handle(await this.support.create(userId, dto), {
        message: 'Ticket raised',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('mine')
  @ApiOperation({
    summary: 'Your own tickets',
    description: 'Most recently active first.',
  })
  @ApiOkEnvelope([SUPPORT_TICKET_EXAMPLE])
  @ApiUnauthorized()
  async mine(@CurrentUser('sub') userId: string) {
    try {
      return this.response.handle(await this.support.mine(userId));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  // ------------------------------------------------------------------ admin

  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'The support queue',
    description:
      'Urgent first, then most recently active. Returns `counts` per status alongside the page so the tabs above the table need no second request.',
  })
  @ApiOkEnvelope(SUPPORT_TICKET_PAGE_EXAMPLE)
  @ApiAdminErrors()
  async list(@Query() query: SupportQueryDto) {
    try {
      return this.response.handle(await this.support.list(query));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  // ------------------------------------------------------------------- both

  @Get(':id')
  @ApiOperation({
    summary: 'One ticket and its thread',
    description:
      'Admins see everything; a requester sees their own ticket with internal notes stripped. The filtering happens in the query, not after it.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiOkEnvelope(SUPPORT_TICKET_DETAIL_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('That ticket is not yours')
  @ApiNotFound('Ticket not found')
  async detail(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    try {
      return this.response.handle(await this.support.detail(id, user));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post(':id/reply')
  @ApiOperation({
    summary: 'Post a message',
    description:
      'Either party. A customer replying to a resolved ticket reopens it; an admin replying to an open one moves it to PENDING. `internal: true` is a staff-only note and is refused for anyone else.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiCreatedEnvelope(SUPPORT_MESSAGE_EXAMPLE, { message: 'Message sent' })
  @ApiValidationError('body should not be empty')
  @ApiUnauthorized()
  @ApiForbidden('Only staff can leave internal notes')
  @ApiNotFound('Ticket not found')
  async reply(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Body() dto: ReplyTicketDto,
  ) {
    try {
      return this.response.handle(await this.support.reply(id, user, dto), {
        message: 'Message sent',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Assign, reprioritise or close',
    description:
      'Admin only. Send `assigneeId: null` to put a ticket back in the unassigned pile. Every change is written to the audit trail.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiOkEnvelope({ ...SUPPORT_TICKET_EXAMPLE, status: 'RESOLVED' }, { message: 'Ticket updated' })
  @ApiAdminErrors()
  @ApiNotFound('Ticket not found')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateTicketDto,
  ) {
    try {
      return this.response.handle(await this.support.update(id, user, dto), {
        message: 'Ticket updated',
      });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
