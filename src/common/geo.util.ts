const EARTH_RADIUS_KM = 6371;

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

export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;

  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lngDelta = radiusKm / (KM_PER_DEGREE_LAT * shrink);

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

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
