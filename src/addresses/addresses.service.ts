import { Injectable } from '@nestjs/common';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, forbidden, notFound, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddressSearchResult,
  CreateAddressDto,
  SearchAddressDto,
  UpdateAddressDto,
} from './dto/address.dto';
import { PlacesService, RemotePlace } from './places.service';

@Injectable()
export class AddressesService {
  constructor(
    private prisma: PrismaService,
    private places: PlacesService,
    private response: ResponsesService,
  ) {}

  /**
   * Cache-through search: the caller's saved addresses first, then the shared
   * place cache, and only on a miss the Places API — whose results are written
   * back so the next lookup is local.
   */
  async search(userId: string, dto: SearchAddressDto): Promise<ServiceResult> {
    try {
      const limit = dto.limit ?? 10;
      const contains = { contains: dto.q, mode: 'insensitive' as const };

      const [saved, cached] = await Promise.all([
        this.prisma.address.findMany({
          where: { userId, OR: [{ address: contains }, { name: contains }] },
          take: limit,
          orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        }),
        this.prisma.placeCache.findMany({
          // `searchText` carries the local aliases, which is what makes
          // "kasuwa" find Minna Central Market — name and address alone never
          // would.
          where: {
            OR: [{ address: contains }, { name: contains }, { searchText: contains }],
          },
          take: limit,
          orderBy: { searchCount: 'desc' },
        }),
      ]);

      const results: AddressSearchResult[] = saved.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        placeId: row.placeId,
        category: null,
        source: 'SAVED',
        isDefault: row.isDefault,
      }));

      const seen = new Set(results.map((row) => row.address.toLowerCase()));

      for (const row of cached) {
        if (seen.has(row.address.toLowerCase())) continue;
        seen.add(row.address.toLowerCase());
        results.push({
          id: null,
          name: row.name,
          address: row.address,
          latitude: row.latitude,
          longitude: row.longitude,
          placeId: row.placeId,
          category: row.category,
          source: 'CACHED',
          isDefault: false,
        });
      }

      if (results.length > 0) {
        await this.bumpSearchCount(cached.map((row) => row.id));
        return ok({ results: results.slice(0, limit), source: 'cache' });
      }

      const remote = await this.places.search(dto.q, { lat: dto.lat, lng: dto.lng });
      if (remote.length === 0) return ok({ results: [], source: 'remote' });

      await this.cacheRemote(remote);

      return ok({
        results: remote.slice(0, limit).map((place) => ({
          id: null,
          name: place.name,
          address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          placeId: place.placeId,
          category: null,
          source: 'REMOTE' as const,
          isDefault: false,
        })),
        source: 'remote',
      });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private async bumpSearchCount(ids: string[]) {
    if (ids.length === 0) return;
    await this.prisma.placeCache.updateMany({
      where: { id: { in: ids } },
      data: { searchCount: { increment: 1 } },
    });
  }

  private async cacheRemote(places: RemotePlace[]) {
    const usable = places.filter((place) => place.latitude != null && place.longitude != null);

    await Promise.all(
      usable.map((place) =>
        this.prisma.placeCache
          .upsert({
            where: { address: place.address },
            create: {
              placeId: place.placeId,
              name: place.name,
              address: place.address,
              latitude: place.latitude,
              longitude: place.longitude,
              // Google gives no aliases, so this is only name plus address —
              // still worth setting, so every row is matchable the same way.
              searchText: `${place.name} | ${place.address}`.toLowerCase(),
            },
            update: { searchCount: { increment: 1 } },
          })
          // A concurrent identical lookup can lose the placeId unique race.
          .catch(() => undefined),
      ),
    );
  }

  async create(userId: string, dto: CreateAddressDto): Promise<ServiceResult> {
    try {
      if (dto.isDefault) await this.clearDefault(userId);

      const address = await this.prisma.address.upsert({
        where: { address_userId: { address: dto.address, userId } },
        create: {
          userId,
          name: dto.name,
          address: dto.address,
          latitude: dto.latitude,
          longitude: dto.longitude,
          placeId: dto.placeId,
          source: dto.placeId ? 'REMOTE' : 'CACHED',
          isDefault: dto.isDefault ?? false,
        },
        update: {
          name: dto.name,
          latitude: dto.latitude,
          longitude: dto.longitude,
          placeId: dto.placeId,
          isDefault: dto.isDefault ?? undefined,
        },
      });

      return ok(address);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findAll(userId: string): Promise<ServiceResult> {
    try {
      const addresses = await this.prisma.address.findMany({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      });
      return ok(addresses);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async findOne(id: string, userId: string): Promise<ServiceResult> {
    try {
      const address = await this.prisma.address.findUnique({ where: { id } });
      if (!address) return notFound('Address not found');
      if (address.userId !== userId) return forbidden('Not your address');
      return ok(address);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async update(id: string, userId: string, dto: UpdateAddressDto): Promise<ServiceResult> {
    try {
      const owned = await this.findOne(id, userId);
      if (owned.error) return owned;

      if (dto.isDefault) await this.clearDefault(userId);

      const address = await this.prisma.address.update({ where: { id }, data: dto });
      return ok(address);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async remove(id: string, userId: string): Promise<ServiceResult> {
    try {
      const owned = await this.findOne(id, userId);
      if (owned.error) return owned;

      await this.prisma.address.delete({ where: { id } });
      return ok({ deleted: true, id });
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  private clearDefault(userId: string) {
    return this.prisma.address.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
  }
}
