ALTER TABLE public.reporting_gto_orders
  ADD COLUMN IF NOT EXISTS destination_id text;

ALTER TABLE public.reporting_gto_order_lines
  ADD COLUMN IF NOT EXISTS currency_buy text;

CREATE INDEX IF NOT EXISTS reporting_gto_orders_destination_id_idx
  ON public.reporting_gto_orders (destination_id);
