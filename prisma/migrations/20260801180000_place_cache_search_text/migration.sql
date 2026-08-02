-- AlterTable
ALTER TABLE "place_cache" ADD COLUMN     "category" TEXT,
ADD COLUMN     "searchText" TEXT;

-- Backfill rows already written back from the Places API, which have no
-- aliases or area to fold in — name and address are all there is.
UPDATE "place_cache"
SET "searchText" = lower("name" || ' | ' || "address")
WHERE "searchText" IS NULL;
