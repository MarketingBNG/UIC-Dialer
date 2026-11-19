-- Stage 2: custom outcomes, call scripts, message templates, call lists; contacts city/source; activity links.
-- Hand-written and additive; leaves the transcripts tsv column / GIN index and the calls phone trigram index untouched.
CREATE TYPE "OutcomeRule" AS ENUM ('NONE', 'ASK_FOLLOW_UP', 'ASK_MEETING', 'ASK_CALLBACK', 'CLOSE_LEAD', 'RETRY', 'REMOVE_FROM_LISTS');
CREATE TYPE "CallListState" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "CallListItemState" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED', 'REMOVED');

ALTER TABLE "contacts" ADD COLUMN "city" TEXT, ADD COLUMN "source" TEXT;
CREATE INDEX "contacts_status_idx" ON "contacts" ("status");

CREATE TABLE "outcome_defs" (
    "id" UUID NOT NULL,
    "key" TEXT,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "base_outcome" "CallOutcome" NOT NULL,
    "rule" "OutcomeRule" NOT NULL DEFAULT 'NONE',
    "retry_hours" INTEGER,
    "add_to_dnc" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outcome_defs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outcome_defs_key_key" ON "outcome_defs" ("key");

CREATE TABLE "call_scripts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "call_scripts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_lists" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "script_id" UUID,
    "state" "CallListState" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "call_lists_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "call_lists_state_idx" ON "call_lists" ("state");
ALTER TABLE "call_lists" ADD CONSTRAINT "call_lists_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "call_scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "call_lists" ADD CONSTRAINT "call_lists_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "call_list_assignees" (
    "list_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    CONSTRAINT "call_list_assignees_pkey" PRIMARY KEY ("list_id", "user_id")
);
CREATE INDEX "call_list_assignees_user_id_idx" ON "call_list_assignees" ("user_id");
ALTER TABLE "call_list_assignees" ADD CONSTRAINT "call_list_assignees_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "call_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_list_assignees" ADD CONSTRAINT "call_list_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "call_list_items" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "state" "CallListItemState" NOT NULL DEFAULT 'PENDING',
    "claimed_by_id" UUID,
    "lease_until" TIMESTAMP(3),
    "retry_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_outcome_id" UUID,
    "last_outcome" "CallOutcome",
    "last_activity_at" TIMESTAMP(3),
    "done_by_id" UUID,
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "call_list_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "call_list_items_list_id_contact_id_key" ON "call_list_items" ("list_id", "contact_id");
CREATE INDEX "call_list_items_list_id_state_position_idx" ON "call_list_items" ("list_id", "state", "position");
CREATE INDEX "call_list_items_contact_id_state_idx" ON "call_list_items" ("contact_id", "state");
ALTER TABLE "call_list_items" ADD CONSTRAINT "call_list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "call_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_list_items" ADD CONSTRAINT "call_list_items_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_list_items" ADD CONSTRAINT "call_list_items_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "call_list_items" ADD CONSTRAINT "call_list_items_done_by_id_fkey" FOREIGN KEY ("done_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "call_list_items" ADD CONSTRAINT "call_list_items_last_outcome_id_fkey" FOREIGN KEY ("last_outcome_id") REFERENCES "outcome_defs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "activities" ADD COLUMN "outcome_id" UUID,
    ADD COLUMN "call_list_item_id" UUID,
    ADD COLUMN "channel" TEXT,
    ADD COLUMN "template_id" UUID;
CREATE INDEX "activities_outcome_id_idx" ON "activities" ("outcome_id");
CREATE INDEX "activities_call_list_item_id_idx" ON "activities" ("call_list_item_id");
ALTER TABLE "activities" ADD CONSTRAINT "activities_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "outcome_defs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_call_list_item_id_fkey" FOREIGN KEY ("call_list_item_id") REFERENCES "call_list_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The four default outcomes (fixed ids; old apps' plain `outcome` maps to these). Existing enum values only.
INSERT INTO "outcome_defs" ("id", "key", "label", "color", "sort_order", "active", "base_outcome", "rule", "add_to_dnc", "created_at", "updated_at") VALUES
    ('00000000-0000-7000-8000-000000000001', 'interested', 'Interested', '#16A34A', 10, true, 'INTERESTED', 'NONE', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('00000000-0000-7000-8000-000000000002', 'call_back', 'Call back', '#D97706', 20, true, 'CALL_BACK', 'ASK_CALLBACK', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('00000000-0000-7000-8000-000000000003', 'not_interested', 'Not interested', '#DC2626', 30, true, 'NOT_INTERESTED', 'NONE', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('00000000-0000-7000-8000-000000000004', 'no_answer', 'No answer', '#64748B', 40, true, 'NO_ANSWER', 'NONE', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
