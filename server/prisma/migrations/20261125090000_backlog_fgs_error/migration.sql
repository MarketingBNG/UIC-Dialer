-- Why Android refused the older-recordings foreground notification (heartbeat).
ALTER TABLE "devices" ADD COLUMN "backlog_fgs_error" TEXT;
