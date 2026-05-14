ALTER TABLE "reporting_gto_orders"
ADD COLUMN "has_order_destination" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "package_destination_name" TEXT,
ADD COLUMN "product_segment" TEXT;
