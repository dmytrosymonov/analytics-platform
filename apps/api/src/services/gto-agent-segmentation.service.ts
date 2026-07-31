import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export const GTO_AGENT_SEGMENT_LOGIC_VERSION = 1;
export const GTO_AGENT_SEGMENT_HISTORY_START = '2025-01-01';
const KYIV_TIMEZONE = 'Europe/Kyiv';

let refreshInFlight = false;

type RefreshOptions = {
  from?: string;
  to?: string;
  snapshotDate?: string;
  dryRun?: boolean;
  processDirty?: boolean;
  triggeredBy?: string;
};

type RefreshResult = {
  runId?: string;
  dryRun: boolean;
  snapshotDateFrom: string;
  snapshotDateTo: string;
  snapshotsRefreshed: number;
  agentsRefreshed: number;
  unknownIdentityOrders: number;
  dirtyRangesProcessed: number;
};

function assertDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function daysBetween(from: string, to: string) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function kyivDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return addDays(`${byType.year}-${byType.month}-${byType.day}`, offsetDays);
}

function completedFriday(snapshotDate: string) {
  const day = new Date(`${snapshotDate}T00:00:00Z`).getUTCDay();
  return day === 5;
}

function resolveWindow(options: RefreshOptions) {
  const yesterday = kyivDate(-1);
  const from = options.snapshotDate || options.from || yesterday;
  const to = options.snapshotDate || options.to || from;
  assertDate(from, 'from');
  assertDate(to, 'to');
  if (from > to) throw new Error('from must not be after to');
  if (from < GTO_AGENT_SEGMENT_HISTORY_START) {
    throw new Error(`Snapshots before ${GTO_AGENT_SEGMENT_HISTORY_START} are unsupported because the preceding 365-day source history is incomplete`);
  }
  if (to > yesterday) throw new Error(`snapshot date must not be after the latest completed Kyiv day (${yesterday})`);
  return { from, to };
}

