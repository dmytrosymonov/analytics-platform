-- Read-only marts for the GTO.UA agent-performance report. They deliberately
-- derive only from the reporting layer and never trigger a GTO API request.

CREATE OR REPLACE VIEW "mart_gto_ua_commercial_orders" AS
WITH scoped_orders AS (
  SELECT
    o.*,
    lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) AS normalized_agent_name,
    CASE
      WHEN nullif(btrim(coalesce(o.agent_id, '')), '') IS NOT NULL THEN 'agent:' || btrim(o.agent_id)
      WHEN nullif(btrim(coalesce(o.agent_name, '')), '') IS NOT NULL THEN 'name:' || lower(regexp_replace(btrim(o.agent_name), '\\s+', ' ', 'g'))
      ELSE NULL
    END AS agent_key
  FROM "reporting_gto_orders" o
  LEFT JOIN LATERAL (
    SELECT s.is_commercial
    FROM "reporting_gto_agent_scope_overrides" s
    WHERE s.is_active
      AND (
        (s.agent_id IS NOT NULL AND s.agent_id = nullif(btrim(coalesce(o.agent_id, '')), ''))
        OR (s.agent_id IS NULL AND s.normalized_agent_name = lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')))
      )
    ORDER BY CASE WHEN s.agent_id IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1
  ) scope_override ON true
  WHERE lower(btrim(coalesce(o.structure_name, ''))) = 'gto.ua'
    AND coalesce(
      scope_override.is_commercial,
      NOT (
        lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) IN ('gto.ua', 'gto для внутрішнього користування', 'testagency')
        OR lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) LIKE '%test%'
      )
    )
)
SELECT
  order_id,
  (created_at AT TIME ZONE 'Europe/Kyiv')::date AS created_date,
  created_at,
  updated_at,
  date_start,
  upper(btrim(coalesce(order_status, ''))) AS order_status,
  agent_key,
  nullif(btrim(coalesce(agent_id, '')), '') AS agent_id,
  nullif(btrim(coalesce(agent_name, '')), '') AS agent_name,
  agent_network,
  tourists_count,
  coalesce(balance_amount_eur, total_amount_eur, 0)::numeric(18,2) AS gmv_eur,
  coalesce(profit_eur, 0)::numeric(18,2) AS profit_eur,
  product_segment,
  coalesce(nullif(btrim(package_destination_name), ''), nullif(btrim(primary_country_name), ''), 'Unspecified') AS destination_name
