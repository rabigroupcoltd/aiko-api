-- Admin dispatch: an admin can hand an unclaimed order straight to a rider,
-- and the rider can hand it back within a short window.
ALTER TABLE "Order"
  ADD COLUMN "searchStartedAt" TIMESTAMP(3),
  ADD COLUMN "assignedById" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "declinedByDriverId" TEXT,
  ADD COLUMN "declinedAt" TIMESTAMP(3);
