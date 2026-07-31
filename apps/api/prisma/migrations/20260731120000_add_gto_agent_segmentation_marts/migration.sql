CREATE TABLE "reporting_gto_agent_scope_overrides" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT,
    "normalized_agent_name" TEXT,
    "is_commercial" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reporting_gto_agent_scope_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporting_gto_agent_scope_overrides_match_required" CHECK ("agent_id" IS NOT NULL OR "normalized_agent_name" IS NOT NULL)
);

CREATE UNIQUE INDEX "reporting_gto_agent_scope_overrides_agent_id_key"
ON "reporting_gto_agent_scope_overrides"("agent_id") WHERE "agent_id" IS NOT NULL;
CREATE UNIQUE INDEX "reporting_gto_agent_scope_overrides_name_key"
ON "reporting_gto_agent_scope_overrides"("normalized_agent_name") WHERE "normalized_agent_name" IS NOT NULL;

CREATE TABLE "mart_gto_ua_agent_segment_snapshots" (
    "snapshot_date" DATE NOT NULL,
    "agent_key" TEXT NOT NULL,
    "agent_id" TEXT,
    "agent_name" TEXT,
    "agent_network" TEXT,
    "identity_confidence" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'GTO.UA',
    "segment" TEXT NOT NULL,
    "segment_rank" INTEGER NOT NULL,
    "cnf_365" INTEGER NOT NULL DEFAULT 0,
    "gmv_eur_365" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cnf_share_365" DECIMAL(18,8),
    "gmv_share_365" DECIMAL(18,8),
    "cnf_90" INTEGER NOT NULL DEFAULT 0,
    "gmv_eur_90" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cnf_share_90" DECIMAL(18,8),
    "gmv_share_90" DECIMAL(18,8),
    "booking_momentum" DECIMAL(18,8),
    "revenue_momentum" DECIMAL(18,8),
    "cnx_90" INTEGER NOT NULL DEFAULT 0,
    "attempt_cnx_rate_90" DECIMAL(18,8),
    "package_cnf_90" INTEGER NOT NULL DEFAULT 0,
    "package_share_90" DECIMAL(18,8),
    "avg_gmv_per_cnf_90" DECIMAL(18,2),
    "last_cnf_date" DATE,
    "is_active_7d" BOOLEAN NOT NULL DEFAULT false,
    "is_active_mtd" BOOLEAN NOT NULL DEFAULT false,
    "is_growth_candidate" BOOLEAN NOT NULL DEFAULT false,
    "is_stable" BOOLEAN NOT NULL DEFAULT false,
    "is_losing_momentum" BOOLEAN NOT NULL DEFAULT false,
    "is_retention_risk" BOOLEAN NOT NULL DEFAULT false,
    "is_stopped" BOOLEAN NOT NULL DEFAULT false,
    "is_high_value_potential" BOOLEAN NOT NULL DEFAULT false,
    "is_high_frequency_low_value" BOOLEAN NOT NULL DEFAULT false,
    "is_quality_risk" BOOLEAN NOT NULL DEFAULT false,
    "quality_overlay" TEXT NOT NULL,
    "commercial_overlay" TEXT,
    "included_in_base" BOOLEAN NOT NULL DEFAULT true,
    "data_quality_flag" TEXT,
    "logic_version" INTEGER NOT NULL,
    "refresh_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mart_gto_ua_agent_segment_snapshots_pkey" PRIMARY KEY ("snapshot_date", "agent_key")
);

CREATE INDEX "mart_gto_ua_agent_segment_snapshots_agent_key_idx"
ON "mart_gto_ua_agent_segment_snapshots"("agent_key");
CREATE INDEX "mart_gto_ua_agent_segment_snapshots_segment_idx"
ON "mart_gto_ua_agent_segment_snapshots"("snapshot_date", "segment");