FROM scoped_orders
WHERE agent_key IS NOT NULL;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_summary" AS
WITH daily AS (
  SELECT
    created_date AS report_date,
    agent_key,
    max(agent_id) AS agent_id,
    (array_agg(agent_name ORDER BY created_at DESC) FILTER (WHERE agent_name IS NOT NULL))[1] AS agent_name,
    (array_agg(agent_network ORDER BY created_at DESC) FILTER (WHERE agent_network IS NOT NULL))[1] AS agent_network,
    count(*)::int AS attempted_orders,
    count(*) FILTER (WHERE order_status = 'CNF')::int AS cnf_orders,
    count(*) FILTER (WHERE order_status = 'CNX')::int AS cnx_orders,
    count(*) FILTER (WHERE order_status NOT IN ('CNF', 'CNX'))::int AS open_or_other_orders,
    coalesce(sum(tourists_count) FILTER (WHERE order_status = 'CNF'), 0)::int AS tourists_cnf,
    round(coalesce(sum(gmv_eur) FILTER (WHERE order_status = 'CNF'), 0), 2) AS gmv_eur,
    round(coalesce(sum(profit_eur) FILTER (WHERE order_status = 'CNF'), 0), 2) AS profit_eur
  FROM "mart_gto_ua_commercial_orders"
  GROUP BY created_date, agent_key
), cnf_dates AS (
  SELECT
    report_date,
    agent_key,
    min(report_date) OVER (PARTITION BY agent_key) AS first_cnf_date,
    lag(report_date) OVER (PARTITION BY agent_key ORDER BY report_date) AS previous_cnf_date
  FROM daily
  WHERE cnf_orders > 0
), latest_segment AS (
  SELECT DISTINCT ON (agent_key)
    agent_key, segment, segment_rank, quality_overlay, commercial_overlay,
    booking_momentum, revenue_momentum, is_growth_candidate, is_retention_risk,
    is_stopped, is_quality_risk
  FROM "mart_gto_ua_agent_segment_snapshots"
  ORDER BY agent_key, snapshot_date DESC
)
SELECT
  d.report_date,
  d.agent_key,
  d.agent_id,
  d.agent_name,
  d.agent_network,
  d.attempted_orders,
  d.cnf_orders,
  d.cnx_orders,
  d.open_or_other_orders,
  d.tourists_cnf,
  d.gmv_eur,
  d.profit_eur,
  round(d.gmv_eur / nullif(d.cnf_orders, 0), 2) AS avg_gmv_per_cnf,
  round(d.profit_eur / nullif(d.gmv_eur, 0), 8) AS profit_margin,
  c.first_cnf_date,
  c.previous_cnf_date,
  coalesce(c.report_date = c.first_cnf_date, false) AS is_new_active,
  coalesce(c.previous_cnf_date < d.report_date - 90, false) AS is_reactivated,
  s.segment,
  s.segment_rank,
  s.quality_overlay,
  s.commercial_overlay,
  s.booking_momentum,
  s.revenue_momentum,
  coalesce(s.is_growth_candidate, false) AS is_growth_candidate,
  coalesce(s.is_retention_risk, false) AS is_retention_risk,
  coalesce(s.is_stopped, false) AS is_stopped,
  coalesce(s.is_quality_risk, false) AS is_quality_risk
