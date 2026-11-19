-- Stage 3: lead sources / events, do-not-call list, daily targets, AI call scores, new audit actions.
-- Hand-written and additive; leaves the transcripts tsv column / GIN index and the calls phone trigram index untouched.
-- New enum values first; none of them is used (as a default or in data) in this migration.
ALTER TYPE "FollowUpKind" ADD VALUE 'NEW_LEAD';
ALTER TYPE "AuditAction" ADD VALUE 'CALL_LIST_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'CONTACT_IMPORT';
ALTER TYPE "AuditAction" ADD VALUE 'DNC_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'LEAD_SOURCE_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'OUTCOME_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'TARGET_CHANGE';

CREATE TYPE "DncSource" AS ENUM ('MANUAL', 'OUTCOME', 'IMPORT');

ALTER TABLE "users" ADD COLUMN "target_calls_per_day" INTEGER, ADD COLUMN "target_talk_min_per_day" INTEGER;

CREATE TABLE "dnc_numbers" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "phone_e164" TEXT,
    "raw" TEXT NOT NULL,
    "reason" TEXT,
    "source" "DncSource" NOT NULL DEFAULT 'MANUAL',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dnc_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dnc_numbers_key_key" ON "dnc_numbers" ("key");
ALTER TABLE "dnc_numbers" ADD CONSTRAINT "dnc_numbers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rep_pool" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "field_map" JSONB,
    "rr_cursor" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_sources_name_key" ON "lead_sources" ("name");
CREATE UNIQUE INDEX "lead_sources_token_hash_key" ON "lead_sources" ("token_hash");

CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "source_id" UUID,
    "external_id" TEXT,
    "contact_id" UUID,
    "assigned_to_id" UUID,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_events_source_id_external_id_key" ON "lead_events" ("source_id", "external_id");
CREATE INDEX "lead_events_created_at_idx" ON "lead_events" ("created_at" DESC);
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "follow_up_tasks" ADD COLUMN "lead_event_id" UUID;
CREATE UNIQUE INDEX "follow_up_tasks_lead_event_id_key" ON "follow_up_tasks" ("lead_event_id");
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_lead_event_id_fkey" FOREIGN KEY ("lead_event_id") REFERENCES "lead_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "call_scores" (
    "call_id" UUID NOT NULL,
    "overall" INTEGER NOT NULL,
    "script_adherence" INTEGER,
    "sentiment" TEXT NOT NULL,
    "objections" JSONB NOT NULL,
    "next_step" TEXT,
    "strengths" JSONB NOT NULL,
    "improvements" JSONB NOT NULL,
    "script_id" UUID,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "call_scores_pkey" PRIMARY KEY ("call_id")
);
ALTER TABLE "call_scores" ADD CONSTRAINT "call_scores_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
