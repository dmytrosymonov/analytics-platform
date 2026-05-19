ALTER TABLE public.reporting_gto_orders
  ADD COLUMN IF NOT EXISTS accounting_class text,
  ADD COLUMN IF NOT EXISTS profit_basis_used text,
  ADD COLUMN IF NOT EXISTS has_incomplete_core_cost boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS reporting_gto_orders_accounting_class_idx
  ON public.reporting_gto_orders (accounting_class);

CREATE INDEX IF NOT EXISTS reporting_gto_orders_profit_basis_used_idx
  ON public.reporting_gto_orders (profit_basis_used);
