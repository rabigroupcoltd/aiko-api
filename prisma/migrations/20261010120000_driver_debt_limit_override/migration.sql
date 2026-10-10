-- debtLimit becomes an optional per-driver override; NULL follows the
-- DRIVER_DEBT_LIMIT platform setting.
ALTER TABLE "Driver" ALTER COLUMN "debtLimit" DROP NOT NULL,
ALTER COLUMN "debtLimit" DROP DEFAULT;

-- Rows still on the old column default were never set by anyone, so they
-- move over to the platform setting.
UPDATE "Driver" SET "debtLimit" = NULL WHERE "debtLimit" = 10000;
