import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  calculateCanonicalProfit,
  CanonicalProfitLine,
  CostBasis,
  CURRENT_PROFIT_LOGIC_VERSION,
  ProfitBasis,
} from '../services/gto-looker-profit-engine';

type ReportingLine = {
  lineId: string;
  orderId: bigint;
  productGroup: string;
  rawType: string | null;
  serviceTypeName: string | null;
  status: string | null;
  currencyBuy: string | null;
  priceOriginal: unknown;
  priceEur: unknown;
  priceBuyOriginal: unknown;
  priceBuyEur: unknown;
};

type ReportingOrder = {
  orderId: bigint;
  createdAt: Date;
  orderStatus: string;
  structureName: string | null;
  totalAmountEur: unknown;
  costAmountEur: unknown;
  profitEur: unknown;
  profitPct: number | null;
  profitBasisUsed: string | null;
  costBasisUsed: string | null;
  hasIncompleteCoreCost: boolean;
  profitLogicVersion: number | null;
  touristsCount: number;
  lines: ReportingLine[];
};

type RecalculatedProfit = {
  costAmountEur: number;
  profitEur: number;
  profitPct: number;
  profitBasisUsed: ProfitBasis;
  costBasisUsed: CostBasis;
  hasIncompleteCoreCost: boolean;
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

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeStatus(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function toCanonicalProfitLine(line: ReportingLine): CanonicalProfitLine {
  return {
    productGroup: line.productGroup,
    rawType: line.rawType,
    serviceTypeName: line.serviceTypeName,
    status: line.status,
    priceOriginal: decimalToNumber(line.priceOriginal),
    priceBuyOriginal: decimalToNumber(line.priceBuyOriginal),
    priceBuyEur: round2(decimalToNumber(line.priceBuyEur)),
  };
}

function calculateProfit(order: ReportingOrder): RecalculatedProfit {
  const status = normalizeStatus(order.orderStatus);
  if (status !== 'CNF') {
    return {
      costAmountEur: 0,
      profitEur: 0,
      profitPct: 0,
      profitBasisUsed: 'zero_for_non_cnf',
      costBasisUsed: 'api_rate_direct',
      hasIncompleteCoreCost: false,
    };
  }

  const revenueEur = round2(decimalToNumber(order.totalAmountEur));
  const currentProfitBasis = String(order.profitBasisUsed || '');
  const currentCostBasis = String(order.costBasisUsed || '');

  const preserveCurrent = (): RecalculatedProfit => ({
    costAmountEur: round2(decimalToNumber(order.costAmountEur)),
    profitEur: round2(decimalToNumber(order.profitEur)),
    profitPct: Number(order.profitPct || 0),
    profitBasisUsed: (currentProfitBasis || 'raw_margin') as ProfitBasis,
    costBasisUsed: (currentCostBasis || 'api_rate_direct') as CostBasis,
    hasIncompleteCoreCost: Boolean(order.hasIncompleteCoreCost),
  });

  if (order.hasIncompleteCoreCost) {
    return {
      costAmountEur: round2(decimalToNumber(order.costAmountEur)),
      profitEur: round2(decimalToNumber(order.profitEur)),
      profitPct: Number(order.profitPct || 0),
      profitBasisUsed: 'discount_fallback',
      costBasisUsed: 'incomplete_core_fallback',
      hasIncompleteCoreCost: true,
    };
  }

  const isLegacyAmountDetailsBasis = currentCostBasis === 'amount_details_implied_fx'
    || currentProfitBasis === 'amount_details_net_basis';
  if (!isLegacyAmountDetailsBasis) {
    return preserveCurrent();
  }

  return calculateCanonicalProfit(order.orderStatus, revenueEur, order.lines.map(toCanonicalProfitLine));
}

function hasChanged(order: ReportingOrder, next: RecalculatedProfit) {
  return round2(decimalToNumber(order.costAmountEur)) !== next.costAmountEur
    || round2(decimalToNumber(order.profitEur)) !== next.profitEur
    || Number(order.profitPct || 0) !== next.profitPct
    || String(order.profitBasisUsed || '') !== next.profitBasisUsed
    || String(order.costBasisUsed || '') !== next.costBasisUsed
    || Boolean(order.hasIncompleteCoreCost) !== next.hasIncompleteCoreCost
    || Number(order.profitLogicVersion || 0) !== CURRENT_PROFIT_LOGIC_VERSION;
}

function buildWhere(dateFrom?: string, dateTo?: string, structure?: string) {
  const where: Prisma.ReportingGtoOrderWhereInput = {};
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(`${dateFrom}T00:00:00.000Z`);
    if (dateTo) {
      const end = new Date(`${dateTo}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      where.createdAt.lt = end;
    }
  }
  if (structure) {
    where.structureName = structure;
  }
  return where;
}

function aggregate(rows: Array<{ order: ReportingOrder; next: RecalculatedProfit }>) {
  const byDate = new Map<string, {
    orders: number;
    tourists: number;
    revenueEur: number;
    currentProfitEur: number;
    proposedProfitEur: number;
    changedOrders: number;
  }>();

  for (const row of rows) {
    const key = dateKey(row.order.createdAt);
    const acc = byDate.get(key) || {
      orders: 0,
      tourists: 0,
      revenueEur: 0,
      currentProfitEur: 0,
      proposedProfitEur: 0,
      changedOrders: 0,
    };
    if (normalizeStatus(row.order.orderStatus) === 'CNF') {
      acc.orders += 1;
      acc.tourists += Number(row.order.touristsCount || 0);
      acc.revenueEur += decimalToNumber(row.order.totalAmountEur);
      acc.currentProfitEur += decimalToNumber(row.order.profitEur);
      acc.proposedProfitEur += row.next.profitEur;
      if (hasChanged(row.order, row.next)) acc.changedOrders += 1;
    }
    byDate.set(key, acc);
  }

  return Array.from(byDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({
      date,
      orders: row.orders,
      tourists: row.tourists,
      revenueEur: round2(row.revenueEur),
      currentProfitEur: round2(row.currentProfitEur),
      proposedProfitEur: round2(row.proposedProfitEur),
      deltaEur: round2(row.proposedProfitEur - row.currentProfitEur),
      proposedProfitPerPax: row.tourists > 0 ? round2(row.proposedProfitEur / row.tourists) : 0,
      changedOrders: row.changedOrders,
    }));
}

async function updateOrder(orderId: bigint, next: RecalculatedProfit) {
  await prisma.reportingGtoOrder.update({
    where: { orderId },
    data: {
      costAmountEur: next.costAmountEur.toFixed(2),
      profitEur: next.profitEur.toFixed(2),
      profitPct: next.profitPct,
      profitBasisUsed: next.profitBasisUsed,
      costBasisUsed: next.costBasisUsed,
      hasIncompleteCoreCost: next.hasIncompleteCoreCost,
      profitLogicVersion: CURRENT_PROFIT_LOGIC_VERSION,
      profitRecalculatedAt: new Date(),
      syncedAt: new Date(),
    },
  });
}

async function main() {
  const dateFrom = readArg('from');
  const dateTo = readArg('to');
  const structure = readArg('structure');
  const apply = readFlag('apply');
  const dryRun = readFlag('dry-run') || !apply;
  const limit = Number(readArg('limit') || 500);
  const where = buildWhere(dateFrom, dateTo, structure);

  if (apply && readFlag('dry-run')) {
    throw new Error('Use either --dry-run or --apply, not both');
  }

  let cursor: bigint | undefined;
  let scannedOrders = 0;
  let changedOrders = 0;
  let appliedOrders = 0;
  const changedExamples: any[] = [];
  const aggregateRows: Array<{ order: ReportingOrder; next: RecalculatedProfit }> = [];

  for (;;) {
    const orders = await prisma.reportingGtoOrder.findMany({
      where: cursor ? { ...where, orderId: { gt: cursor } } : where,
      orderBy: { orderId: 'asc' },
      take: limit,
      include: {
        lines: {
          select: {
            lineId: true,
            orderId: true,
            productGroup: true,
            rawType: true,
            serviceTypeName: true,
            status: true,
            currencyBuy: true,
            priceOriginal: true,
            priceEur: true,
            priceBuyOriginal: true,
            priceBuyEur: true,
          },
        },
      },
    }) as unknown as ReportingOrder[];

    if (orders.length === 0) break;

    for (const order of orders) {
      scannedOrders += 1;
      const next = calculateProfit(order);
      const changed = hasChanged(order, next);
      aggregateRows.push({ order, next });

      if (changed) {
        changedOrders += 1;
        if (changedExamples.length < 50) {
          changedExamples.push({
            orderId: Number(order.orderId),
            date: dateKey(order.createdAt),
            status: order.orderStatus,
            currentCostAmountEur: round2(decimalToNumber(order.costAmountEur)),
            proposedCostAmountEur: next.costAmountEur,
            currentProfitEur: round2(decimalToNumber(order.profitEur)),
            proposedProfitEur: next.profitEur,
            deltaEur: round2(next.profitEur - decimalToNumber(order.profitEur)),
            currentProfitBasisUsed: order.profitBasisUsed,
            proposedProfitBasisUsed: next.profitBasisUsed,
            currentCostBasisUsed: order.costBasisUsed,
            proposedCostBasisUsed: next.costBasisUsed,
            hasIncompleteCoreCost: next.hasIncompleteCoreCost,
            currentProfitLogicVersion: order.profitLogicVersion,
            proposedProfitLogicVersion: CURRENT_PROFIT_LOGIC_VERSION,
          });
        }

        if (apply) {
          await updateOrder(order.orderId, next);
          appliedOrders += 1;
        }
      }
    }

    cursor = orders[orders.length - 1].orderId;
    if (orders.length < limit) break;
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'apply',
    filters: {
      createdAtFrom: dateFrom || null,
      createdAtTo: dateTo || null,
      structure: structure || null,
    },
    scannedOrders,
    changedOrders,
    appliedOrders,
    daily: aggregate(aggregateRows),
    changedExamples,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  });