function snapshotSql(snapshotDate: string) {
  const windowFrom = addDays(snapshotDate, -364);
  const window90From = addDays(snapshotDate, -89);
  const active7From = addDays(snapshotDate, -6);
  const monthFrom = `${snapshotDate.slice(0, 7)}-01`;

  return `
WITH base_orders AS (
  SELECT
    o.*,
    lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) AS normalized_agent_name,
    CASE
      WHEN nullif(btrim(coalesce(o.agent_id, '')), '') IS NOT NULL THEN 'agent:' || btrim(o.agent_id)
      WHEN nullif(btrim(coalesce(o.agent_name, '')), '') IS NOT NULL THEN 'name:' || lower(regexp_replace(btrim(o.agent_name), '\\s+', ' ', 'g'))
      ELSE NULL
    END AS agent_key,
    CASE
      WHEN nullif(btrim(coalesce(o.agent_id, '')), '') IS NOT NULL THEN 'stable_id'
      WHEN nullif(btrim(coalesce(o.agent_name, '')), '') IS NOT NULL THEN 'name_fallback'
      ELSE 'missing'
    END AS identity_confidence,
    (o.created_at AT TIME ZONE '${KYIV_TIMEZONE}')::date AS created_date
  FROM reporting_gto_orders o
  LEFT JOIN LATERAL (
    SELECT s.is_commercial
    FROM reporting_gto_agent_scope_overrides s
    WHERE s.is_active
      AND (
        (s.agent_id IS NOT NULL AND s.agent_id = nullif(btrim(coalesce(o.agent_id, '')), ''))
        OR (s.agent_id IS NULL AND s.normalized_agent_name = lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')))
      )
    ORDER BY CASE WHEN s.agent_id IS NOT NULL THEN 0 ELSE 1 END
    LIMIT 1
  ) scope_override ON true
  WHERE lower(btrim(coalesce(o.structure_name, ''))) = 'gto.ua'
    AND (o.created_at AT TIME ZONE '${KYIV_TIMEZONE}')::date BETWEEN DATE '${windowFrom}' AND DATE '${snapshotDate}'
    AND upper(btrim(coalesce(o.order_status, ''))) IN ('CNF', 'CNX')
    AND coalesce(
      scope_override.is_commercial,
      NOT (
        lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) IN ('gto.ua', 'gto для внутрішнього користування', 'testagency')
        OR lower(regexp_replace(btrim(coalesce(o.agent_name, '')), '\\s+', ' ', 'g')) LIKE '%test%'
      )
    )
), eligible_orders AS (
  SELECT * FROM base_orders WHERE agent_key IS NOT NULL
), metrics AS (
  SELECT
    agent_key,
    max(agent_id) FILTER (WHERE nullif(btrim(coalesce(agent_id, '')), '') IS NOT NULL) AS agent_id,
    (array_agg(agent_name ORDER BY created_at DESC) FILTER (WHERE nullif(btrim(coalesce(agent_name, '')), '') IS NOT NULL))[1] AS agent_name,
    (array_agg(agent_network ORDER BY created_at DESC) FILTER (WHERE nullif(btrim(coalesce(agent_network, '')), '') IS NOT NULL))[1] AS agent_network,
    max(identity_confidence) AS identity_confidence,
    count(*) FILTER (WHERE upper(btrim(order_status)) = 'CNF')::int AS cnf_365,
    coalesce(sum(coalesce(balance_amount_eur, total_amount_eur, 0)) FILTER (WHERE upper(btrim(order_status)) = 'CNF'), 0) AS gmv_eur_365,
    count(*) FILTER (WHERE upper(btrim(order_status)) = 'CNF' AND created_date >= DATE '${window90From}')::int AS cnf_90,
    coalesce(sum(coalesce(balance_amount_eur, total_amount_eur, 0)) FILTER (WHERE upper(btrim(order_status)) = 'CNF' AND created_date >= DATE '${window90From}'), 0) AS gmv_eur_90,
    count(*) FILTER (WHERE upper(btrim(order_status)) = 'CNX' AND created_date >= DATE '${window90From}')::int AS cnx_90,
    count(*) FILTER (WHERE created_date >= DATE '${window90From}')::int AS attempts_90,
    count(*) FILTER (WHERE upper(btrim(order_status)) = 'CNF' AND created_date >= DATE '${window90From}' AND product_segment = 'Package')::int AS package_cnf_90,
    max(created_date) FILTER (WHERE upper(btrim(order_status)) = 'CNF') AS last_cnf_date,
    coalesce(bool_or(upper(btrim(order_status)) = 'CNF' AND created_date >= DATE '${active7From}'), false) AS is_active_7d,
    coalesce(bool_or(upper(btrim(order_status)) = 'CNF' AND created_date >= DATE '${monthFrom}'), false) AS is_active_mtd
  FROM eligible_orders
  GROUP BY agent_key
), shares AS (
  SELECT
    metrics.*,
    sum(cnf_365) OVER () AS total_cnf_365,
    sum(gmv_eur_365) OVER () AS total_gmv_eur_365,
    sum(cnf_90) OVER () AS total_cnf_90,
    sum(gmv_eur_90) OVER () AS total_gmv_eur_90
  FROM metrics
), calculated AS (
  SELECT
    *,
    cnf_365::numeric / nullif(total_cnf_365, 0) AS cnf_share_365,
    gmv_eur_365 / nullif(total_gmv_eur_365, 0) AS gmv_share_365,
    cnf_90::numeric / nullif(total_cnf_90, 0) AS cnf_share_90,
    gmv_eur_90 / nullif(total_gmv_eur_90, 0) AS gmv_share_90
  FROM shares
), final_rows AS (
  SELECT
    *,
    cnf_share_90 / nullif(cnf_share_365, 0) AS booking_momentum,
    gmv_share_90 / nullif(gmv_share_365, 0) AS revenue_momentum,
    cnx_90::numeric / nullif(attempts_90, 0) AS attempt_cnx_rate_90,
    package_cnf_90::numeric / nullif(cnf_90, 0) AS package_share_90,
    gmv_eur_90 / nullif(cnf_90, 0) AS avg_gmv_per_cnf_90
  FROM calculated
)
INSERT INTO mart_gto_ua_agent_segment_snapshots (
  snapshot_date, agent_key, agent_id, agent_name, agent_network, identity_confidence, market,
  segment, segment_rank, cnf_365, gmv_eur_365, cnf_share_365, gmv_share_365,
  cnf_90, gmv_eur_90, cnf_share_90, gmv_share_90, booking_momentum, revenue_momentum,
  cnx_90, attempt_cnx_rate_90, package_cnf_90, package_share_90, avg_gmv_per_cnf_90,
  last_cnf_date, is_active_7d, is_active_mtd, is_growth_candidate, is_stable,
  is_losing_momentum, is_retention_risk, is_stopped, is_high_value_potential,
  is_high_frequency_low_value, is_quality_risk, quality_overlay, commercial_overlay,
  included_in_base, data_quality_flag, logic_version, refresh_timestamp
)
SELECT
  DATE '${snapshotDate}', agent_key, agent_id, agent_name, agent_network, identity_confidence, 'GTO.UA',
  CASE
    WHEN cnf_365 >= 100 AND gmv_share_365 >= 0.0089 THEN 'Flagships'
    WHEN cnf_365 >= 31 AND gmv_share_365 >= 0.0028 THEN 'Key Accounts'
    WHEN cnf_365 >= 11 AND gmv_share_365 >= 0.0010 THEN 'Risers'
    WHEN cnf_365 >= 4 THEN 'Sprouts'
    WHEN cnf_365 BETWEEN 2 AND 3 THEN 'Dippers'
    WHEN cnf_365 = 1 THEN 'One-Timers'
    ELSE 'Ghosts'
  END,
  CASE
    WHEN cnf_365 >= 100 AND gmv_share_365 >= 0.0089 THEN 1
    WHEN cnf_365 >= 31 AND gmv_share_365 >= 0.0028 THEN 2
    WHEN cnf_365 >= 11 AND gmv_share_365 >= 0.0010 THEN 3
    WHEN cnf_365 >= 4 THEN 4
    WHEN cnf_365 BETWEEN 2 AND 3 THEN 5
    WHEN cnf_365 = 1 THEN 6
    ELSE 7
  END,
  cnf_365, round(gmv_eur_365, 2), cnf_share_365, gmv_share_365,
  cnf_90, round(gmv_eur_90, 2), cnf_share_90, gmv_share_90, booking_momentum, revenue_momentum,
  cnx_90, attempt_cnx_rate_90, package_cnf_90, package_share_90, round(avg_gmv_per_cnf_90, 2),
  last_cnf_date, is_active_7d, is_active_mtd,
  coalesce(cnf_365 >= 4 AND cnf_90 >= 4 AND (booking_momentum > 1.30 OR revenue_momentum > 1.30), false),
  coalesce(booking_momentum BETWEEN 0.85 AND 1.30 AND revenue_momentum BETWEEN 0.85 AND 1.30, false),
  coalesce((booking_momentum < 0.85 OR revenue_momentum < 0.85) AND cnf_90 > 0, false),
  coalesce(cnf_365 >= 11 AND (cnf_90 = 0 OR booking_momentum < 0.65 OR revenue_momentum < 0.65), false),
  coalesce(cnf_365 > 0 AND cnf_90 = 0, false),
  coalesce(cnf_share_365 IS NOT NULL AND gmv_share_365 > cnf_share_365 * 1.30, false),
  coalesce(gmv_share_365 IS NOT NULL AND cnf_share_365 > gmv_share_365 * 1.30, false),
  coalesce(cnf_365 >= 4 AND attempts_90 >= 10 AND attempt_cnx_rate_90 >= 0.30, false),
  CASE
    WHEN attempts_90 < 10 THEN 'Insufficient volume'
    WHEN cnf_365 >= 4 AND attempt_cnx_rate_90 >= 0.30 THEN 'Quality Risk'
    WHEN cnx_90 > 0 THEN 'Watch CNX'
    ELSE 'Healthy'
  END,
  nullif(concat_ws(' | ',
    CASE WHEN cnf_365 >= 4 AND cnf_90 >= 4 AND (booking_momentum > 1.30 OR revenue_momentum > 1.30) THEN 'Growth Candidate' END,
    CASE WHEN cnf_365 >= 11 AND (cnf_90 = 0 OR booking_momentum < 0.65 OR revenue_momentum < 0.65) THEN 'Retention Risk' END,
    CASE WHEN cnf_365 > 0 AND cnf_90 = 0 THEN 'Stopped / No 90d CNF' END,
    CASE WHEN cnf_share_365 IS NOT NULL AND gmv_share_365 > cnf_share_365 * 1.30 THEN 'High Value Potential' END,
    CASE WHEN gmv_share_365 IS NOT NULL AND cnf_share_365 > gmv_share_365 * 1.30 THEN 'High Frequency / Low Value' END
  ), ''),
  true,
  CASE WHEN identity_confidence = 'name_fallback' THEN 'identity_fallback' ELSE NULL END,
  ${GTO_AGENT_SEGMENT_LOGIC_VERSION}, CURRENT_TIMESTAMP
FROM final_rows;
`;
}

