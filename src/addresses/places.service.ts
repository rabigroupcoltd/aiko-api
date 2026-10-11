import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface RemotePlace {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private readonly endpoint = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

  get isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_MAPS_API_KEY);
  }

  async search(
    query: string,
    bias?: { lat?: number; lng?: number; radiusMeters?: number },
  ): Promise<RemotePlace[]> {
    if (!this.isConfigured) {
      this.logger.warn('GOOGLE_MAPS_API_KEY is not set — remote place lookup disabled');
      return [];
    }

    try {
      const { data } = await axios.get(this.endpoint, {
        timeout: 5000,
        params: {
          query,
          key: process.env.GOOGLE_MAPS_API_KEY,
          region: process.env.GOOGLE_PLACES_REGION || 'ng',
          ...(bias?.lat != null && bias?.lng != null
            ? { location: `${bias.lat},${bias.lng}`, radius: bias.radiusMeters ?? 50_000 }
            : {}),
        },
      });

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        this.logger.warn(`Places API returned ${data.status}: ${data.error_message ?? ''}`);
        return [];
      }

      return (data.results || []).map((result: any) => ({
        placeId: result.place_id,
        name: result.name,
        address: result.formatted_address,
        latitude: result.geometry?.location?.lat,
        longitude: result.geometry?.location?.lng,
      }));
    } catch (error: any) {
      this.logger.error(`Places lookup failed: ${error?.message}`);
      return [];
    }
  }
}
