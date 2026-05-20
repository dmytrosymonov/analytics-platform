import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { previewGtoLookerOrders } from '../services/gto-looker-sync.service';

type DailyTruth = {
  date: string;
  pax: number;
  totalSalesEur: number;
  profitEur: number;
};

type OrderTruth = {
  orderId: number;
  expectedRealIncomeEur: number;
  exclude?: boolean;
};

type ReportingOrder = {
  orderId: bigint;
  createdAt: Date;
  orderStatus: string;
  structureName: string | null;
  touristsCount: number;
  totalAmountEur: unknown;
  costAmountEur: unknown;
  profitEur: unknown;
  accountingClass: string | null;
  profitBasisUsed: string | null;
  costBasisUsed: string | null;
  hasIncompleteCoreCost: boolean;
};

type SliceCandidate = {
  key: string;
  label: string;
  structureNames?: Array<string | null>;
  statuses: string[];
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readFlag(name: string) {
  return process.argv.includes(`--${name}`) || readArg(name) === 'true' || readArg(name) === '1';
}

function decimalToNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as any).toNumber === 'function') {
    return (value as any).toNumber();
  }
  return Number(value) || 0;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function pct(delta: number, base: number) {
  if (!base) return delta === 0 ? 0 : 9999;
  return round2((delta / base) * 100);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeStructure(value: string | null) {
  const text = String(value || '').trim();
  return text || null;
}

function loadTruthRows(filePath: string, dateFrom?: string, dateTo?: string) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DailyTruth[];
  return raw.filter((row) => {
    if (dateFrom && row.date < dateFrom) return false;
    if (dateTo && row.date > dateTo) return false;
    return true;
  });
}

function loadOrderTruthRows(filePath: string) {
  if (!fs.existsSync(filePath)) return [] as OrderTruth[];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
  return raw
    .map((row) => ({
      orderId: Number(row.orderId),
      expectedRealIncomeEur: Number(row.expectedRealIncomeEur),
      exclude: Boolean(row.exclude),
    }))
    .filter((row) => Number.isFinite(row.orderId) && Number.isFinite(row.expectedRealIncomeEur) && !row.exclude);
}

function belongsToSlice(row: ReportingOrder, candidate: SliceCandidate) {
  const status = String(row.orderStatus || '').toUpperCase();
  if (!candidate.statuses.includes(status)) return false;
  if (!candidate.structureNames) return true;
  const structureName = normalizeStructure(row.structureName);
  return candidate.structureNames.some((allowed) => normalizeStructure(allowed) === structureName);
}

function aggregateRows(rows: ReportingOrder[]) {
  return rows.reduce((acc, row) => {
    acc.orders += 1;
    acc.pax += Number(row.touristsCount || 0);
    acc.totalSalesEur += decimalToNumber(row.totalAmountEur);
    acc.profitEur += decimalToNumber(row.profitEur);
    return acc;
  }, { orders: 0, pax: 0, totalSalesEur: 0, profitEur: 0 });
}

