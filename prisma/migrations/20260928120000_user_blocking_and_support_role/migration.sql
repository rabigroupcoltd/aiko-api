-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'SUPPORT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isBlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blockedReason" TEXT;