FROM daily d
LEFT JOIN cnf_dates c ON c.report_date = d.report_date AND c.agent_key = d.agent_key
LEFT JOIN latest_segment s ON s.agent_key = d.agent_key;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_current" AS
WITH boundaries AS (
  SELECT
    ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1) AS as_of_date,
    date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1)::date AS current_week_start
), windows AS (
  SELECT
    as_of_date,
    current_week_start,
    current_week_start - 7 AS previous_week_start,
    date_trunc('month', as_of_date)::date AS current_month_start,
    (date_trunc('month', as_of_date) - interval '1 month')::date AS previous_month_start,
    least(
      (date_trunc('month', as_of_date) - interval '1 month')::date + (as_of_date - date_trunc('month', as_of_date)::date),
      (date_trunc('month', as_of_date) - interval '1 day')::date
    ) AS previous_month_to,
    (date_trunc('month', as_of_date) - interval '1 year')::date AS prior_year_month_start,
    least(
      (date_trunc('month', as_of_date) - interval '1 year')::date + (as_of_date - date_trunc('month', as_of_date)::date),
      (date_trunc('month', as_of_date) - interval '11 months - 1 day')::date
    ) AS prior_year_month_to
  FROM boundaries
), agent_metrics AS (
  SELECT
    o.agent_key,
    max(o.agent_id) AS agent_id,
    (array_agg(o.agent_name ORDER BY o.created_at DESC) FILTER (WHERE o.agent_name IS NOT NULL))[1] AS agent_name,
    (array_agg(o.agent_network ORDER BY o.created_at DESC) FILTER (WHERE o.agent_network IS NOT NULL))[1] AS agent_network,
    count(*) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_week_start AND w.as_of_date)::int AS cnf_current_week,
    count(*) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.previous_week_start AND w.current_week_start - 1)::int AS cnf_previous_week,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_week_start AND w.as_of_date), 0), 2) AS gmv_current_week_eur,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.previous_week_start AND w.current_week_start - 1), 0), 2) AS gmv_previous_week_eur,
    round(coalesce(sum(o.profit_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_week_start AND w.as_of_date), 0), 2) AS profit_current_week_eur,
    round(coalesce(sum(o.profit_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.previous_week_start AND w.current_week_start - 1), 0), 2) AS profit_previous_week_eur,
    count(*) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_month_start AND w.as_of_date)::int AS cnf_mtd,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_month_start AND w.as_of_date), 0), 2) AS gmv_mtd_eur,
    round(coalesce(sum(o.profit_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_month_start AND w.as_of_date), 0), 2) AS profit_mtd_eur,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.previous_month_start AND w.previous_month_to), 0), 2) AS gmv_previous_mtd_eur,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.prior_year_month_start AND w.prior_year_month_to), 0), 2) AS gmv_yoy_mtd_eur,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.as_of_date - 55 AND w.as_of_date), 0), 2) AS gmv_8w_eur,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.as_of_date - 111 AND w.as_of_date - 56), 0), 2) AS gmv_previous_8w_eur,
    max(o.created_date) FILTER (WHERE o.order_status = 'CNF') AS last_cnf_date
  FROM "mart_gto_ua_commercial_orders" o
  CROSS JOIN windows w
  GROUP BY o.agent_key
), latest_segment AS (
  SELECT DISTINCT ON (agent_key) *
  FROM "mart_gto_ua_agent_segment_snapshots"
  ORDER BY agent_key, snapshot_date DESC
)
SELECT
  w.as_of_date,
  m.agent_key,
  m.agent_id,
  m.agent_name,
  m.agent_network,
  m.cnf_current_week,
  m.cnf_previous_week,
  m.cnf_current_week - m.cnf_previous_week AS cnf_wow_delta,
  m.gmv_current_week_eur,
  m.gmv_previous_week_eur,
  round(m.gmv_current_week_eur - m.gmv_previous_week_eur, 2) AS gmv_wow_delta_eur,
  round(m.gmv_current_week_eur / nullif(m.gmv_previous_week_eur, 0) - 1, 8) AS gmv_wow_pct,
  m.profit_current_week_eur,
  m.profit_previous_week_eur,
  m.cnf_mtd,
  m.gmv_mtd_eur,
  m.profit_mtd_eur,
  m.gmv_previous_mtd_eur,
  round(m.gmv_mtd_eur - m.gmv_previous_mtd_eur, 2) AS gmv_mtd_delta_eur,
  round(m.gmv_mtd_eur / nullif(m.gmv_previous_mtd_eur, 0) - 1, 8) AS gmv_mtd_pct,
  m.gmv_yoy_mtd_eur,
  round(m.gmv_mtd_eur / nullif(m.gmv_yoy_mtd_eur, 0) - 1, 8) AS gmv_yoy_mtd_pct,
  m.gmv_8w_eur,
  m.gmv_previous_8w_eur,
  round(m.gmv_8w_eur / nullif(m.gmv_previous_8w_eur, 0) - 1, 8) AS gmv_8w_pct,
  m.last_cnf_date,
  s.segment,
  s.segment_rank,
  s.quality_overlay,
  s.commercial_overlay,
  s.booking_momentum,
  s.revenue_momentum,
  coalesce(s.is_growth_candidate, false) AS is_growth_candidate,
  coalesce(s.is_retention_risk, false) AS is_retention_risk,
  coalesce(s.is_stopped, false) AS is_stopped,
  coalesce(s.is_quality_risk, false) AS is_quality_risk
FROM agent_metrics m
CROSS JOIN windows w
LEFT JOIN latest_segment s ON s.agent_key = m.agent_key;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_product_destination" AS
SELECT
  created_date AS report_date,
  agent_key,
  max(agent_id) AS agent_id,
  (array_agg(agent_name ORDER BY created_at DESC) FILTER (WHERE agent_name IS NOT NULL))[1] AS agent_name,
  product_segment,
  destination_name,
  count(*)::int AS cnf_orders,
  coalesce(sum(tourists_count), 0)::int AS tourists,
  round(coalesce(sum(gmv_eur), 0), 2) AS gmv_eur,
  round(coalesce(sum(profit_eur), 0), 2) AS profit_eur,
  round(coalesce(sum(gmv_eur), 0) / nullif(count(*), 0), 2) AS avg_gmv_per_order
