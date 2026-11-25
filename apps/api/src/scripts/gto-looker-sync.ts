import { syncGtoLookerOrders } from '../services/gto-looker-sync.service';
import { prisma } from '../lib/prisma';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main() {
  const mode = (readArg('mode') || 'manual') as
    | 'daily'
    | 'manual'
    | 'backfill'
    | 'recent_created_refresh'
    | 'updated_refresh'
    | 'future_start_catchup'
    | 'recent_month_catchup'
    | 'historical_2024_catchup'
    | 'existing_orders_refresh';
  let dateFrom = readArg('from');
  let dateTo = readArg('to');

  if (mode === 'existing_orders_refresh' && (!dateFrom || !dateTo)) {
    const coverage = await prisma.reportingGtoOrder.aggregate({
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    if (!coverage._min.createdAt || !coverage._max.createdAt) {
      throw new Error('Cannot refresh existing orders: reporting_gto_orders is empty');
    }
    dateFrom ||= coverage._min.createdAt.toISOString().slice(0, 10);
    dateTo ||= coverage._max.createdAt.toISOString().slice(0, 10);
  }

  if (!dateFrom || !dateTo) {
    throw new Error('Usage: tsx src/scripts/gto-looker-sync.ts --mode=<manual|backfill|recent_created_refresh|updated_refresh|future_start_catchup|recent_month_catchup|historical_2024_catchup|existing_orders_refresh> --from=YYYY-MM-DD --to=YYYY-MM-DD');
  }

  const result = await syncGtoLookerOrders({
    mode,
    dateFrom,
    dateTo,
    triggeredBy: 'cli',
  });

  console.log(JSON.stringify(result, null, 2));
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
