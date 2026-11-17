ALTER TABLE public.reporting_gto_orders
  ADD COLUMN IF NOT EXISTS financial_adjustments jsonb,
  ADD COLUMN IF NOT EXISTS financial_adjustment_eur numeric(18, 2);
