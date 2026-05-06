CREATE TABLE "reporting_gto_orders" (
    "order_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "date_start" DATE,
    "date_end" DATE,
    "order_status" TEXT NOT NULL,
    "order_status_name" TEXT,
    "creator" TEXT,
    "agent_id" TEXT,
    "agent_name" TEXT,
    "agent_network" TEXT,
    "agent_reference" TEXT,
    "company_id" TEXT,
    "company_name" TEXT,
    "order_currency" TEXT,
    "balance_currency" TEXT,
    "total_amount_original" DECIMAL(18,2),
    "total_amount_eur" DECIMAL(18,2),
    "balance_amount_original" DECIMAL(18,2),
    "balance_amount_eur" DECIMAL(18,2),
    "booking_rate_date" DATE,
    "tourists_count" INTEGER NOT NULL DEFAULT 0,
    "countries_count" INTEGER NOT NULL DEFAULT 0,
    "country_names" TEXT,
    "primary_country_name" TEXT,
    "suppliers_count" INTEGER NOT NULL DEFAULT 0,
    "supplier_names" TEXT,
    "destination_names" TEXT,
    "product_groups" TEXT,
    "has_hotel" BOOLEAN NOT NULL DEFAULT false,
    "has_airticket" BOOLEAN NOT NULL DEFAULT false,
    "has_transfer" BOOLEAN NOT NULL DEFAULT false,
    "has_insurance" BOOLEAN NOT NULL DEFAULT false,
    "has_other" BOOLEAN NOT NULL DEFAULT false,
    "is_package" BOOLEAN NOT NULL DEFAULT false,
    "hotel_lines_count" INTEGER NOT NULL DEFAULT 0,
    "airticket_lines_count" INTEGER NOT NULL DEFAULT 0,
    "transfer_lines_count" INTEGER NOT NULL DEFAULT 0,
    "insurance_lines_count" INTEGER NOT NULL DEFAULT 0,
    "other_lines_count" INTEGER NOT NULL DEFAULT 0,
    "active_lines_count" INTEGER NOT NULL DEFAULT 0,
    "cancelled_lines_count" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "urgent_comment_count" INTEGER NOT NULL DEFAULT 0,
    "has_comments" BOOLEAN NOT NULL DEFAULT false,
    "sales_lead_days" INTEGER,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reporting_gto_orders_pkey" PRIMARY KEY ("order_id")
);

CREATE TABLE "reporting_gto_order_lines" (
    "line_id" TEXT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "product_group" TEXT NOT NULL,
    "raw_type" TEXT,
    "service_type_name" TEXT,
    "status" TEXT,
    "status_name" TEXT,
    "supplier_id" TEXT,
    "supplier_name" TEXT,
    "destination_raw" TEXT,
    "date_from" DATE,
    "date_to" DATE,
    "currency" TEXT,
    "price_original" DECIMAL(18,2),
    "price_eur" DECIMAL(18,2),
    "price_buy_original" DECIMAL(18,2),
    "price_buy_eur" DECIMAL(18,2),
    "discount_original" DECIMAL(18,2),
    "number_of_services" INTEGER,
    "hotel_name" TEXT,
    "room_name" TEXT,
    "meal_name" TEXT,
    "accommodation_name" TEXT,
    "transfer_type" TEXT,
    "point_from" TEXT,
    "point_to" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reporting_gto_order_lines_pkey" PRIMARY KEY ("line_id")
);

CREATE TABLE "reporting_gto_sync_runs" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "window_date_from" DATE NOT NULL,
    "window_date_to" DATE NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "fetched_order_rows" INTEGER NOT NULL DEFAULT 0,
    "fetched_unique_order_ids" INTEGER NOT NULL DEFAULT 0,
    "synced_order_rows" INTEGER NOT NULL DEFAULT 0,
    "synced_line_rows" INTEGER NOT NULL DEFAULT 0,
    "detail_error_rows" INTEGER NOT NULL DEFAULT 0,
    "inserted_order_rows" INTEGER NOT NULL DEFAULT 0,
    "inserted_line_rows" INTEGER NOT NULL DEFAULT 0,
    "deleted_order_rows" INTEGER NOT NULL DEFAULT 0,
    "deleted_line_rows" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error_message" TEXT,
    "triggered_by" TEXT,
    "source_snapshot_date_from" DATE,
    "source_snapshot_date_to" DATE,

    CONSTRAINT "reporting_gto_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reporting_gto_orders_created_at_idx" ON "reporting_gto_orders"("created_at");
CREATE INDEX "reporting_gto_orders_date_start_idx" ON "reporting_gto_orders"("date_start");
CREATE INDEX "reporting_gto_orders_order_status_idx" ON "reporting_gto_orders"("order_status");
CREATE INDEX "reporting_gto_orders_agent_network_idx" ON "reporting_gto_orders"("agent_network");
CREATE INDEX "reporting_gto_orders_primary_country_name_idx" ON "reporting_gto_orders"("primary_country_name");

CREATE INDEX "reporting_gto_order_lines_order_id_idx" ON "reporting_gto_order_lines"("order_id");
CREATE INDEX "reporting_gto_order_lines_product_group_idx" ON "reporting_gto_order_lines"("product_group");
CREATE INDEX "reporting_gto_order_lines_supplier_name_idx" ON "reporting_gto_order_lines"("supplier_name");
CREATE INDEX "reporting_gto_order_lines_destination_raw_idx" ON "reporting_gto_order_lines"("destination_raw");

CREATE INDEX "reporting_gto_sync_runs_started_at_idx" ON "reporting_gto_sync_runs"("started_at");
CREATE INDEX "reporting_gto_sync_runs_status_idx" ON "reporting_gto_sync_runs"("status");

ALTER TABLE "reporting_gto_order_lines"
ADD CONSTRAINT "reporting_gto_order_lines_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "reporting_gto_orders"("order_id")
ON DELETE CASCADE ON UPDATE CASCADE;
