ALTER TABLE "reporting_gto_orders"
ADD COLUMN "profit_logic_version" INTEGER,
ADD COLUMN "profit_recalculated_at" TIMESTAMP(3);
