ALTER TABLE "reporting_gto_orders"
ADD COLUMN "airline_codes" TEXT,
ADD COLUMN "airline_names" TEXT;

ALTER TABLE "reporting_gto_order_lines"
ADD COLUMN "airline_codes" TEXT,
ADD COLUMN "airline_names" TEXT;

CREATE TABLE "reporting_gto_order_line_airlines" (
    "line_id" TEXT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "airline_code" TEXT NOT NULL,
    "airline_name" TEXT,
    "segment_count" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reporting_gto_order_line_airlines_pkey" PRIMARY KEY ("line_id","airline_code")
);

CREATE INDEX "reporting_gto_order_line_airlines_order_id_idx" ON "reporting_gto_order_line_airlines"("order_id");
CREATE INDEX "reporting_gto_order_line_airlines_airline_code_idx" ON "reporting_gto_order_line_airlines"("airline_code");
CREATE INDEX "reporting_gto_order_line_airlines_airline_name_idx" ON "reporting_gto_order_line_airlines"("airline_name");

ALTER TABLE "reporting_gto_order_line_airlines"
ADD CONSTRAINT "reporting_gto_order_line_airlines_line_id_fkey"
FOREIGN KEY ("line_id") REFERENCES "reporting_gto_order_lines"("line_id")
ON DELETE CASCADE ON UPDATE CASCADE;