CREATE TABLE "mart_gto_ua_agent_segment_changes" (
    "from_snapshot_date" DATE NOT NULL,
    "to_snapshot_date" DATE NOT NULL,
    "agent_key" TEXT NOT NULL,
    "agent_name" TEXT,
    "from_segment" TEXT,
    "to_segment" TEXT,
    "from_rank" INTEGER,
    "to_rank" INTEGER,
    "rank_delta" INTEGER,
    "transition_type" TEXT NOT NULL,
    "cnf_365_from" INTEGER,
    "cnf_365_to" INTEGER,
    "gmv_eur_365_from" DECIMAL(18,2),
    "gmv_eur_365_to" DECIMAL(18,2),
    "gmv_share_365_from" DECIMAL(18,8),
    "gmv_share_365_to" DECIMAL(18,8),
    "booking_momentum_to" DECIMAL(18,8),
    "revenue_momentum_to" DECIMAL(18,8),
    "quality_overlay_to" TEXT,
    "primary_driver_label" TEXT,
    "refresh_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mart_gto_ua_agent_segment_changes_pkey" PRIMARY KEY ("from_snapshot_date", "to_snapshot_date", "agent_key")
);

CREATE INDEX "mart_gto_ua_agent_segment_changes_to_date_idx"
ON "mart_gto_ua_agent_segment_changes"("to_snapshot_date", "transition_type");

CREATE TABLE "mart_gto_ua_segment_daily_summary" (
    "snapshot_date" DATE NOT NULL,
    "segment" TEXT NOT NULL,
    "segment_rank" INTEGER NOT NULL,
    "agents" INTEGER NOT NULL DEFAULT 0,
    "cnf_365" INTEGER NOT NULL DEFAULT 0,
    "gmv_eur_365" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cnf_90" INTEGER NOT NULL DEFAULT 0,
    "gmv_eur_90" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "package_cnf_90" INTEGER NOT NULL DEFAULT 0,
    "cnx_90" INTEGER NOT NULL DEFAULT 0,
    "refresh_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mart_gto_ua_segment_daily_summary_pkey" PRIMARY KEY ("snapshot_date", "segment")
);

CREATE TABLE "mart_gto_ua_agent_segment_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot_date_from" DATE NOT NULL,
    "snapshot_date_to" DATE NOT NULL,
    "snapshots_refreshed" INTEGER NOT NULL DEFAULT 0,
    "agents_refreshed" INTEGER NOT NULL DEFAULT 0,
    "unknown_identity_orders" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error_message" TEXT,
    "triggered_by" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "mart_gto_ua_agent_segment_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mart_gto_ua_agent_segment_runs_started_at_idx"
ON "mart_gto_ua_agent_segment_runs"("started_at");

CREATE TABLE "mart_gto_ua_agent_segment_dirty_ranges" (
    "id" TEXT NOT NULL,
    "snapshot_date_from" DATE NOT NULL,
    "snapshot_date_to" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "mart_gto_ua_agent_segment_dirty_ranges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mart_gto_ua_agent_segment_dirty_ranges_pending_idx"
ON "mart_gto_ua_agent_segment_dirty_ranges"("resolved_at", "snapshot_date_from");

CREATE OR REPLACE VIEW "mart_gto_ua_agent_segments_current" AS
SELECT DISTINCT ON ("agent_key") *
FROM "mart_gto_ua_agent_segment_snapshots"
ORDER BY "agent_key", "snapshot_date" DESC;

INSERT INTO "reporting_gto_agent_scope_overrides" (
  "id", "normalized_agent_name", "is_commercial", "reason", "created_at", "updated_at"
) VALUES
  (md5(random()::text || clock_timestamp()::text), 'gto.ua', false, 'technical account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5(random()::text || clock_timestamp()::text), 'gto для внутрішнього користування', false, 'technical account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5(random()::text || clock_timestamp()::text), 'testagency', false, 'test account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'looker_studio_reader') THEN
    GRANT SELECT ON TABLE "mart_gto_ua_agent_segment_snapshots" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_segment_changes" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_segment_daily_summary" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_segment_runs" TO looker_studio_reader;
    GRANT SELECT ON TABLE "reporting_gto_agent_scope_overrides" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_segments_current" TO looker_studio_reader;
  END IF;
END $$;