function summarizeCandidate(truthRows: DailyTruth[], orders: ReportingOrder[], candidate: SliceCandidate) {
  const daily = truthRows.map((truth) => {
    const rows = orders.filter((row) => dateKey(row.createdAt) === truth.date && belongsToSlice(row, candidate));
    const actual = aggregateRows(rows);
    const paxDelta = actual.pax - truth.pax;
    const totalSalesDelta = actual.totalSalesEur - truth.totalSalesEur;
    const profitDelta = actual.profitEur - truth.profitEur;
    return {
      date: truth.date,
      truthPax: truth.pax,
      reportingPax: actual.pax,
      paxDelta: round2(paxDelta),
      paxDeltaPct: pct(paxDelta, truth.pax),
      truthTotalSalesEur: truth.totalSalesEur,
      reportingTotalSalesEur: round2(actual.totalSalesEur),
      totalSalesDeltaEur: round2(totalSalesDelta),
      totalSalesDeltaPct: pct(totalSalesDelta, truth.totalSalesEur),
      truthProfitEur: truth.profitEur,
      reportingProfitEur: round2(actual.profitEur),
      profitDeltaEur: round2(profitDelta),
      profitDeltaPct: pct(profitDelta, truth.profitEur),
    };
  });

  const totals = daily.reduce((acc, row) => {
    acc.truthPax += row.truthPax;
    acc.reportingPax += row.reportingPax;
    acc.truthTotalSalesEur += row.truthTotalSalesEur;
    acc.reportingTotalSalesEur += row.reportingTotalSalesEur;
    acc.truthProfitEur += row.truthProfitEur;
    acc.reportingProfitEur += row.reportingProfitEur;
    return acc;
  }, {
    truthPax: 0,
    reportingPax: 0,
    truthTotalSalesEur: 0,
    reportingTotalSalesEur: 0,
    truthProfitEur: 0,
    reportingProfitEur: 0,
  });

  const paxDelta = totals.reportingPax - totals.truthPax;
  const totalSalesDelta = totals.reportingTotalSalesEur - totals.truthTotalSalesEur;
  const profitDelta = totals.reportingProfitEur - totals.truthProfitEur;
  const aggregate = {
    truthPax: totals.truthPax,
    reportingPax: totals.reportingPax,
    paxDelta: round2(paxDelta),
    paxDeltaPct: pct(paxDelta, totals.truthPax),
    truthTotalSalesEur: round2(totals.truthTotalSalesEur),
    reportingTotalSalesEur: round2(totals.reportingTotalSalesEur),
    totalSalesDeltaEur: round2(totalSalesDelta),
    totalSalesDeltaPct: pct(totalSalesDelta, totals.truthTotalSalesEur),
    truthProfitEur: round2(totals.truthProfitEur),
    reportingProfitEur: round2(totals.reportingProfitEur),
    profitDeltaEur: round2(profitDelta),
    profitDeltaPct: pct(profitDelta, totals.truthProfitEur),
  };

  return {
    key: candidate.key,
    label: candidate.label,
    aggregate,
    gatePassed: Math.abs(aggregate.paxDeltaPct) <= 2 && Math.abs(aggregate.totalSalesDeltaPct) <= 3,
    daily,
  };
}

function topContributors(truthRows: DailyTruth[], orders: ReportingOrder[], candidate: SliceCandidate) {
  const highDeltaDates = new Set(truthRows.map((row) => row.date));
  return orders
    .filter((row) => highDeltaDates.has(dateKey(row.createdAt)) && belongsToSlice(row, candidate))
    .sort((left, right) => decimalToNumber(right.profitEur) - decimalToNumber(left.profitEur))
    .slice(0, 60)
    .map((row) => ({
      orderId: Number(row.orderId),
      date: dateKey(row.createdAt),
      structureName: normalizeStructure(row.structureName),
      orderStatus: row.orderStatus,
      totalAmountEur: round2(decimalToNumber(row.totalAmountEur)),
      costAmountEur: round2(decimalToNumber(row.costAmountEur)),
      profitEur: round2(decimalToNumber(row.profitEur)),
      accountingClass: row.accountingClass,
      profitBasisUsed: row.profitBasisUsed,
      costBasisUsed: row.costBasisUsed,
      hasIncompleteCoreCost: row.hasIncompleteCoreCost,
    }));
}

function compareProfitRows(
  currentRows: ReportingOrder[],
  proposedRows: ReportingOrder[],
  candidate: SliceCandidate,
  limit = 100,
) {
  const currentByOrderId = new Map(currentRows.map((row) => [Number(row.orderId), row]));
  return proposedRows
    .filter((row) => belongsToSlice(row, candidate))
    .map((proposed) => {
      const orderId = Number(proposed.orderId);
      const current = currentByOrderId.get(orderId);
      const currentProfitEur = decimalToNumber(current?.profitEur);
      const proposedProfitEur = decimalToNumber(proposed.profitEur);
      return {
        orderId,
        date: dateKey(proposed.createdAt),
        structureName: normalizeStructure(proposed.structureName),
        orderStatus: proposed.orderStatus,
        totalAmountEur: round2(decimalToNumber(proposed.totalAmountEur)),
        currentCostAmountEur: round2(decimalToNumber(current?.costAmountEur)),
        proposedCostAmountEur: round2(decimalToNumber(proposed.costAmountEur)),
        currentProfitEur: round2(currentProfitEur),
        proposedProfitEur: round2(proposedProfitEur),
        profitDeltaEur: round2(proposedProfitEur - currentProfitEur),
        currentAccountingClass: current?.accountingClass || null,
        proposedAccountingClass: proposed.accountingClass,
        currentProfitBasisUsed: current?.profitBasisUsed || null,
        proposedProfitBasisUsed: proposed.profitBasisUsed,
        currentCostBasisUsed: current?.costBasisUsed || null,
        proposedCostBasisUsed: proposed.costBasisUsed,
        currentHasIncompleteCoreCost: current?.hasIncompleteCoreCost || false,
        proposedHasIncompleteCoreCost: proposed.hasIncompleteCoreCost,
      };
    })
    .filter((row) => Math.abs(row.profitDeltaEur) >= 0.01)
    .sort((left, right) => Math.abs(right.profitDeltaEur) - Math.abs(left.profitDeltaEur))
    .slice(0, limit);
}

