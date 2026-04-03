CREATE TABLE "user_manual_report_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "report_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_manual_report_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_manual_report_access_user_id_report_key_key"
ON "user_manual_report_access"("user_id", "report_key");

ALTER TABLE "user_manual_report_access"
ADD CONSTRAINT "user_manual_report_access_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
