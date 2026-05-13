ALTER TABLE public.reporting_gto_orders
  ADD COLUMN IF NOT EXISTS cost_amount_eur numeric(18,2),
  ADD COLUMN IF NOT EXISTS profit_eur numeric(18,2),
  ADD COLUMN IF NOT EXISTS profit_pct integer;
