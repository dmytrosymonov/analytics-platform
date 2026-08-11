import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  evaluateGtoLineDateRange,
  normalizeGtoOrderTemporalData,
} from '../services/gto-temporal-normalization.service';

type ReportingLine = {
  lineId: string;
  dateFrom: Date | null;
  dateTo: Date | null;
  hasInvalidDateRange: boolean;
};

type ReportingOrder = {
  orderId: bigint;
  createdAt: Date;
  dateStart: Date | null;
  dateEnd: Date | null;
  sourceDateStart: Date | null;
  sourceDateEnd: Date | null;
  dateStartSource: string | null;
  dateEndSource: string | null;
  dateQualityStatus: string | null;
  dateQualityFlags: Prisma.JsonValue | null;
  salesLeadDays: number | null;
  lines: ReportingLine[];
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readFlag(name: string) {
  return process.argv.includes(`--${name}`) || readArg(name) === 'true' || readArg(name) === '1';
}

function dateForFilter(value?: string) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function sameDate(left: Date | null, right: Date | null) {
  return (left?.getTime() || null) === (right?.getTime() || null);
}

function sameJsonArray(left: Prisma.JsonValue | null, right: string[]) {
  return JSON.stringify(left || []) === JSON.stringify(right);
}

function buildWhere(dateFrom?: string, dateTo?: string) {
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
  return where;
}

async function main() {
  const dateFrom = readArg('from');
  const dateTo = readArg('to');
  const apply = readFlag('apply');
  const dryRun = readFlag('dry-run') || !apply;
  const limit = Math.max(1, Number(readArg('limit') || 500));

  if (apply && readFlag('dry-run')) {
    throw new Error('Use either --dry-run or --apply, not both');
  }

  const where = buildWhere(dateFrom, dateTo);
  const run = apply
    ? await prisma.reportingGtoTemporalQualityRun.create({
      data: {
        status: 'running',
        createdAtFrom: dateForFilter(dateFrom),
        createdAtTo: dateForFilter(dateTo),
        triggeredBy: 'cli',
      },
    })
    : null;

  let cursor: bigint | undefined;
  let scannedOrders = 0;
  let normalizedOrders = 0;
  let invalidLineRows = 0;
  let unresolvedOrders = 0;
  let changedLineRows = 0;
  const examples: Array<Record<string, unknown>> = [];

  try {
    for (;;) {
      const orders = await prisma.reportingGtoOrder.findMany({
        where: cursor ? { ...where, orderId: { gt: cursor } } : where,
        orderBy: { orderId: 'asc' },
        take: limit,
        include: {
          lines: {
            select: {
              lineId: true,
              dateFrom: true,
              dateTo: true,
              hasInvalidDateRange: true,
            },
          },
        },
      }) as unknown as ReportingOrder[];

      if (!orders.length) break;

      for (const order of orders) {
        scannedOrders += 1;
        const temporal = normalizeGtoOrderTemporalData({
          // Historical reporting rows did not preserve orders_list separately. A valid
          // current date is retained; invalid legacy values fall through to line dates.
          orderDataDateStart: order.sourceDateStart || order.dateStart,
          orderDataDateEnd: order.sourceDateEnd || order.dateEnd,
          createdAt: order.createdAt,
          lines: order.lines.map((line) => ({ dateFrom: line.dateFrom, dateTo: line.dateTo })),
        });
        const orderChanged = !sameDate(order.dateStart, temporal.dateStart)
          || !sameDate(order.dateEnd, temporal.dateEnd)
          || !sameDate(order.sourceDateStart, temporal.sourceDateStart)
          || !sameDate(order.sourceDateEnd, temporal.sourceDateEnd)
          || order.dateStartSource !== temporal.dateStartSource
          || order.dateEndSource !== temporal.dateEndSource
          || order.dateQualityStatus !== temporal.dateQualityStatus
          || !sameJsonArray(order.dateQualityFlags, temporal.dateQualityFlags)
        || order.salesLeadDays !== temporal.salesLeadDays;
        const changedLines = order.lines.filter((line) => {
          return line.hasInvalidDateRange !== evaluateGtoLineDateRange({
            dateFrom: line.dateFrom,
            dateTo: line.dateTo,
          }).hasInvalidDateRange;
        });

        invalidLineRows += temporal.invalidServiceLines;
        if (!temporal.dateStart) unresolvedOrders += 1;
        if (orderChanged) normalizedOrders += 1;
        changedLineRows += changedLines.length;

        if (examples.length < 50 && (orderChanged || changedLines.length)) {
          examples.push({
            orderId: Number(order.orderId),
            previousDateStart: order.dateStart?.toISOString().slice(0, 10) || null,
            normalizedDateStart: temporal.dateStart?.toISOString().slice(0, 10) || null,
            dateStartSource: temporal.dateStartSource,
            salesLeadDays: temporal.salesLeadDays,
            invalidLineRows: temporal.invalidServiceLines,
          });
        }

        if (apply && (orderChanged || changedLines.length)) {
          await prisma.$transaction([
            ...(orderChanged ? [prisma.reportingGtoOrder.update({
              where: { orderId: order.orderId },
              data: {
                dateStart: temporal.dateStart,
                dateEnd: temporal.dateEnd,
                sourceDateStart: temporal.sourceDateStart,
                sourceDateEnd: temporal.sourceDateEnd,
                dateStartSource: temporal.dateStartSource,
                dateEndSource: temporal.dateEndSource,
                dateQualityStatus: temporal.dateQualityStatus,
                dateQualityFlags: temporal.dateQualityFlags,
                salesLeadDays: temporal.salesLeadDays,
              },
            })] : []),
            ...changedLines.map((line) => prisma.reportingGtoOrderLine.update({
              where: { lineId: line.lineId },
              data: {
                hasInvalidDateRange: evaluateGtoLineDateRange({
                  dateFrom: line.dateFrom,
                  dateTo: line.dateTo,
                }).hasInvalidDateRange,
              },
            })),
          ]);
        }
      }

      cursor = orders[orders.length - 1].orderId;
      if (orders.length < limit) break;
    }

    if (run) {
      await prisma.reportingGtoTemporalQualityRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
          scannedOrders,
          normalizedOrders,
          invalidLineRows,
          unresolvedOrders,
          warnings: { changedLineRows },
        },
      });
    }

    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: dryRun ? 'dry-run' : 'apply',
      filters: { createdAtFrom: dateFrom || null, createdAtTo: dateTo || null },
      scannedOrders,
      normalizedOrders,
      invalidLineRows,
      unresolvedOrders,
      changedLineRows,
      examples,
    }, null, 2));
  } catch (error) {
    if (run) {
      await prisma.reportingGtoTemporalQualityRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          scannedOrders,
          normalizedOrders,
          invalidLineRows,
          unresolvedOrders,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }
    throw error;
  }
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
