-- Admin "Blocked" list: these emails can never sign in.
CREATE TABLE "blocked_emails" (
    "email" TEXT NOT NULL,
    "reason" TEXT,
    "blocked_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blocked_emails_pkey" PRIMARY KEY ("email")
);
