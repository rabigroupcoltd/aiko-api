-- Identity documents for rider KYC, stored alongside the vehicle photos.
ALTER TYPE "VehiclePhotoType" ADD VALUE IF NOT EXISTS 'DRIVER_LICENSE';
ALTER TYPE "VehiclePhotoType" ADD VALUE IF NOT EXISTS 'NATIONAL_ID';
