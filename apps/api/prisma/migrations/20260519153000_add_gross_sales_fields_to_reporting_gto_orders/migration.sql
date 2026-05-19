ALTER TABLE "reporting_gto_orders"
ADD COLUMN "gross_amount_original" DECIMAL(18, 2),
ADD COLUMN "gross_amount_currency" TEXT,
ADD COLUMN "gross_amount_eur" DECIMAL(18, 2),
ADD COLUMN "commission_amount_original" DECIMAL(18, 2),
ADD COLUMN "commission_amount_currency" TEXT,
ADD COLUMN "commission_amount_eur" DECIMAL(18, 2),
ADD COLUMN "sales_basis_used" TEXT;
