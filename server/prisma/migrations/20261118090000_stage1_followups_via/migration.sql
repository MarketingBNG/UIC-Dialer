-- Stage 1: "via" on calls/activities, desktop dial intents, missed-call follow-up tasks.
-- Hand-written and additive; leaves the transcripts tsv column / GIN index and the calls phone trigram index untouched.
CREATE TYPE "DialVia" AS ENUM ('LAPTOP', 'APP', 'PHONE_DIALER');
CREATE TYPE "FollowUpKind" AS ENUM ('MISSED_CALL');
CREATE TYPE "FollowUpState" AS ENUM ('OPEN', 'DONE', 'DISMISSED');

ALTER TABLE "calls" ADD COLUMN "via" "DialVia";
ALTER TABLE "activities" ADD COLUMN "via" "DialVia";

CREATE TABLE "dial_intents" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "call_id" UUID,
    CONSTRAINT "dial_intents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dial_intents_client_id_key" ON "dial_intents" ("client_id");
CREATE UNIQUE INDEX "dial_intents_call_id_key" ON "dial_intents" ("call_id");
CREATE INDEX "dial_intents_user_id_phone_e164_created_at_idx" ON "dial_intents" ("user_id", "phone_e164", "created_at");
ALTER TABLE "dial_intents" ADD CONSTRAINT "dial_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "follow_up_tasks" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "contact_id" UUID,
    "phone_e164" TEXT NOT NULL,
    "caller_name" TEXT,
    "kind" "FollowUpKind" NOT NULL DEFAULT 'MISSED_CALL',
    "state" "FollowUpState" NOT NULL DEFAULT 'OPEN',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "follow_up_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "follow_up_tasks_client_id_key" ON "follow_up_tasks" ("client_id");
CREATE INDEX "follow_up_tasks_user_id_state_due_at_idx" ON "follow_up_tasks" ("user_id", "state", "due_at");
CREATE INDEX "follow_up_tasks_phone_e164_idx" ON "follow_up_tasks" ("phone_e164");
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
