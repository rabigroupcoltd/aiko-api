-- Order.description: what the passenger is sending, in their own words.
--
-- Nullable with no default, so every existing row keeps a NULL rather than a
-- fabricated string. Nothing reads it as required: the driver card renders the
-- field only when it is present.
ALTER TABLE "Order" ADD COLUMN "description" VARCHAR(500);
