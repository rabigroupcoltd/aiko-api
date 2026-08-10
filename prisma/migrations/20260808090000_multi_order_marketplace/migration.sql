-- Multi-order driver marketplace.
--
-- Additive only: the ride lane (PENDING → ACCEPTED → … → COMPLETED) keeps every
-- value it had, and the marketplace lane is new values on the same enum.

-- AlterEnum: marketplace order lifecycle
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'SEARCHING_FOR_DRIVER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DRIVER_ARRIVING_PICKUP';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PICKED_UP';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'NO_DRIVER_FOUND';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DriverOrderActionType" AS ENUM ('SKIPPED', 'RESERVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "pickupPhone"      TEXT,
  ADD COLUMN IF NOT EXISTS "dropoffPhone"     TEXT,
  ADD COLUMN IF NOT EXISTS "reservedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pickedUpAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "searchRadiusKm"   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "dispatchAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: the marketplace's bounding-box scan over open orders
CREATE INDEX IF NOT EXISTS "Order_status_pickupLat_pickupLng_idx"
  ON "Order" ("status", "pickupLat", "pickupLng");

-- CreateTable
CREATE TABLE IF NOT EXISTS "driver_order_actions" (
  "id"          TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "driverId"    TEXT NOT NULL,
  "action"      "DriverOrderActionType" NOT NULL,
  "hiddenUntil" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "driver_order_actions_pkey" PRIMARY KEY ("id")
);

-- One decision per (order, driver): a skip is replaced, not appended to.
CREATE UNIQUE INDEX IF NOT EXISTS "driver_order_actions_orderId_driverId_key"
  ON "driver_order_actions" ("orderId", "driverId");

CREATE INDEX IF NOT EXISTS "driver_order_actions_driverId_action_idx"
  ON "driver_order_actions" ("driverId", "action");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "driver_order_actions"
    ADD CONSTRAINT "driver_order_actions_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "driver_order_actions"
    ADD CONSTRAINT "driver_order_actions_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
