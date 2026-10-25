-- Account deletion: a soft marker on the user, and requests made from the public page.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TYPE "DeletionRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountDeletionRequest_status_createdAt_idx" ON "AccountDeletionRequest"("status", "createdAt");

ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