FROM "mart_gto_ua_commercial_orders"
WHERE order_status = 'CNF'
GROUP BY created_date, agent_key, product_segment, destination_name;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_gmv_drivers" AS
WITH weekly_agent AS (
  SELECT
    date_trunc('week', created_date)::date AS week_start,
    agent_key,
    count(*)::numeric AS cnf_orders,
    round(sum(gmv_eur), 2) AS gmv_eur,
    min(created_date) AS first_cnf_date_in_week,
    lag(max(created_date)) OVER (PARTITION BY agent_key ORDER BY date_trunc('week', created_date)::date) AS previous_active_date
  FROM "mart_gto_ua_commercial_orders"
  WHERE order_status = 'CNF'
  GROUP BY date_trunc('week', created_date)::date, agent_key
), weekly AS (
  SELECT
    week_start,
    count(*)::numeric AS active_agents,
    sum(cnf_orders) AS cnf_orders,
    round(sum(gmv_eur), 2) AS gmv_eur,
    count(*) FILTER (WHERE previous_active_date IS NULL)::int AS new_active_agents,
    count(*) FILTER (WHERE previous_active_date < week_start - 90)::int AS reactivated_agents
  FROM weekly_agent
  GROUP BY week_start
), enriched AS (
  SELECT
    current_week.*,
    previous_week.active_agents AS previous_active_agents,
    previous_week.cnf_orders AS previous_cnf_orders,
    previous_week.gmv_eur AS previous_gmv_eur,
    coalesce((
      SELECT count(*)
      FROM (
        SELECT agent_key, max(created_date) AS last_cnf_date
        FROM "mart_gto_ua_commercial_orders"
        WHERE order_status = 'CNF' AND created_date <= current_week.week_start - 1
        GROUP BY agent_key
      ) last_activity
      WHERE last_activity.last_cnf_date BETWEEN current_week.week_start - 96 AND current_week.week_start - 90
    ), 0)::int AS stopped_agents
  FROM weekly current_week
  LEFT JOIN weekly previous_week ON previous_week.week_start = current_week.week_start - 7
), metrics AS (
  SELECT
    *,
    cnf_orders / nullif(active_agents, 0) AS orders_per_active_agent,
    gmv_eur / nullif(cnf_orders, 0) AS avg_gmv_per_order,
    previous_cnf_orders / nullif(previous_active_agents, 0) AS previous_orders_per_active_agent,
    previous_gmv_eur / nullif(previous_cnf_orders, 0) AS previous_avg_gmv_per_order
  FROM enriched
)
SELECT
  week_start,
  week_start + 6 AS week_end,
  active_agents::int AS active_agents,
  previous_active_agents::int AS previous_active_agents,
  cnf_orders::int AS cnf_orders,
  previous_cnf_orders::int AS previous_cnf_orders,
  gmv_eur,
  previous_gmv_eur,
  round(gmv_eur - previous_gmv_eur, 2) AS gmv_wow_delta_eur,
  round(orders_per_active_agent, 8) AS orders_per_active_agent,
  round(previous_orders_per_active_agent, 8) AS previous_orders_per_active_agent,
  round(avg_gmv_per_order, 2) AS avg_gmv_per_order,
  round(previous_avg_gmv_per_order, 2) AS previous_avg_gmv_per_order,
  round((active_agents - previous_active_agents) * previous_orders_per_active_agent * previous_avg_gmv_per_order, 2) AS active_agent_base_effect_eur,
  round(active_agents * (orders_per_active_agent - previous_orders_per_active_agent) * previous_avg_gmv_per_order, 2) AS order_frequency_effect_eur,
  round(active_agents * orders_per_active_agent * (avg_gmv_per_order - previous_avg_gmv_per_order), 2) AS avg_check_effect_eur,
  new_active_agents,
  reactivated_agents,
  stopped_agents
FROM metrics;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'looker_studio_reader') THEN
    GRANT SELECT ON TABLE "mart_gto_ua_agent_performance_summary" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_performance_current" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_performance_product_destination" TO looker_studio_reader;
    GRANT SELECT ON TABLE "mart_gto_ua_agent_performance_gmv_drivers" TO looker_studio_reader;
  END IF;
END $$;