function summarySql(snapshotDate: string) {
  return `
INSERT INTO mart_gto_ua_segment_daily_summary (
  snapshot_date, segment, segment_rank, agents, cnf_365, gmv_eur_365, cnf_90, gmv_eur_90, package_cnf_90, cnx_90, refresh_timestamp
)
SELECT snapshot_date, segment, segment_rank, count(*)::int, sum(cnf_365)::int, round(sum(gmv_eur_365), 2),
       sum(cnf_90)::int, round(sum(gmv_eur_90), 2), sum(package_cnf_90)::int, sum(cnx_90)::int, CURRENT_TIMESTAMP
FROM mart_gto_ua_agent_segment_snapshots
WHERE snapshot_date = DATE '${snapshotDate}'
GROUP BY snapshot_date, segment, segment_rank;
`;
}

function changesSql(previousFriday: string, friday: string) {
  return `
INSERT INTO mart_gto_ua_agent_segment_changes (
  from_snapshot_date, to_snapshot_date, agent_key, agent_name, from_segment, to_segment,
  from_rank, to_rank, rank_delta, transition_type, cnf_365_from, cnf_365_to,
  gmv_eur_365_from, gmv_eur_365_to, gmv_share_365_from, gmv_share_365_to,
  booking_momentum_to, revenue_momentum_to, quality_overlay_to, primary_driver_label, refresh_timestamp
)
SELECT
  DATE '${previousFriday}', DATE '${friday}', coalesce(previous.agent_key, current.agent_key),
  coalesce(current.agent_name, previous.agent_name), previous.segment, current.segment,
  previous.segment_rank, current.segment_rank,
  current.segment_rank - previous.segment_rank,
  CASE
    WHEN previous.agent_key IS NULL THEN 'New'
    WHEN current.agent_key IS NULL THEN 'Dropped'
    WHEN current.segment_rank < previous.segment_rank THEN 'Upgrade'
    WHEN current.segment_rank > previous.segment_rank THEN 'Downgrade'
    ELSE 'Same'
  END,
  previous.cnf_365, current.cnf_365, previous.gmv_eur_365, current.gmv_eur_365,
  previous.gmv_share_365, current.gmv_share_365, current.booking_momentum,
  current.revenue_momentum, current.quality_overlay,
  CASE
    WHEN previous.agent_key IS NULL THEN 'new activity'
    WHEN current.agent_key IS NULL THEN 'rolling-window exit'
    WHEN current.cnf_365 <> previous.cnf_365 THEN 'CNF threshold'
    WHEN current.gmv_share_365 IS DISTINCT FROM previous.gmv_share_365 THEN 'GMV share threshold'
    ELSE NULL
  END,
  CURRENT_TIMESTAMP
FROM mart_gto_ua_agent_segment_snapshots previous
FULL OUTER JOIN mart_gto_ua_agent_segment_snapshots current
  ON previous.agent_key = current.agent_key
  AND current.snapshot_date = DATE '${friday}'
WHERE previous.snapshot_date = DATE '${previousFriday}';
`;
}

