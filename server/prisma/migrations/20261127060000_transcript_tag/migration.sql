-- NO_SPEECH / VOICEMAIL: transcript kept, no translation or summary made.
ALTER TABLE "transcripts" ADD COLUMN "tag" TEXT;