function selectedDailyWhatIf(
  truthRows: DailyTruth[],
  currentRows: ReportingOrder[],
  proposedRows: ReportingOrder[],
  candidate: SliceCandidate,
) {
  return truthRows.map((truth) => {
    const current = aggregateRows(currentRows.filter((row) => dateKey(row.createdAt) === truth.date && belongsToSlice(row, candidate)));
    const proposed = aggregateRows(proposedRows.filter((row) => dateKey(row.createdAt) === truth.date && belongsToSlice(row, candidate)));
    const currentDelta = current.profitEur - truth.profitEur;
    const proposedDelta = proposed.profitEur - truth.profitEur;
    return {
      date: truth.date,
      truthProfitEur: truth.profitEur,
      currentProfitEur: round2(current.profitEur),
      proposedProfitEur: round2(proposed.profitEur),
      currentDeltaEur: round2(currentDelta),
      currentDeltaPct: pct(currentDelta, truth.profitEur),
      proposedDeltaEur: round2(proposedDelta),
      proposedDeltaPct: pct(proposedDelta, truth.profitEur),
      improvementEur: round2(Math.abs(currentDelta) - Math.abs(proposedDelta)),
      currentTotalSalesEur: round2(current.totalSalesEur),
      proposedTotalSalesEur: round2(proposed.totalSalesEur),
      totalSalesChangedEur: round2(proposed.totalSalesEur - current.totalSalesEur),
    };
  });
}

function isCloseToOrderTruth(change: any, orderTruthMap: Map<number, OrderTruth>) {
  const truth = orderTruthMap.get(Number(change.orderId));
  if (!truth) return false;
  const deltaEur = Math.abs(Number(change.proposedProfitEur) - truth.expectedRealIncomeEur);
  const deltaPct = truth.expectedRealIncomeEur
    ? (deltaEur / Math.abs(truth.expectedRealIncomeEur)) * 100
    : (deltaEur === 0 ? 0 : 9999);
  return deltaEur <= 2 || deltaPct <= 3;
}

function buildWhatIfAcceptance(aggregateImpact: any, dailyRows: any[], changedOrders: any[], orderTruthRows: OrderTruth[]) {
  const orderTruthMap = new Map(orderTruthRows.map((row) => [row.orderId, row]));
  const rawDailyRegressions = dailyRows.filter((row) =>
    Math.abs(row.currentDeltaPct) <= 5 && Math.abs(row.proposedDeltaPct) > 5,
  );
  const sourceDataChangedRegressions = [];
  const orderTruthExplainedRegressions = [];
  const dailyRegressionFailures = [];

  for (const row of rawDailyRegressions) {
    if (Math.abs(Number(row.totalSalesChangedEur || 0)) > 1) {
      sourceDataChangedRegressions.push(row);
      continue;
    }

    const dateChanges = changedOrders
      .filter((change) => change.date === row.date && Math.abs(change.profitDeltaEur) >= 1)
      .sort((left, right) => Math.abs(right.profitDeltaEur) - Math.abs(left.profitDeltaEur));
    const truthMatchedChanges = dateChanges.filter((change) => isCloseToOrderTruth(change, orderTruthMap));
    const explainedImpact = truthMatchedChanges.reduce((sum, change) => sum + Math.abs(change.profitDeltaEur), 0);
    const regressionImpact = Math.abs(Number(row.improvementEur || 0));

    if (truthMatchedChanges.length > 0 && explainedImpact >= regressionImpact * 0.8) {
      orderTruthExplainedRegressions.push({
        ...row,
        truthMatchedOrders: truthMatchedChanges.map((change) => ({
          orderId: change.orderId,
          proposedProfitEur: change.proposedProfitEur,
          profitDeltaEur: change.profitDeltaEur,
        })),
      });
      continue;
    }

    dailyRegressionFailures.push({
      ...row,
      changedOrders: dateChanges.slice(0, 10),
    });
  }

  const aggregateWithinTarget = Math.abs(aggregateImpact.proposedDeltaPct) <= 3;
  return {
    aggregateProfitDeltaTargetPct: 3,
    dailyRegressionTolerancePct: 5,
    aggregateWithinTarget,
    sourceDataChangedRegressions,
    orderTruthExplainedRegressions,
    dailyRegressionFailures,
    rolloutAllowed: aggregateWithinTarget && dailyRegressionFailures.length === 0,
  };
}

