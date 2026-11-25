ALTER TABLE public.reporting_gto_orders
  ADD COLUMN IF NOT EXISTS profit_revenue_eur numeric(18, 2),
  ADD COLUMN IF NOT EXISTS base_cost_amount_eur numeric(18, 2),
  ADD COLUMN IF NOT EXISTS base_profit_eur numeric(18, 2);

ALTER TABLE public.reporting_gto_order_lines
  ADD COLUMN IF NOT EXISTS service_name text,
  ADD COLUMN IF NOT EXISTS service_full_name text,
  ADD COLUMN IF NOT EXISTS is_hidden boolean;
