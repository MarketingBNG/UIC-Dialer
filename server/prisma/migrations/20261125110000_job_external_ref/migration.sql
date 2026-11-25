-- Claude batch id a translate/summarize/score job was sent in, so a restarted worker resumes the batch.
ALTER TABLE "jobs" ADD COLUMN "external_ref" TEXT;
