import { Injectable, Logger } from '@nestjs/common';
import { AuditEntity, Prisma } from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto } from './dto/audit.dto';

/** Everything needed to write one trail entry. */
export interface AuditInput {
  actor?: JwtUser | null;
  actorName?: string | null;
  action: string;
  entity: AuditEntity;
  entityId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The admin audit trail.
 *
 * Append-only. Nothing in this service updates or deletes, and there is no
 * endpoint that does either — a log an admin can edit answers no question worth
 * asking.
 *
 * `record` never throws. An audit write failing must not roll back the action it
 * was describing: refusing to approve a driver's KYC because the log was
 * unreachable turns a bookkeeping problem into an operational one. The failure
 * is logged loudly instead, which is the honest trade — a gap in the trail that
 * is visible beats a blocked admin.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actor?.sub ?? null,
          // Denormalised so the trail still reads correctly after the account is
          // renamed or removed. What was true at the time is the point.
          actorName: input.actorName ?? null,
          actorRole: input.actor?.roles?.[0] ?? null,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId ?? null,
          summary: input.summary,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(`Audit write failed for ${input.action}: ${e?.message}`);
    }
  }

  /**
   * The log, newest first.
   *
   * Paginated rather than streamed: this is read by a person scanning for one
   * thing, and the filters below are how they narrow it. An unfiltered read of
   * the whole table is never the useful query.
   */
  async list(query: AuditQueryDto): Promise<ServiceResult> {
    try {
      const page = query.page ?? 1;
      const limit = Math.min(query.limit ?? 25, 100);

      const where: Prisma.AuditLogWhereInput = {
        ...(query.entity ? { entity: query.entity } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        this.prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.auditLog.count({ where }),
      ]);

      return ok({
        data: rows,
        meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Everything that ever happened to one record.
   *
   * The question an admin actually asks — "why does this driver look like
   * this" — is about a row, not about a time range.
   */
  async forEntity(entity: AuditEntity, entityId: string): Promise<ServiceResult> {
    try {
      return ok(
        await this.prisma.auditLog.findMany({
          where: { entity, entityId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /** Distinct action verbs present in the log, for the filter dropdown. */
  async actions(): Promise<ServiceResult> {
    try {
      const rows = await this.prisma.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      });

      return ok(rows.map((row) => row.action));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
