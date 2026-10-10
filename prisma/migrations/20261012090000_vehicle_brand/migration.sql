-- Brand (make) captured separately from the model; model becomes optional.
ALTER TABLE "Driver" ADD COLUMN "vehicleBrand" TEXT,
ALTER COLUMN "vehicleModel" DROP NOT NULL;
