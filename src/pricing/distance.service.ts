import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { haversineKm, round2 } from '../common/geo.util';
import { PlatformSettingsService } from '../settings/platform-settings.service';

export interface Point {
  lat: number;
  lng: number;
}

export interface RoadDistance {
  distanceKm: number;
  source: 'google' | 'estimate';
}

const CACHE_TTL_MS = 10 * 60_000;

@Injectable()
export class DistanceService {
  private readonly logger = new Logger(DistanceService.name);
  private readonly endpoint = 'https://maps.googleapis.com/maps/api/distancematrix/json';

  private readonly cache = new Map<string, { value: RoadDistance; expiresAt: number }>();

  constructor(private settings: PlatformSettingsService) {}

  get isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_MAPS_API_KEY);
  }

  async roadDistanceKm(origin: Point, destination: Point): Promise<RoadDistance> {
    const key = cacheKey(origin, destination);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await this.fetch(origin, destination);
    this.cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  private async fetch(origin: Point, destination: Point): Promise<RoadDistance> {
    if (!this.isConfigured) {
      this.logger.warn('GOOGLE_MAPS_API_KEY is not set — falling back to estimated distance');
      return this.estimate(origin, destination);
    }

    try {
      const { data } = await axios.get(this.endpoint, {
        timeout: 5000,
        params: {
          origins: `${origin.lat},${origin.lng}`,
          destinations: `${destination.lat},${destination.lng}`,
          units: 'metric',
          key: process.env.GOOGLE_MAPS_API_KEY,
          region: process.env.GOOGLE_PLACES_REGION || 'ng',
        },
      });

      const element = data?.rows?.[0]?.elements?.[0];

      if (data.status !== 'OK' || element?.status !== 'OK') {
        this.logger.warn(
          `Distance Matrix returned ${data.status}/${element?.status ?? 'no element'}: ${data.error_message ?? ''}`,
        );
        return this.estimate(origin, destination);
      }

      return { distanceKm: round2(element.distance.value / 1000), source: 'google' };
    } catch (error: any) {
      this.logger.error(`Distance Matrix lookup failed: ${error?.message}`);
      return this.estimate(origin, destination);
    }
  }

  private estimate(origin: Point, destination: Point): RoadDistance {
    const factor = this.settings.getNumber('ROAD_DISTANCE_FACTOR');
    const straightLineKm = haversineKm(origin.lat, origin.lng, destination.lat, destination.lng);

    return {
      distanceKm: round2(straightLineKm * factor),
      source: 'estimate',
    };
  }
}

function cacheKey(origin: Point, destination: Point): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(origin.lat)},${r(origin.lng)}->${r(destination.lat)},${r(destination.lng)}`;
}
