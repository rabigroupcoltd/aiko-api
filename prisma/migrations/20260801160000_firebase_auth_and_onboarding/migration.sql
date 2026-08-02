-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('FIREBASE_GOOGLE', 'FIREBASE_PHONE', 'PASSWORD');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PASSENGER', 'RIDER');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('PHONE', 'PROFILE', 'PHOTO', 'LIVENESS', 'USER_TYPE', 'RIDER_DOCS', 'DONE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountType" "AccountType",
ADD COLUMN     "authProvider" "AuthProvider" NOT NULL DEFAULT 'PASSWORD',
ADD COLUMN     "dob" TIMESTAMP(3),
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firebaseUid" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "livenessPassedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStep" "OnboardingStep" NOT NULL DEFAULT 'PHONE',
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "profilePhotoKey" TEXT,
ADD COLUMN     "profilePhotoUrl" TEXT,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password" DROP NOT NULL,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- Existing rows predate Firebase: they all signed up with a password and are
-- past onboarding, so mark them so rather than leaving them at step PHONE.
UPDATE "User"
SET "authProvider" = 'PASSWORD',
    "onboardingStep" = 'DONE',
    "onboardingCompletedAt" = COALESCE("onboardingCompletedAt", "createdAt")
WHERE "password" IS NOT NULL;
