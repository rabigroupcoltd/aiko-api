import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuditEntity } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ResponsesService } from '../common/responses/responses.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ApiAdminErrors, ApiOkEnvelope } from '../common/swagger/api-envelope.decorator';
import { AUDIT_LOG_EXAMPLE, AUDIT_LOG_PAGE_EXAMPLE } from '../common/swagger/examples';
import { AuditService } from './audit.service';
import { AUDIT_ENTITIES, AuditQueryDto } from './dto/audit.dto';

/**
 * The admin audit trail — read-only, admin only.
 *
 * There is deliberately no write endpoint. Entries are produced by the services
 * that perform the action, so the trail cannot be forged from outside, and no
 * update or delete route exists at all: a log an admin can edit answers no
 * question worth asking.
 */
@ApiTags('Audit')
@ApiBearerAuth('bearer')
@Controller('audit')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
export class AuditController {
  constructor(
    private audit: AuditService,
    private response: ResponsesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Browse the audit trail',
    description:
      'Newest first, paginated. Filterable by entity, by the record touched, by the admin who acted, by a substring of the action verb, and by date range.',
  })
  @ApiOkEnvelope(AUDIT_LOG_PAGE_EXAMPLE)
  @ApiAdminErrors()
  async list(@Query() query: AuditQueryDto) {
    try {
      return this.response.handle(await this.audit.list(query));
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get('actions')
  @ApiOperation({
    summary: 'Action verbs in use',
    description: 'Distinct values of `action`, for the filter dropdown.',
  })
  @ApiOkEnvelope(['driver.kyc.approve', 'order.cancel', 'pricing.update'])
  @ApiAdminErrors()
  async actions() {
    try {
      return this.response.handle(await this.audit.actions());
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':entity/:entityId')
  @ApiOperation({
    summary: 'Everything that happened to one record',
    description:
      'The history behind a single driver, order or wallet — the question an admin actually asks when a record looks wrong. Capped at the 100 most recent entries.',
  })
  @ApiParam({ name: 'entity', enum: AUDIT_ENTITIES, example: 'DRIVER' })
  @ApiParam({ name: 'entityId', format: 'uuid' })
  @ApiOkEnvelope([AUDIT_LOG_EXAMPLE])
  @ApiAdminErrors()
  async forEntity(@Param('entity') entity: AuditEntity, @Param('entityId') entityId: string) {
    try {
      return this.response.handle(await this.audit.forEntity(entity, entityId));
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
