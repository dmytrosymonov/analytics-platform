-- All agent-performance views use the latest fully completed Friday as their
-- anchor. A reporting week always starts on Saturday and ends on Friday.

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_summary" AS
WITH completed_day AS (
  SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1) AS value
), anchor AS (
  SELECT value - ((extract(dow FROM value)::int + 2) % 7) AS anchor_date
  FROM completed_day
), daily AS (
  SELECT
    o.created_date AS report_date,
    o.agent_key,
    max(o.agent_id) AS agent_id,
    (array_agg(o.agent_name ORDER BY o.created_at DESC) FILTER (WHERE o.agent_name IS NOT NULL))[1] AS agent_name,
    (array_agg(o.agent_network ORDER BY o.created_at DESC) FILTER (WHERE o.agent_network IS NOT NULL))[1] AS agent_network,
    count(*)::int AS attempted_orders,
    count(*) FILTER (WHERE o.order_status = 'CNF')::int AS cnf_orders,
    count(*) FILTER (WHERE o.order_status = 'CNX')::int AS cnx_orders,
    count(*) FILTER (WHERE o.order_status NOT IN ('CNF', 'CNX'))::int AS open_or_other_orders,
    coalesce(sum(o.tourists_count) FILTER (WHERE o.order_status = 'CNF'), 0)::int AS tourists_cnf,
    round(coalesce(sum(o.gmv_eur) FILTER (WHERE o.order_status = 'CNF'), 0), 2) AS gmv_eur,
    round(coalesce(sum(o.profit_eur) FILTER (WHERE o.order_status = 'CNF'), 0), 2) AS profit_eur
  FROM "mart_gto_ua_commercial_orders" o
  CROSS JOIN anchor a
  WHERE o.created_date <= a.anchor_date
  GROUP BY o.created_date, o.agent_key
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
    booking_momentum, revenue_momentum, is_growth_candidate, is_stable,
    is_retention_risk, is_stopped, is_quality_risk,
    is_high_value_potential, is_high_frequency_low_value,
    attempt_cnx_rate_90, package_cnf_90, package_share_90
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
WITH completed_day AS (
  SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1) AS value
), boundaries AS (
  SELECT
    value - ((extract(dow FROM value)::int + 2) % 7) AS as_of_date
  FROM completed_day
), windows AS (
  SELECT
    as_of_date,
    as_of_date - 6 AS current_week_start,
    as_of_date - 13 AS previous_week_start,
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
    max(o.created_date) FILTER (WHERE o.order_status = 'CNF') AS last_cnf_date,
    coalesce(sum(o.tourists_count) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_week_start AND w.as_of_date), 0)::int AS tourists_current_week,
    coalesce(sum(o.tourists_count) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.previous_week_start AND w.current_week_start - 1), 0)::int AS tourists_previous_week,
    coalesce(sum(o.tourists_count) FILTER (WHERE o.order_status = 'CNF' AND o.created_date BETWEEN w.current_month_start AND w.as_of_date), 0)::int AS tourists_mtd
  FROM "mart_gto_ua_commercial_orders" o
  CROSS JOIN windows w
  WHERE o.created_date <= w.as_of_date
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
  coalesce(s.is_quality_risk, false) AS is_quality_risk,
  m.tourists_current_week,
  m.tourists_previous_week,
  m.tourists_mtd,
  s.attempt_cnx_rate_90,
  s.package_cnf_90,
  s.package_share_90,
  coalesce(s.is_stable, false) AS is_stable,
  coalesce(s.is_high_value_potential, false) AS is_high_value_potential,
  coalesce(s.is_high_frequency_low_value, false) AS is_high_frequency_low_value
FROM agent_metrics m
CROSS JOIN windows w
LEFT JOIN latest_segment s ON s.agent_key = m.agent_key;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_product_destination" AS
WITH completed_day AS (
  SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1) AS value
), anchor AS (
  SELECT value - ((extract(dow FROM value)::int + 2) % 7) AS anchor_date
  FROM completed_day
), latest_segment AS (
  SELECT DISTINCT ON (agent_key) agent_key, segment, segment_rank
  FROM "mart_gto_ua_agent_segment_snapshots"
  ORDER BY agent_key, snapshot_date DESC
), daily AS (
  SELECT
    o.created_date AS report_date,
    o.agent_key,
    max(o.agent_id) AS agent_id,
    (array_agg(o.agent_name ORDER BY o.created_at DESC) FILTER (WHERE o.agent_name IS NOT NULL))[1] AS agent_name,
    (array_agg(o.agent_network ORDER BY o.created_at DESC) FILTER (WHERE o.agent_network IS NOT NULL))[1] AS agent_network,
    o.product_segment,
    o.destination_name,
    count(*)::int AS cnf_orders,
    coalesce(sum(o.tourists_count), 0)::int AS tourists,
    round(coalesce(sum(o.gmv_eur), 0), 2) AS gmv_eur,
    round(coalesce(sum(o.profit_eur), 0), 2) AS profit_eur
  FROM "mart_gto_ua_commercial_orders" o
  CROSS JOIN anchor a
  WHERE o.order_status = 'CNF'
    AND o.created_date <= a.anchor_date
  GROUP BY o.created_date, o.agent_key, o.product_segment, o.destination_name
)
SELECT
  d.report_date,
  d.agent_key,
  d.agent_id,
  d.agent_name,
  d.product_segment,
  d.destination_name,
  d.cnf_orders,
  d.tourists,
  d.gmv_eur,
  d.profit_eur,
  round(d.gmv_eur / nullif(d.cnf_orders, 0), 2) AS avg_gmv_per_order,
  d.agent_network,
  s.segment,
  s.segment_rank
FROM daily d
LEFT JOIN latest_segment s ON s.agent_key = d.agent_key;

CREATE OR REPLACE VIEW "mart_gto_ua_agent_performance_gmv_drivers" AS
WITH completed_day AS (
  SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date - 1) AS value
), anchor AS (
  SELECT value - ((extract(dow FROM value)::int + 2) % 7) AS anchor_date
  FROM completed_day
), weekly_agent AS (
  SELECT
    (o.created_date - ((extract(dow FROM o.created_date)::int + 1) % 7)) AS week_start,
    o.agent_key,
    count(*)::numeric AS cnf_orders,
    round(sum(o.gmv_eur), 2) AS gmv_eur,
    lag(max(o.created_date)) OVER (
      PARTITION BY o.agent_key
      ORDER BY o.created_date - ((extract(dow FROM o.created_date)::int + 1) % 7)
    ) AS previous_active_date
  FROM "mart_gto_ua_commercial_orders" o
  CROSS JOIN anchor a
  WHERE o.order_status = 'CNF'
    AND o.created_date <= a.anchor_date
  GROUP BY o.created_date - ((extract(dow FROM o.created_date)::int + 1) % 7), o.agent_key
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
