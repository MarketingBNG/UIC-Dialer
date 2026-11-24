-- Which SIM (and so which of the rep's numbers) each call used.
ALTER TABLE "calls" ADD COLUMN "sim_key" TEXT, ADD COLUMN "sim_slot" INTEGER, ADD COLUMN "sim_carrier" TEXT;
ALTER TABLE "devices" ADD COLUMN "sims_reported_at" TIMESTAMP(3);

CREATE TABLE "device_sims" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "sim_key" TEXT NOT NULL,
    "slot" INTEGER,
    "carrier" TEXT,
    "number" TEXT,
    "number_set_by" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_sims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "device_sims_device_id_sim_key_key" ON "device_sims"("device_id", "sim_key");
ALTER TABLE "device_sims" ADD CONSTRAINT "device_sims_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
