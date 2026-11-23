-- Dashboard sign-ins (Windows app and browsers), listed with phones and revocable.
CREATE TABLE "web_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "web_sessions_user_id_idx" ON "web_sessions"("user_id");
CREATE INDEX "web_sessions_last_seen_at_idx" ON "web_sessions"("last_seen_at");
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