async function countUnknownIdentityOrders(snapshotDate: string) {
  const windowFrom = addDays(snapshotDate, -364);
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
    SELECT count(*)::bigint AS count
    FROM reporting_gto_orders o
    WHERE lower(btrim(coalesce(o.structure_name, ''))) = 'gto.ua'
      AND upper(btrim(coalesce(o.order_status, ''))) IN ('CNF', 'CNX')
      AND (o.created_at AT TIME ZONE '${KYIV_TIMEZONE}')::date BETWEEN DATE '${windowFrom}' AND DATE '${snapshotDate}'
      AND nullif(btrim(coalesce(o.agent_id, '')), '') IS NULL
      AND nullif(btrim(coalesce(o.agent_name, '')), '') IS NULL;
  `);
  return Number(rows[0]?.count || 0);
}

async function refreshSnapshot(snapshotDate: string, dryRun: boolean) {
  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe<Array<{ agents: bigint }>>(snapshotSql(snapshotDate).replace(/INSERT INTO[\s\S]*$/, 'SELECT count(*)::bigint AS agents FROM final_rows;'));
    return { agents: Number(rows[0]?.agents || 0), unknownIdentityOrders: await countUnknownIdentityOrders(snapshotDate) };
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM mart_gto_ua_segment_daily_summary WHERE snapshot_date = DATE '${snapshotDate}'`);
    await tx.$executeRawUnsafe(`DELETE FROM mart_gto_ua_agent_segment_snapshots WHERE snapshot_date = DATE '${snapshotDate}'`);
    await tx.$executeRawUnsafe(snapshotSql(snapshotDate));
    await tx.$executeRawUnsafe(summarySql(snapshotDate));

    if (completedFriday(snapshotDate)) {
      const previousFriday = addDays(snapshotDate, -7);
      await tx.$executeRawUnsafe(`DELETE FROM mart_gto_ua_agent_segment_changes WHERE to_snapshot_date = DATE '${snapshotDate}'`);
      const previousCount = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM mart_gto_ua_agent_segment_snapshots WHERE snapshot_date = DATE '${previousFriday}'`,
      );
      if (Number(previousCount[0]?.count || 0) > 0) await tx.$executeRawUnsafe(changesSql(previousFriday, snapshotDate));
    }
  });

  const rows = await prisma.$queryRawUnsafe<Array<{ agents: bigint }>>(
    `SELECT count(*)::bigint AS agents FROM mart_gto_ua_agent_segment_snapshots WHERE snapshot_date = DATE '${snapshotDate}'`,
  );
  return { agents: Number(rows[0]?.agents || 0), unknownIdentityOrders: await countUnknownIdentityOrders(snapshotDate) };
}

async function pendingDirtyRanges() {
  return prisma.$queryRawUnsafe<Array<{ id: string; snapshot_date_from: Date; snapshot_date_to: Date }>>(
    'SELECT id, snapshot_date_from, snapshot_date_to FROM mart_gto_ua_agent_segment_dirty_ranges WHERE resolved_at IS NULL ORDER BY snapshot_date_from ASC',
  );
}

export async function markGtoAgentSegmentDirtyRange(createdAt: Date, reason: string) {
  const createdDate = dateKey(createdAt);
  const from = createdDate > GTO_AGENT_SEGMENT_HISTORY_START ? createdDate : GTO_AGENT_SEGMENT_HISTORY_START;
  const to = addDays(createdDate, 364);
  const latest = kyivDate(-1);
  if (from > latest) return;
  const cappedTo = to < latest ? to : latest;
  if (from > cappedTo) return;
  await prisma.$executeRaw(
    Prisma.sql`INSERT INTO mart_gto_ua_agent_segment_dirty_ranges (id, snapshot_date_from, snapshot_date_to, reason)
      VALUES (${crypto.randomUUID()}, ${new Date(`${from}T00:00:00.000Z`)}, ${new Date(`${cappedTo}T00:00:00.000Z`)}, ${reason})`,
  );
}

export async function refreshGtoAgentSegments(options: RefreshOptions = {}): Promise<RefreshResult> {
  if (refreshInFlight) throw new Error('GTO agent segmentation refresh is already running');
  refreshInFlight = true;

  const baseWindow = resolveWindow(options);
  const dates = new Set<string>();
  for (let day = baseWindow.from; day <= baseWindow.to; day = addDays(day, 1)) dates.add(day);

  let dirtyRanges: Array<{ id: string; snapshot_date_from: Date; snapshot_date_to: Date }> = [];
  if (options.processDirty) {
    dirtyRanges = await pendingDirtyRanges();
    for (const dirty of dirtyRanges) {
      const from = dateKey(dirty.snapshot_date_from);
      const to = dateKey(dirty.snapshot_date_to);
      for (let day = from < GTO_AGENT_SEGMENT_HISTORY_START ? GTO_AGENT_SEGMENT_HISTORY_START : from; day <= to; day = addDays(day, 1)) {
        dates.add(day);
      }
    }
  }

  const allDates = Array.from(dates).sort();
  const run = options.dryRun ? null : await prisma.martGtoUaAgentSegmentRun.create({
    data: {
      status: 'running',
      snapshotDateFrom: new Date(`${allDates[0]}T00:00:00.000Z`),
      snapshotDateTo: new Date(`${allDates[allDates.length - 1]}T00:00:00.000Z`),
      triggeredBy: options.triggeredBy || 'manual',
    },
  });

  let agentsRefreshed = 0;
  let unknownIdentityOrders = 0;
  try {
    for (const snapshotDate of allDates) {
      const result = await refreshSnapshot(snapshotDate, Boolean(options.dryRun));
      agentsRefreshed += result.agents;
      unknownIdentityOrders += result.unknownIdentityOrders;
    }

    if (!options.dryRun && dirtyRanges.length) {
      await prisma.martGtoUaAgentSegmentDirtyRange.updateMany({
        where: { id: { in: dirtyRanges.map((row) => row.id) } },
        data: { resolvedAt: new Date() },
      });
    }

    if (run) {
      await prisma.martGtoUaAgentSegmentRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          snapshotsRefreshed: allDates.length,
          agentsRefreshed,
          unknownIdentityOrders,
          warnings: unknownIdentityOrders ? { unknownIdentityOrders } : undefined,
          finishedAt: new Date(),
        },
      });
    }

    return {
      runId: run?.id,
      dryRun: Boolean(options.dryRun),
      snapshotDateFrom: allDates[0],
      snapshotDateTo: allDates[allDates.length - 1],
      snapshotsRefreshed: allDates.length,
      agentsRefreshed,
      unknownIdentityOrders,
      dirtyRangesProcessed: dirtyRanges.length,
    };
  } catch (error: any) {
    if (run) {
      await prisma.martGtoUaAgentSegmentRun.update({
        where: { id: run.id },
        data: { status: 'failed', errorMessage: error?.message || String(error), finishedAt: new Date() },
      });
    }
    throw error;
  } finally {
    refreshInFlight = false;
  }
}

export async function getGtoAgentSegmentStatus() {
  const [lastRun, currentSnapshot] = await Promise.all([
    prisma.martGtoUaAgentSegmentRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.martGtoUaAgentSegmentSnapshot.findFirst({ orderBy: { snapshotDate: 'desc' }, select: { snapshotDate: true } }),
  ]);
  return { inFlight: refreshInFlight, lastRun, currentSnapshotDate: currentSnapshot ? dateKey(currentSnapshot.snapshotDate) : null };
}

export async function refreshYesterdayGtoAgentSegments(triggeredBy = 'scheduler') {
  return refreshGtoAgentSegments({ snapshotDate: kyivDate(-1), processDirty: true, triggeredBy });
}

export function getGtoAgentSegmentHistoryStart() {
  return GTO_AGENT_SEGMENT_HISTORY_START;
}

export function getGtoAgentSegmentLatestCompletedDate() {
  return kyivDate(-1);
}

export function segmentDateRangeDays(from: string, to: string) {
  return daysBetween(from, to) + 1;
}
