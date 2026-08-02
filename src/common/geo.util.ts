const EARTH_RADIUS_KM = 6371;

/**
 * Straight-line distance. Multiply by ROAD_DISTANCE_FACTOR for a road estimate,
 * or replace with a Directions API call when accuracy matters.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const KM_PER_DEGREE_LAT = 110.574;

/**
 * The lat/lng window a radius fits inside.
 *
 * For pre-filtering a table scan down to something a haversine pass can afford
 * to check exactly. Deliberately generous — a box always contains its circle,
 * so this over-selects and never under-selects.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;

  // Meridians converge towards the poles, so a degree of longitude is worth
  // less the further from the equator you are. Clamped because the factor goes
  // to zero at the pole and would produce an infinite window.
  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lngDelta = radiusKm / (KM_PER_DEGREE_LAT * shrink);

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** Roads are never straight — pad the great-circle distance. */
export const ROAD_DISTANCE_FACTOR = Number(process.env.ROAD_DISTANCE_FACTOR || 1.3);

export function estimateRoadDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return round2(haversineKm(lat1, lng1, lat2, lng2) * ROAD_DISTANCE_FACTOR);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
