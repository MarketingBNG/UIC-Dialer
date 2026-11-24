-- Every call-log entry (missed, rejected, unanswered, unrecorded) is sent by the phone, not just recorded calls.
ALTER TYPE "CallStatus" ADD VALUE 'NO_RECORDING';
ALTER TABLE "calls" ADD COLUMN "call_log_key" TEXT, ADD COLUMN "log_type" TEXT;
CREATE UNIQUE INDEX "calls_user_id_call_log_key_key" ON "calls"("user_id", "call_log_key");