async function main() {
  const defaultTruthPath = path.join(__dirname, 'data/gto-daily-profit-screenshot-truth.json');
  const defaultOrderTruthPath = path.join(__dirname, 'data/gto-profit-screenshot-fixture.json');
  const truthPath = readArg('truth-json') || defaultTruthPath;
  const orderTruthPath = readArg('order-truth-json') || defaultOrderTruthPath;
  const dateFrom = readArg('from') || '2026-04-20';
  const dateTo = readArg('to') || '2026-05-19';
  const candidateOverride = readArg('candidate');
  const includeWhatIf = readFlag('what-if');
  const truthRows = loadTruthRows(truthPath, dateFrom, dateTo);
  const orderTruthRows = loadOrderTruthRows(orderTruthPath);
  if (truthRows.length === 0) throw new Error('No daily truth rows found for the selected date range');

  const orders = await prisma.reportingGtoOrder.findMany({
    where: {
      createdAt: {
        gte: new Date(`${truthRows[0].date}T00:00:00.000Z`),
        lt: new Date(`${truthRows[truthRows.length - 1].date}T23:59:59.999Z`),
      },
    },
    select: {
      orderId: true,
      createdAt: true,
      orderStatus: true,
      structureName: true,
      touristsCount: true,
      totalAmountEur: true,
      costAmountEur: true,
      profitEur: true,
      accountingClass: true,
      profitBasisUsed: true,
      costBasisUsed: true,
      hasIncompleteCoreCost: true,
    },
  }) as unknown as ReportingOrder[];

  const candidates: SliceCandidate[] = [
    { key: 'gto_ua_cnf', label: 'gto.ua / CNF', structureNames: ['gto.ua'], statuses: ['CNF'] },
    { key: 'all_structures_cnf', label: 'all structures / CNF', statuses: ['CNF'] },
    { key: 'gto_ua_empty_cnf', label: 'gto.ua + empty structure / CNF', structureNames: ['gto.ua', null], statuses: ['CNF'] },
    { key: 'gto_ua_online_cnf', label: 'gto.ua + online.gto.global / CNF', structureNames: ['gto.ua', 'online.gto.global'], statuses: ['CNF'] },
    { key: 'gto_ua_cnf_or_orq', label: 'gto.ua / CNF + ORQ', structureNames: ['gto.ua'], statuses: ['CNF', 'ORQ'] },
  ];

  const candidateSummaries = candidates
    .map((candidate) => summarizeCandidate(truthRows, orders, candidate))
    .sort((left, right) => {
      const leftScore = Math.abs(left.aggregate.paxDeltaPct) + Math.abs(left.aggregate.totalSalesDeltaPct);
      const rightScore = Math.abs(right.aggregate.paxDeltaPct) + Math.abs(right.aggregate.totalSalesDeltaPct);
      return leftScore - rightScore;
    });

  const selected = candidateOverride
    ? candidateSummaries.find((candidate) => candidate.key === candidateOverride)
    : candidateSummaries.find((candidate) => candidate.gatePassed) || candidateSummaries[0];
  if (!selected) {
    throw new Error(`Unknown candidate "${candidateOverride}". Supported: ${candidates.map((candidate) => candidate.key).join(', ')}`);
  }
  const selectedDefinition = candidates.find((candidate) => candidate.key === selected.key)!;
  let whatIf: any = null;

  if (includeWhatIf) {
    const preview = await previewGtoLookerOrders({
      mode: 'backfill',
      dateFrom,
      dateTo,
      triggeredBy: 'daily-profit-calibration',
    });
    const proposedOrders = preview.orderRows as ReportingOrder[];
    const proposedCandidateSummaries = candidates.map((candidate) => summarizeCandidate(truthRows, proposedOrders, candidate));
    const proposedSelected = summarizeCandidate(truthRows, proposedOrders, selectedDefinition);
    const profitDelta = proposedSelected.aggregate.reportingProfitEur - selected.aggregate.reportingProfitEur;
    const aggregateImpact = {
      currentProfitEur: selected.aggregate.reportingProfitEur,
      proposedProfitEur: proposedSelected.aggregate.reportingProfitEur,
      profitChangeEur: round2(profitDelta),
      truthProfitEur: selected.aggregate.truthProfitEur,
      currentDeltaEur: selected.aggregate.profitDeltaEur,
      currentDeltaPct: selected.aggregate.profitDeltaPct,
      proposedDeltaEur: proposedSelected.aggregate.profitDeltaEur,
      proposedDeltaPct: proposedSelected.aggregate.profitDeltaPct,
      totalAmountChangeEur: round2(proposedSelected.aggregate.reportingTotalSalesEur - selected.aggregate.reportingTotalSalesEur),
    };
    const dailyWhatIf = selectedDailyWhatIf(truthRows, orders, proposedOrders, selectedDefinition);
    const changedOrders = compareProfitRows(orders, proposedOrders, selectedDefinition, 1000);
    whatIf = {
      preview: {
        fetchedOrderRows: preview.fetchedOrderRows,
        fetchedUniqueOrderIds: preview.fetchedUniqueOrderIds,
        syncedOrderRows: preview.syncedOrderRows,
        syncedLineRows: preview.syncedLineRows,
        detailErrorRows: preview.detailErrorRows,
        warnings: preview.warnings,
      },
      selectedCandidateCurrent: {
        key: selected.key,
        label: selected.label,
        gatePassed: selected.gatePassed,
        aggregate: selected.aggregate,
      },
      selectedCandidateProposed: {
        key: proposedSelected.key,
        label: proposedSelected.label,
        gatePassed: proposedSelected.gatePassed,
        aggregate: proposedSelected.aggregate,
      },
      aggregateImpact,
      acceptance: buildWhatIfAcceptance(aggregateImpact, dailyWhatIf, changedOrders, orderTruthRows),
      candidates: candidateSummaries.map((current) => {
        const proposed = proposedCandidateSummaries.find((row) => row.key === current.key)!;
        return {
          key: current.key,
          label: current.label,
          gatePassedCurrent: current.gatePassed,
          gatePassedProposed: proposed.gatePassed,
          currentAggregate: current.aggregate,
          proposedAggregate: proposed.aggregate,
          profitChangeEur: round2(proposed.aggregate.reportingProfitEur - current.aggregate.reportingProfitEur),
          totalAmountChangeEur: round2(proposed.aggregate.reportingTotalSalesEur - current.aggregate.reportingTotalSalesEur),
        };
      }),
      selectedDaily: dailyWhatIf,
      topChangedOrders: changedOrders.slice(0, 100),
    };
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    truthPath,
    orderTruthPath,
    dateFrom,
    dateTo,
    gate: {
      paxTolerancePct: 2,
      totalSalesTolerancePct: 3,
      passed: selected.gatePassed,
      selectedCandidate: selected.key,
      selectedLabel: selected.label,
      selectedBy: candidateOverride ? 'override' : 'auto',
    },
    candidates: candidateSummaries.map((candidate) => ({
      key: candidate.key,
      label: candidate.label,
      gatePassed: candidate.gatePassed,
      aggregate: candidate.aggregate,
    })),
    selectedDaily: selected.daily,
    topProfitContributors: topContributors(truthRows, orders, selectedDefinition),
    whatIf,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
