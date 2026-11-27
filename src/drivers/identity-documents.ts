import { VehiclePhotoType } from '@prisma/client';
import { JwtUser } from '../common/current-user.decorator';

/** Photos that identify the person, not the vehicle. Never public. */
export const IDENTITY_DOCUMENT_TYPES: readonly VehiclePhotoType[] = [
  VehiclePhotoType.DRIVER_LICENSE,
  VehiclePhotoType.NATIONAL_ID,
];

/**
 * What every rider application must include. Checked on the server because the
 * client's scanning and OCR are a convenience, not a verification: an admin
 * still has to see each image before approving. The driver's licence is
 * optional — sent when the rider has one, never required.
 */
export const REQUIRED_APPLICATION_PHOTOS: readonly VehiclePhotoType[] = [
  VehiclePhotoType.NATIONAL_ID,
  VehiclePhotoType.PLATE_NUMBER,
];

const LABELS: Partial<Record<VehiclePhotoType, string>> = {
  DRIVER_LICENSE: "driver's licence",
  NATIONAL_ID: 'national ID',
  PLATE_NUMBER: 'plate number scan',
};

/** Names the required documents missing from an upload, or null when complete. */
export function missingApplicationPhotos(types: VehiclePhotoType[]): string | null {
  const missing = REQUIRED_APPLICATION_PHOTOS.filter((type) => !types.includes(type));
  if (missing.length === 0) return null;
  return `Add your ${missing.map((type) => LABELS[type] ?? type.toLowerCase()).join(', ')} to apply`;
}

export function canSeeIdentityDocuments(viewer: JwtUser | undefined, ownerUserId?: string): boolean {
  if (!viewer) return false;
  if (viewer.roles?.includes('ADMIN')) return true;
  return Boolean(ownerUserId) && viewer.sub === ownerUserId;
}

type WithPhotos = { userId?: string; vehiclePhotos?: { type: VehiclePhotoType }[] };

function stripFromDriver<T extends WithPhotos>(driver: T, viewer: JwtUser | undefined): T {
  if (!driver?.vehiclePhotos || canSeeIdentityDocuments(viewer, driver.userId)) return driver;
  return {
    ...driver,
    vehiclePhotos: driver.vehiclePhotos.filter((photo) => !IDENTITY_DOCUMENT_TYPES.includes(photo.type)),
  };
}

/** Removes licence and ID images from a driver, or a list of drivers, the viewer may not see. */
export function redactDriverDocuments<T>(body: T, viewer: JwtUser | undefined): T {
  if (Array.isArray(body)) return body.map((driver) => stripFromDriver(driver, viewer)) as T;
  if (body && typeof body === 'object') return stripFromDriver(body as WithPhotos, viewer) as T;
  return body;
}

/** Removes licence and ID images from a bare photo list the viewer may not see. */
export function redactPhotoList<T extends { type: VehiclePhotoType }>(
  photos: T[],
  viewer: JwtUser | undefined,
  ownerUserId: string | undefined,
): T[] {
  if (canSeeIdentityDocuments(viewer, ownerUserId)) return photos;
  return photos.filter((photo) => !IDENTITY_DOCUMENT_TYPES.includes(photo.type));
}
