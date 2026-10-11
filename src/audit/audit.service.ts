import { Injectable, Logger } from '@nestjs/common';
import { AuditEntity, Prisma } from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto } from './dto/audit.dto';

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
