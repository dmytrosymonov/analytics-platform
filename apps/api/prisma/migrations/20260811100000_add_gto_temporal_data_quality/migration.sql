ALTER TABLE "reporting_gto_orders"
ADD COLUMN "source_date_start" DATE,
ADD COLUMN "source_date_end" DATE,
ADD COLUMN "date_start_source" TEXT,
ADD COLUMN "date_end_source" TEXT,
ADD COLUMN "date_quality_status" TEXT,
ADD COLUMN "date_quality_flags" JSONB;

ALTER TABLE "reporting_gto_order_lines"
ADD COLUMN "has_invalid_date_range" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "reporting_gto_temporal_quality_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at_from" DATE,
    "created_at_to" DATE,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "scanned_orders" INTEGER NOT NULL DEFAULT 0,
    "normalized_orders" INTEGER NOT NULL DEFAULT 0,
    "invalid_line_rows" INTEGER NOT NULL DEFAULT 0,
    "unresolved_orders" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error_message" TEXT,
    "triggered_by" TEXT,
    CONSTRAINT "reporting_gto_temporal_quality_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reporting_gto_orders_date_quality_status_idx"
ON "reporting_gto_orders"("date_quality_status");
CREATE INDEX "reporting_gto_order_lines_invalid_date_range_idx"
ON "reporting_gto_order_lines"("has_invalid_date_range")
WHERE "has_invalid_date_range" = true;
CREATE INDEX "reporting_gto_temporal_quality_runs_started_at_idx"
ON "reporting_gto_temporal_quality_runs"("started_at");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'looker_studio_reader') THEN
    GRANT SELECT ON TABLE "reporting_gto_temporal_quality_runs" TO looker_studio_reader;
  END IF;
END $$;
