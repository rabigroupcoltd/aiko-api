import { Injectable } from '@nestjs/common';
import { PUBLIC_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, forbidden, notFound, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async findAll(): Promise<ServiceResult> {
    try {
      const users = await this.prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
      });
      return ok(users);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string): Promise<ServiceResult> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id },
        // Explicit select — an `include` would ship the password hash to the client.
        select: { ...PUBLIC_USER_SELECT, driver: { include: { vehiclePhotos: true } } },
      });

      if (!user) return notFound('User not found');
      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(
    id: string,
    data: { name?: string; phone?: string },
    currentUserId: string,
  ): Promise<ServiceResult> {
    try {
      if (id !== currentUserId) {
        const currentUser = await this.prisma.user.findUnique({ where: { id: currentUserId } });
        if (!currentUser?.roles.includes('ADMIN')) {
          return forbidden('You can only update your own profile');
        }
      }

      const user = await this.prisma.user.update({
        where: { id },
        data,
        select: PUBLIC_USER_SELECT,
      });

      return ok(user);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
