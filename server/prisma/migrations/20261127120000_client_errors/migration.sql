-- Problems reported by staff phones, laptops and browsers. Kept 30 days.
CREATE TABLE "client_errors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_errors_created_at_idx" ON "client_errors"("created_at");
