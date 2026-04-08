ALTER TABLE "report_runs"
ADD COLUMN "triggered_by_telegram_user_id" TEXT;

ALTER TABLE "report_runs"
ADD CONSTRAINT "report_runs_triggered_by_telegram_user_id_fkey"
FOREIGN KEY ("triggered_by_telegram_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "report_runs_triggered_by_telegram_user_id_idx"
ON "report_runs"("triggered_by_telegram_user_id");
