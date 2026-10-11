import { Injectable } from '@nestjs/common';
import { AuditEntity, Prisma, SupportStatus } from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';
import { CONTACT_USER_SELECT, PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, forbidden, notFound, ok } from '../common/responses/response.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateTicketDto,
  ReplyTicketDto,
  SupportQueryDto,
  UpdateTicketDto,
} from './dto/support.dto';

const TICKET_INCLUDE = {
  requester: { select: CONTACT_USER_SELECT },
  assignee: { select: PUBLIC_USER_SELECT },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketInclude;

@Injectable()
export class SupportService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private response: ResponsesService,
  ) {}

  async create(userId: string, dto: CreateTicketDto): Promise<ServiceResult> {
    try {
      if (dto.orderId) {
        const order = await this.prisma.order.findUnique({
          where: { id: dto.orderId },
          select: { userId: true, driverId: true, driver: { select: { userId: true } } },
        });

        if (!order) return notFound('Order not found');

        const involved = order.userId === userId || order.driver?.userId === userId;
        if (!involved) return forbidden('That order is not yours');
      }

      const ticket = await this.prisma.supportTicket.create({
        data: {
          reference: await this.nextReference(),
          requesterId: userId,
          orderId: dto.orderId,
          subject: dto.subject,
          category: dto.category,
          priority: dto.priority,
          messages: { create: { senderId: userId, body: dto.body, fromStaff: false } },
        },
        include: TICKET_INCLUDE,
      });

      return ok(ticket);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async nextReference(): Promise<string> {
    const count = await this.prisma.supportTicket.count();
    const candidate = `AIK-${1000 + count + 1}`;

    const taken = await this.prisma.supportTicket.findUnique({
      where: { reference: candidate },
      select: { id: true },
    });

    return taken ? `AIK-${1000 + count + 1}-${Date.now().toString(36).slice(-3)}` : candidate;
  }

  async mine(userId: string): Promise<ServiceResult> {
    try {
      return ok(
        await this.prisma.supportTicket.findMany({
          where: { requesterId: userId },
          include: TICKET_INCLUDE,
          orderBy: { lastMessageAt: 'desc' },
        }),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async list(query: SupportQueryDto): Promise<ServiceResult> {
    try {
      const page = query.page ?? 1;
      const limit = Math.min(query.limit ?? 25, 100);

      const where: Prisma.SupportTicketWhereInput = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
        ...(query.unassigned ? { assigneeId: null } : {}),
        ...(query.q
          ? {
              OR: [
                { subject: { contains: query.q, mode: 'insensitive' } },
                { reference: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [rows, total, grouped] = await Promise.all([
        this.prisma.supportTicket.findMany({
          where,
          include: TICKET_INCLUDE,
          orderBy: [{ priority: 'desc' }, { lastMessageAt: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.supportTicket.count({ where }),
        this.prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);

      const counts = Object.fromEntries(
        Object.values(SupportStatus).map((status) => [
          status,
          grouped.find((row) => row.status === status)?._count._all ?? 0,
        ]),
      );

      return ok({
        data: rows,
        meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
        counts,
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async detail(id: string, user: JwtUser): Promise<ServiceResult> {
    try {
      const isStaff = Boolean(user.roles?.some((role) => role === 'ADMIN' || role === 'SUPPORT'));

      const ticket = await this.prisma.supportTicket.findUnique({
        where: { id },
        include: {
          ...TICKET_INCLUDE,
          order: {
            select: {
              id: true,
              status: true,
              description: true,
              pickupLocation: true,
              dropoffLocation: true,
              fare: true,
              currency: true,
              createdAt: true,
            },
          },
          messages: {
            where: isStaff ? {} : { internal: false },
            include: { sender: { select: PUBLIC_USER_SELECT } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!ticket) return notFound('Ticket not found');
      if (!isStaff && ticket.requesterId !== user.sub) return forbidden('That ticket is not yours');

      return ok(ticket);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async reply(id: string, user: JwtUser, dto: ReplyTicketDto): Promise<ServiceResult> {
    try {
      const isStaff = Boolean(user.roles?.some((role) => role === 'ADMIN' || role === 'SUPPORT'));

      const ticket = await this.prisma.supportTicket.findUnique({
        where: { id },
        select: { id: true, requesterId: true, status: true },
      });

      if (!ticket) return notFound('Ticket not found');
      if (!isStaff && ticket.requesterId !== user.sub) return forbidden('That ticket is not yours');
      if (dto.internal && !isStaff) return forbidden('Only staff can leave internal notes');

      const [message] = await this.prisma.$transaction([
        this.prisma.supportMessage.create({
          data: {
            ticketId: id,
            senderId: user.sub,
            fromStaff: isStaff,
            internal: Boolean(dto.internal),
            body: dto.body,
          },
          include: { sender: { select: PUBLIC_USER_SELECT } },
        }),
        this.prisma.supportTicket.update({
          where: { id },
          data: {
            lastMessageAt: new Date(),
            ...(!isStaff && !dto.internal && ticket.status === SupportStatus.RESOLVED
              ? { status: SupportStatus.OPEN, resolvedAt: null }
              : {}),
            ...(isStaff && !dto.internal && ticket.status === SupportStatus.OPEN
              ? { status: SupportStatus.PENDING }
              : {}),
          },
        }),
      ]);

      return ok(message);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(id: string, user: JwtUser, dto: UpdateTicketDto): Promise<ServiceResult> {
    try {
      const existing = await this.prisma.supportTicket.findUnique({
        where: { id },
        select: { id: true, reference: true, status: true, priority: true, assigneeId: true },
      });
      if (!existing) return notFound('Ticket not found');

      const ticket = await this.prisma.supportTicket.update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.priority ? { priority: dto.priority } : {}),
          ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
          ...(dto.status === SupportStatus.RESOLVED ? { resolvedAt: new Date() } : {}),
          ...(dto.status === SupportStatus.CLOSED ? { closedAt: new Date() } : {}),
        },
        include: TICKET_INCLUDE,
      });

      await this.audit.record({
        actor: user,
        action: 'support.ticket.update',
        entity: AuditEntity.SUPPORT,
        entityId: id,
        summary: `Updated ticket ${existing.reference}`,
        metadata: {
          before: existing,
          after: { status: ticket.status, priority: ticket.priority, assigneeId: ticket.assigneeId },
        },
      });

      return ok(ticket);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
